"""O celular como leitor de código de barras do computador (ADR-43).

O que não pode quebrar: o bipe chega ao computador UMA vez (nem zero, nem duas), só o
celular que aceitou o código bipa por ele, e um código velho não cai no carrinho de
surpresa. As corridas (dois celulares no mesmo código, dois reenvios do mesmo bipe, duas
abas retirando a mesma fila) rodam de verdade, em sessões separadas.
"""

import asyncio
import contextlib
import uuid
from datetime import timedelta

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text

from app.core.db import engine
from app.core.eventos import Assunto, central
from app.main import app
from app.modules.leitor.repository import LeitorRepository
from app.modules.leitor.service import (
    ALFABETO,
    FILA_MAXIMA,
    TETO_POR_COMPUTADOR,
    gerar_codigo,
    normalizar_codigo,
)

MENSAGEM_CODIGO = "Código não encontrado ou vencido. Gere outro no computador."


# ------------------------------------------------------------------ ajudantes


def _cliente() -> AsyncClient:
    """Cliente próprio: cada um tem a sua sessão no servidor — a corrida é de verdade."""
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test/api/v1")


async def _sql(sql: str, **params: object) -> list:
    async with engine.begin() as conn:
        resultado = await conn.execute(text(sql), params)
        return list(resultado.all()) if resultado.returns_rows else []


async def _criar(client: AsyncClient, auth: dict[str, str], **corpo: object) -> dict:
    r = await client.post("/leitor/pareamentos", headers=auth, json=corpo or None)
    assert r.status_code == 201, r.text
    return r.json()


async def _aceitar(client: AsyncClient, auth: dict[str, str], codigo: str):
    return await client.post("/leitor/pareamentos/aceitar", headers=auth, json={"codigo": codigo})


async def _parear(client: AsyncClient, auth_pc: dict[str, str], auth_cel: dict[str, str]) -> int:
    criado = await _criar(client, auth_pc)
    r = await _aceitar(client, auth_cel, criado["codigo"])
    assert r.status_code == 200, r.text
    return criado["id"]


async def _bipar(
    client: AsyncClient,
    auth: dict[str, str],
    pareamento_id: int,
    codigo: str = "7891234567895",
    chave: str | None = None,
):
    return await client.post(
        "/leitor/bipes",
        headers=auth,
        json={
            "client_uuid": chave or str(uuid.uuid4()),
            "pareamento_id": pareamento_id,
            "codigo": codigo,
        },
    )


async def _retirar(client: AsyncClient, auth: dict[str, str], pareamento_id: int):
    return await client.post(f"/leitor/pareamentos/{pareamento_id}/retirar", headers=auth)


async def _status(client: AsyncClient, auth: dict[str, str], pareamento_id: int) -> dict:
    r = await client.get(f"/leitor/pareamentos/{pareamento_id}", headers=auth)
    assert r.status_code == 200, r.text
    return r.json()


def _encontro(monkeypatch, metodo: str, *, depois: bool = False) -> list[str]:
    """Segura as duas requisições no mesmo ponto até as duas chegarem.

    Sem isto a "corrida" pode rodar em fila — a primeira termina antes de a segunda
    começar — e o teste passaria sem nunca passar pelo ramo que existe para a corrida. Com o
    encontro, as duas passam pelas conferências antes de qualquer uma gravar. Devolve a
    lista de quem chegou, para o teste conferir que o encontro aconteceu.
    """
    barreira = asyncio.Barrier(2)
    original = getattr(LeitorRepository, metodo)
    chegaram: list[str] = []

    async def com_encontro(self, *args, **kwargs):
        if depois:
            resultado = await original(self, *args, **kwargs)
        chegaram.append(metodo)
        await asyncio.wait_for(barreira.wait(), timeout=10)
        return resultado if depois else await original(self, *args, **kwargs)

    monkeypatch.setattr(LeitorRepository, metodo, com_encontro)
    return chegaram


async def _diario() -> list[tuple[str, str]]:
    """O que o dono lê no diário sobre o leitor: (ação, quem), na ordem."""
    return [
        (acao, quem)
        for acao, quem in await _sql(
            "SELECT acao, user_nome FROM audit_log WHERE entidade = 'leitor' ORDER BY id"
        )
    ]


async def _encher_fila(pareamento_id: int, quantos: int, *, idade_s: int = 0) -> None:
    await _sql(
        "INSERT INTO leitor_bipes (pareamento_id, client_uuid, codigo, criado_em) "
        "SELECT :p, gen_random_uuid(), 'COD' || n, now() - make_interval(secs => :idade) "
        "FROM generate_series(1, :n) AS n",
        p=pareamento_id,
        n=quantos,
        idade=idade_s,
    )


# ------------------------------------------------------------------ o código


def test_codigo_sorteado_so_usa_o_alfabeto_sem_letras_que_confundem() -> None:
    for _ in range(200):
        codigo = gerar_codigo()
        assert len(codigo) == 6
        assert set(codigo) <= set(ALFABETO)
    assert not set("01OI") & set(ALFABETO)


@pytest.mark.parametrize(
    ("digitado", "esperado"),
    [
        ("abc234", "ABC234"),
        (" ABC 234 ", "ABC234"),
        ("abc-234", "ABC234"),
        ("ABC23", None),
        ("ABC2345", None),
        ("ABC10I", None),  # 1, 0 e I não existem no alfabeto
        ("", None),
    ],
)
def test_normalizar_codigo(digitado: str, esperado: str | None) -> None:
    assert normalizar_codigo(digitado) == esperado


# ------------------------------------------------------------------ o caminho todo


async def test_parear_bipar_e_retirar_entrega_uma_vez(
    client, admin, vendedor, auth_admin, auth_vendedor, auth_gerente
) -> None:
    criado = await _criar(client, auth_admin)
    assert criado["status"] == "AGUARDANDO"
    assert criado["computador_nome"] == admin.name
    assert criado["aparelho_nome"] is None
    assert normalizar_codigo(criado["codigo"]) == criado["codigo"]

    # Digitado do jeito da pessoa: minúsculo e com hífen.
    digitado = f"{criado['codigo'][:3].lower()}-{criado['codigo'][3:].lower()}"
    aceito = await _aceitar(client, auth_vendedor, digitado)
    assert aceito.status_code == 200, aceito.text
    corpo = aceito.json()
    assert corpo["status"] == "ATIVO"
    assert corpo["aparelho_nome"] == vendedor.name
    assert corpo["computador_nome"] == admin.name

    pid = criado["id"]
    bipe = await _bipar(client, auth_vendedor, pid, " 7891234567895 ")
    assert bipe.status_code == 201, bipe.text
    assert bipe.json()["codigo"] == "7891234567895"
    assert bipe.json()["pareamento_id"] == pid
    assert bipe.json()["criado_em"]

    retirada = await _retirar(client, auth_admin, pid)
    assert retirada.status_code == 200, retirada.text
    assert [i["codigo"] for i in retirada.json()["items"]] == ["7891234567895"]
    assert retirada.json()["descartados"] == 0
    assert retirada.json()["pareamento"]["status"] == "ATIVO"

    de_novo = (await _retirar(client, auth_admin, pid)).json()
    assert de_novo["items"] == [] and de_novo["descartados"] == 0, "entregou duas vezes"

    # As duas pontas veem o pareamento; mais ninguém.
    assert (await _status(client, auth_vendedor, pid))["status"] == "ATIVO"
    r = await client.get(f"/leitor/pareamentos/{pid}", headers=auth_gerente)
    assert r.status_code == 404 and r.json()["code"] == "NAO_ENCONTRADO"


async def test_prazos_do_codigo_e_do_pareamento(client, auth_admin, auth_vendedor) -> None:
    criado = await _criar(client, auth_admin)
    (criado_em, codigo_expira_em) = (await _sql(
        "SELECT criado_em, codigo_expira_em FROM leitor_pareamentos WHERE id = :id",
        id=criado["id"],
    ))[0]
    assert codigo_expira_em - criado_em == timedelta(minutes=5)

    await _aceitar(client, auth_vendedor, criado["codigo"])
    (aceito_em, expira_em) = (await _sql(
        "SELECT aceito_em, expira_em FROM leitor_pareamentos WHERE id = :id", id=criado["id"]
    ))[0]
    assert expira_em - aceito_em == timedelta(hours=12)

    # Usar o leitor não estica o prazo.
    await _bipar(client, auth_vendedor, criado["id"])
    (expira_depois,) = (await _sql(
        "SELECT expira_em FROM leitor_pareamentos WHERE id = :id", id=criado["id"]
    ))[0]
    assert expira_depois == expira_em


# ------------------------------------------------------------------ o aceite


async def test_codigo_ja_aceito_inexistente_ou_torto_tem_a_mesma_resposta(
    client, auth_admin, auth_vendedor, auth_gerente
) -> None:
    criado = await _criar(client, auth_admin)
    assert (await _aceitar(client, auth_vendedor, criado["codigo"])).status_code == 200

    respostas = [
        await _aceitar(client, auth_gerente, criado["codigo"]),  # já aceito por outro
        await _aceitar(client, auth_gerente, "ZZZZZZ"),  # não existe
        await _aceitar(client, auth_gerente, "123"),  # nem é código
    ]
    for r in respostas:
        assert r.status_code == 404
        assert r.json() == {
            "code": "LEITOR_CODIGO_INVALIDO",
            "message": MENSAGEM_CODIGO,
            "detail": {},
        }


async def test_codigo_vencido_tem_a_mesma_resposta(client, auth_admin, auth_vendedor) -> None:
    criado = await _criar(client, auth_admin)
    await _sql(
        "UPDATE leitor_pareamentos SET codigo_expira_em = now() - interval '1 second' "
        "WHERE id = :id",
        id=criado["id"],
    )
    assert (await _status(client, auth_admin, criado["id"]))["status"] == "EXPIRADO"

    r = await _aceitar(client, auth_vendedor, criado["codigo"])
    assert r.status_code == 404
    assert r.json()["code"] == "LEITOR_CODIGO_INVALIDO"
    assert r.json()["message"] == MENSAGEM_CODIGO


async def test_codigo_encerrado_nao_aceita(client, auth_admin, auth_vendedor) -> None:
    criado = await _criar(client, auth_admin)
    assert (
        await client.delete(f"/leitor/pareamentos/{criado['id']}", headers=auth_admin)
    ).status_code == 204
    r = await _aceitar(client, auth_vendedor, criado["codigo"])
    assert r.status_code == 404 and r.json()["code"] == "LEITOR_CODIGO_INVALIDO"


async def test_dois_celulares_ao_mesmo_tempo_no_mesmo_codigo_so_um_ganha(
    client, vendedor, gerente, auth_admin, auth_vendedor, auth_gerente, monkeypatch
) -> None:
    criado = await _criar(client, auth_admin)
    # As duas chegam juntas ao SELECT ... FOR UPDATE da linha do código.
    chegaram = _encontro(monkeypatch, "aguardando_por_codigo")

    async def aceitar(auth: dict[str, str]) -> int:
        async with _cliente() as c:
            return (await _aceitar(c, auth, criado["codigo"])).status_code

    resultados = await asyncio.gather(aceitar(auth_vendedor), aceitar(auth_gerente))
    assert len(chegaram) == 2
    assert sorted(resultados) == [200, 404]

    (aparelho,) = (await _sql(
        "SELECT aparelho_user_id FROM leitor_pareamentos WHERE id = :id", id=criado["id"]
    ))[0]
    vencedor = vendedor.id if resultados[0] == 200 else gerente.id
    assert aparelho == vencedor


async def test_aceitar_outro_computador_desliga_o_anterior(
    client, auth_admin, auth_gerente, auth_vendedor
) -> None:
    """Um celular, um computador: o que ele lia antes para de receber (TROCOU)."""
    primeiro = await _parear(client, auth_admin, auth_vendedor)
    segundo = await _parear(client, auth_gerente, auth_vendedor)

    antes = await _status(client, auth_admin, primeiro)
    assert antes["status"] == "ENCERRADO"
    assert antes["motivo_encerramento"] == "TROCOU"
    assert (await _status(client, auth_gerente, segundo))["status"] == "ATIVO"

    r = await _bipar(client, auth_vendedor, primeiro)
    assert r.status_code == 409
    assert r.json()["detail"] == {"status": "ENCERRADO"}
    assert (await _bipar(client, auth_vendedor, segundo)).status_code == 201


async def test_o_mesmo_celular_aceitando_dois_codigos_ao_mesmo_tempo_fica_com_um(
    client, auth_admin, auth_gerente, auth_vendedor, monkeypatch
) -> None:
    """Um celular, um computador também na corrida: o mesmo login aceitando dois códigos
    juntos (dois aparelhos com a mesma conta, ou o toque duplo) termina com UM ativo.

    Quem garante é a trava por celular (`travar_aparelho`). Sem ela os dois aceites leem os
    ativos do celular antes de qualquer um gravar, nenhum vê o outro, e o celular fica
    ligado em dois computadores. O encontro abaixo segura cada aceite logo depois dessa
    leitura até o outro chegar — com prazo, porque COM a trava o segundo só chega lá
    depois do commit do primeiro.
    """
    do_admin = await _criar(client, auth_admin)
    do_gerente = await _criar(client, auth_gerente)

    original = LeitorRepository.ativos_do_aparelho
    chegaram: list[int] = []
    os_dois = asyncio.Event()

    async def com_encontro(self, *args, **kwargs):
        resultado = await original(self, *args, **kwargs)
        chegaram.append(len(resultado))
        if len(chegaram) == 2:
            os_dois.set()
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(os_dois.wait(), timeout=1.5)
        return resultado

    monkeypatch.setattr(LeitorRepository, "ativos_do_aparelho", com_encontro)

    async def aceitar(codigo: str) -> int:
        async with _cliente() as c:
            return (await _aceitar(c, auth_vendedor, codigo)).status_code

    resultados = await asyncio.gather(aceitar(do_admin["codigo"]), aceitar(do_gerente["codigo"]))
    assert resultados == [200, 200]
    assert len(chegaram) == 2
    # O segundo aceite viu o primeiro ativo — e o encerrou.
    assert sorted(chegaram) == [0, 1]

    situacoes = [
        await _status(client, auth_admin, do_admin["id"]),
        await _status(client, auth_gerente, do_gerente["id"]),
    ]
    assert sorted(s["status"] for s in situacoes) == ["ATIVO", "ENCERRADO"]
    (encerrado,) = [s for s in situacoes if s["status"] == "ENCERRADO"]
    assert encerrado["motivo_encerramento"] == "TROCOU"


async def test_reenvio_do_aceite_pelo_mesmo_celular_devolve_o_mesmo(
    client, auth_admin, auth_vendedor, auth_gerente
) -> None:
    """A resposta do aceite se perdeu (Wi-Fi fraco, partida a frio): o celular manda de novo
    o MESMO código e recebe o pareamento que ele mesmo ligou. Sem isto, só desligando no
    computador e gerando outro código. Para qualquer outra pessoa nada muda: o 404 de sempre.
    """
    criado = await _criar(client, auth_admin)
    primeiro = await _aceitar(client, auth_vendedor, criado["codigo"])
    assert primeiro.status_code == 200

    codigo = criado["codigo"]
    de_novo = await _aceitar(client, auth_vendedor, f"{codigo[:3]}-{codigo[3:]}".lower())
    assert de_novo.status_code == 200
    assert de_novo.json() == primeiro.json()

    outro = await _aceitar(client, auth_gerente, criado["codigo"])
    assert outro.status_code == 404
    assert outro.json()["message"] == MENSAGEM_CODIGO

    # O reenvio não é um segundo "Ligou" no diário: nada mudou.
    assert await _diario() == [("LEITOR_PAREADO", "Ana Vendedora")]

    # Só dentro dos 5 min do código: depois, nem para quem aceitou.
    await _sql(
        "UPDATE leitor_pareamentos SET codigo_expira_em = now() - interval '1 second' "
        "WHERE id = :id",
        id=criado["id"],
    )
    vencido = await _aceitar(client, auth_vendedor, criado["codigo"])
    assert vencido.status_code == 404 and vencido.json()["message"] == MENSAGEM_CODIGO


async def test_reenvio_do_aceite_depois_de_desligado_e_404(
    client, auth_admin, auth_vendedor
) -> None:
    criado = await _criar(client, auth_admin)
    assert (await _aceitar(client, auth_vendedor, criado["codigo"])).status_code == 200
    assert (
        await client.delete(f"/leitor/pareamentos/{criado['id']}", headers=auth_admin)
    ).status_code == 204
    r = await _aceitar(client, auth_vendedor, criado["codigo"])
    assert r.status_code == 404 and r.json()["code"] == "LEITOR_CODIGO_INVALIDO"


async def test_um_celular_nao_desliga_o_outro(
    client, auth_admin, auth_gerente, auth_vendedor, auth_supervisora
) -> None:
    """O TROCOU é do MESMO celular. Duas vendedoras pareando no mesmo computador por
    turnos não derrubam uma à outra por isso — cada pareamento é um código."""
    do_vendedor = await _parear(client, auth_admin, auth_vendedor)
    da_supervisora = await _parear(client, auth_gerente, auth_supervisora)
    assert (await _status(client, auth_admin, do_vendedor))["status"] == "ATIVO"
    assert (await _status(client, auth_gerente, da_supervisora))["status"] == "ATIVO"


# ------------------------------------------------------------------ o bipe


async def test_so_o_celular_que_aceitou_bipa(
    client, auth_admin, auth_vendedor, auth_gerente
) -> None:
    pid = await _parear(client, auth_admin, auth_vendedor)
    for auth in (auth_gerente, auth_admin):
        r = await _bipar(client, auth, pid)
        assert r.status_code == 404 and r.json()["code"] == "NAO_ENCONTRADO"
    r = await _bipar(client, auth_vendedor, 999_999)
    assert r.status_code == 404 and r.json()["code"] == "NAO_ENCONTRADO"

    # Pareamento ainda AGUARDANDO não tem celular: ninguém bipa por ele.
    aguardando = await _criar(client, auth_admin)
    assert (await _bipar(client, auth_vendedor, aguardando["id"])).status_code == 404


async def test_reenvio_do_mesmo_bipe_devolve_o_mesmo(client, auth_admin, auth_vendedor) -> None:
    pid = await _parear(client, auth_admin, auth_vendedor)
    chave = str(uuid.uuid4())
    primeiro = await _bipar(client, auth_vendedor, pid, "ABC", chave)
    segundo = await _bipar(client, auth_vendedor, pid, "ABC", chave)
    assert primeiro.status_code == 201
    assert segundo.status_code == 200
    assert segundo.json() == primeiro.json()

    retirada = (await _retirar(client, auth_admin, pid)).json()
    assert [i["codigo"] for i in retirada["items"]] == ["ABC"], "o reenvio virou dois bipes"


async def test_mesma_chave_com_outro_pedido_e_409(
    client, auth_admin, auth_vendedor, auth_gerente
) -> None:
    pid = await _parear(client, auth_admin, auth_vendedor)
    outro = await _parear(client, auth_gerente, auth_vendedor)  # o primeiro vira TROCOU
    chave = str(uuid.uuid4())
    assert (await _bipar(client, auth_vendedor, outro, "ABC", chave)).status_code == 201

    outro_codigo = await _bipar(client, auth_vendedor, outro, "XYZ", chave)
    assert outro_codigo.status_code == 409 and outro_codigo.json()["code"] == "DUPLICADO"
    outro_pareamento = await _bipar(client, auth_vendedor, pid, "ABC", chave)
    assert outro_pareamento.status_code == 409 and outro_pareamento.json()["code"] == "DUPLICADO"
    # A chave de um celular não vira porta de leitura para outro, nem com o pedido idêntico.
    alheio = await _bipar(client, auth_gerente, outro, "ABC", chave)
    assert alheio.status_code == 409 and alheio.json()["detail"] == {}


async def test_mesmo_bipe_em_duas_requisicoes_ao_mesmo_tempo_grava_um(
    client, auth_admin, auth_vendedor, monkeypatch
) -> None:
    pid = await _parear(client, auth_admin, auth_vendedor)
    chave = str(uuid.uuid4())
    # As duas já conferiram a chave (nenhuma achou nada) quando a primeira grava: a segunda
    # cai no UNIQUE, desfaz e devolve a da primeira.
    chegaram = _encontro(monkeypatch, "pendentes", depois=True)

    async def bipar():
        async with _cliente() as c:
            return await _bipar(c, auth_vendedor, pid, "7891234567895", chave)

    respostas = await asyncio.gather(bipar(), bipar())
    assert len(chegaram) == 2
    assert sorted(r.status_code for r in respostas) == [200, 201]
    assert respostas[0].json() == respostas[1].json()
    (quantos,) = (await _sql(
        "SELECT count(*) FROM leitor_bipes WHERE client_uuid = :c", c=uuid.UUID(chave)
    ))[0]
    assert quantos == 1


@pytest.mark.parametrize("codigo", ["", "   ", "789\t123", "78\n9", "\x1b789", "9" * 65])
async def test_codigo_lido_invalido_e_422(client, auth_admin, auth_vendedor, codigo: str) -> None:
    pid = await _parear(client, auth_admin, auth_vendedor)
    r = await _bipar(client, auth_vendedor, pid, codigo)
    assert r.status_code == 422, r.text


async def test_fila_cheia_recusa_ate_o_computador_retirar(
    client, auth_admin, auth_vendedor
) -> None:
    pid = await _parear(client, auth_admin, auth_vendedor)
    await _encher_fila(pid, FILA_MAXIMA)

    r = await _bipar(client, auth_vendedor, pid)
    assert r.status_code == 409 and r.json()["code"] == "LEITOR_FILA_CHEIA"

    assert len((await _retirar(client, auth_admin, pid)).json()["items"]) == 50
    assert (await _bipar(client, auth_vendedor, pid)).status_code == 201


# ------------------------------------------------------------------ a retirada


async def test_so_o_computador_retira(client, auth_admin, auth_vendedor, auth_gerente) -> None:
    pid = await _parear(client, auth_admin, auth_vendedor)
    await _bipar(client, auth_vendedor, pid)
    for auth in (auth_vendedor, auth_gerente):
        r = await _retirar(client, auth, pid)
        assert r.status_code == 404 and r.json()["code"] == "NAO_ENCONTRADO"
    assert len((await _retirar(client, auth_admin, pid)).json()["items"]) == 1


async def test_duas_retiradas_ao_mesmo_tempo_nunca_entregam_o_mesmo_bipe(
    client, auth_admin, auth_vendedor, monkeypatch
) -> None:
    """Duas abas do mesmo computador retirando juntas: lotes disjuntos, nada some."""
    pid = await _parear(client, auth_admin, auth_vendedor)
    await _encher_fila(pid, 80)
    linhas = await _sql("SELECT id FROM leitor_bipes WHERE pareamento_id = :p", p=pid)
    todos = {i for (i,) in linhas}

    async def retirar() -> list[int]:
        async with _cliente() as c:
            r = await _retirar(c, auth_admin, pid)
            assert r.status_code == 200, r.text
            return [i["id"] for i in r.json()["items"]]

    chegaram = _encontro(monkeypatch, "consumir")  # as duas entram juntas no UPDATE
    a, b = await asyncio.gather(retirar(), retirar())
    monkeypatch.undo()  # a retirada que esvazia o resto vem sozinha, sem par no encontro
    assert len(chegaram) == 2
    assert len(a) <= 50 and len(b) <= 50
    # O SKIP LOCKED pula o que a outra travou em vez de esperar: as duas saem com lote.
    assert len(a) + len(b) == 80
    assert a == sorted(a) and b == sorted(b), "a ordem é a da leitura"
    assert not set(a) & set(b), "o mesmo bipe saiu nas duas abas"
    resto = [i["id"] for i in (await _retirar(client, auth_admin, pid)).json()["items"]]
    assert not (set(a) | set(b)) & set(resto)
    assert set(a) | set(b) | set(resto) == todos


async def test_bipe_velho_e_descartado_e_nao_entregue(client, auth_admin, auth_vendedor) -> None:
    pid = await _parear(client, auth_admin, auth_vendedor)
    await _bipar(client, auth_vendedor, pid, "VELHO")
    await _bipar(client, auth_vendedor, pid, "NOVO")
    await _sql(
        "UPDATE leitor_bipes SET criado_em = now() - interval '121 seconds' WHERE codigo = 'VELHO'"
    )

    retirada = (await _retirar(client, auth_admin, pid)).json()
    assert [i["codigo"] for i in retirada["items"]] == ["NOVO"]
    assert retirada["descartados"] == 1
    # Descartado é consumido: não volta na próxima.
    assert (await _retirar(client, auth_admin, pid)).json()["descartados"] == 0


# ------------------------------------------------------------------ desligar e vencer


@pytest.mark.parametrize(("quem", "motivo"), [("computador", "COMPUTADOR"), ("celular", "CELULAR")])
async def test_desligar_de_qualquer_ponta(
    client, auth_admin, auth_vendedor, auth_gerente, quem: str, motivo: str
) -> None:
    pid = await _parear(client, auth_admin, auth_vendedor)
    await _bipar(client, auth_vendedor, pid)  # fica na fila

    r = await client.delete(f"/leitor/pareamentos/{pid}", headers=auth_gerente)
    assert r.status_code == 404, "terceiro não desliga o leitor dos outros"

    auth = auth_admin if quem == "computador" else auth_vendedor
    assert (await client.delete(f"/leitor/pareamentos/{pid}", headers=auth)).status_code == 204
    situacao = await _status(client, auth_admin, pid)
    assert situacao["status"] == "ENCERRADO"
    assert situacao["motivo_encerramento"] == motivo
    assert situacao["encerrado_em"]

    r = await _bipar(client, auth_vendedor, pid)
    assert r.status_code == 409
    assert r.json()["code"] == "LEITOR_DESLIGADO"
    assert r.json()["detail"] == {"status": "ENCERRADO"}

    # O que estava na fila não cai mais no computador.
    retirada = (await _retirar(client, auth_admin, pid)).json()
    assert retirada["items"] == [] and retirada["descartados"] == 1
    assert retirada["pareamento"]["status"] == "ENCERRADO"

    # Desligar de novo não muda o motivo — nem vira um segundo "Desligou" no diário, no nome
    # de quem não desligou nada (a outra ponta saindo do sistema depois).
    outra_ponta = auth_vendedor if quem == "computador" else auth_admin
    assert (
        await client.delete(f"/leitor/pareamentos/{pid}", headers=outra_ponta)
    ).status_code == 204
    assert (await _status(client, auth_admin, pid))["motivo_encerramento"] == motivo
    assert await _diario() == [
        ("LEITOR_PAREADO", "Ana Vendedora"),
        ("LEITOR_DESLIGADO", "Dona Maria" if quem == "computador" else "Ana Vendedora"),
    ]


async def test_desligar_sem_efeito_nao_entra_no_diario(client, auth_admin, auth_vendedor) -> None:
    """O diário conta o que aconteceu. O DELETE que não desliga celular nenhum responde 204
    (as duas pontas saem sem erro) mas não vira "Desligou o celular-leitor" no nome de quem
    só estava saindo do sistema."""
    # O código que ninguém leu: a pessoa abriu o QR e saiu do sistema. Não havia celular.
    criado = await _criar(client, auth_admin)
    r = await client.delete(f"/leitor/pareamentos/{criado['id']}", headers=auth_admin)
    assert r.status_code == 204
    assert (await _status(client, auth_admin, criado["id"]))["status"] == "ENCERRADO"

    # Vencido nas 12 h: a vendedora sai do app no dia seguinte.
    vencido = await _parear(client, auth_admin, auth_vendedor)
    await _sql(
        "UPDATE leitor_pareamentos SET expira_em = now() - interval '1 second' WHERE id = :id",
        id=vencido,
    )
    r = await client.delete(f"/leitor/pareamentos/{vencido}", headers=auth_vendedor)
    assert r.status_code == 204

    # Já desligado no computador; o app não ficou sabendo e desliga de novo na saída.
    desligado = await _parear(client, auth_admin, auth_vendedor)
    assert (
        await client.delete(f"/leitor/pareamentos/{desligado}", headers=auth_admin)
    ).status_code == 204
    r = await client.delete(f"/leitor/pareamentos/{desligado}", headers=auth_vendedor)
    assert r.status_code == 204

    assert await _diario() == [
        ("LEITOR_PAREADO", "Ana Vendedora"),
        ("LEITOR_PAREADO", "Ana Vendedora"),
        ("LEITOR_DESLIGADO", "Dona Maria"),
    ]


async def test_doze_horas_depois_o_leitor_vence(client, auth_admin, auth_vendedor) -> None:
    pid = await _parear(client, auth_admin, auth_vendedor)
    await _sql(
        "UPDATE leitor_pareamentos SET expira_em = now() - interval '1 second' WHERE id = :id",
        id=pid,
    )
    assert (await _status(client, auth_vendedor, pid))["status"] == "EXPIRADO"

    r = await _bipar(client, auth_vendedor, pid)
    assert r.status_code == 409
    assert r.json()["code"] == "LEITOR_DESLIGADO"
    assert r.json()["detail"] == {"status": "EXPIRADO"}

    # Vencido não vira encerrado ao desligar: 204 e nada muda.
    desligar = await client.delete(f"/leitor/pareamentos/{pid}", headers=auth_admin)
    assert desligar.status_code == 204
    situacao = await _status(client, auth_admin, pid)
    assert situacao["status"] == "EXPIRADO" and situacao["encerrado_em"] is None


# ------------------------------------------------------------------ código novo


async def test_codigo_novo_substitui_o_antigo(
    client, auth_admin, auth_gerente, auth_vendedor
) -> None:
    antigo = await _criar(client, auth_admin)
    do_gerente = await _criar(client, auth_gerente)
    novo = await _criar(client, auth_admin, substitui_id=antigo["id"])
    assert novo["status"] == "AGUARDANDO" and novo["id"] != antigo["id"]

    situacao = await _status(client, auth_admin, antigo["id"])
    assert situacao["status"] == "ENCERRADO"
    assert situacao["motivo_encerramento"] == "SUBSTITUIDO"
    r = await _aceitar(client, auth_vendedor, antigo["codigo"])
    assert r.status_code == 404, "o código que saiu da tela ainda abria o leitor"

    # O de outra pessoa não é substituível por mim: ignorado, não recusado.
    await _criar(client, auth_admin, substitui_id=do_gerente["id"])
    assert (await _status(client, auth_gerente, do_gerente["id"]))["status"] == "AGUARDANDO"


async def test_codigo_sorteado_repetido_sorteia_outro_sem_perder_o_resto(
    client, auth_admin, auth_gerente, monkeypatch
) -> None:
    """Colisão com um código ainda AGUARDANDO (de outro computador): o savepoint desfaz só a
    tentativa — o encerramento do substituído, feito antes na mesma transação, continua."""
    from app.modules.leitor import service

    sorteios = iter(["AAAAAA", "CCCCCC", "AAAAAA", "BBBBBB"])
    monkeypatch.setattr(service, "gerar_codigo", lambda: next(sorteios))

    do_gerente = await _criar(client, auth_gerente)
    antigo = await _criar(client, auth_admin)
    assert (do_gerente["codigo"], antigo["codigo"]) == ("AAAAAA", "CCCCCC")

    novo = await _criar(client, auth_admin, substitui_id=antigo["id"])
    assert novo["codigo"] == "BBBBBB", "o sorteio repetido não foi trocado"
    situacao = await _status(client, auth_admin, antigo["id"])
    assert situacao["motivo_encerramento"] == "SUBSTITUIDO", "o savepoint levou o encerramento"
    assert (await _status(client, auth_gerente, do_gerente["id"]))["status"] == "AGUARDANDO"

    # Código encerrado sai do UNIQUE parcial: pode ser sorteado de novo.
    monkeypatch.setattr(service, "gerar_codigo", lambda: "CCCCCC")
    assert (await _criar(client, auth_admin))["codigo"] == "CCCCCC"


async def test_sem_login_nao_pareia(client) -> None:
    assert (await client.post("/leitor/pareamentos")).status_code == 401
    r = await client.post("/leitor/pareamentos/aceitar", json={"codigo": "ABC234"})
    assert r.status_code == 401


async def test_teto_de_codigos_abertos_por_pessoa(client, auth_admin) -> None:
    criados = [await _criar(client, auth_admin) for _ in range(TETO_POR_COMPUTADOR + 2)]
    vivos = [
        c["id"]
        for c in criados
        if (await _status(client, auth_admin, c["id"]))["status"] == "AGUARDANDO"
    ]
    assert vivos == [c["id"] for c in criados[-TETO_POR_COMPUTADOR:]]
    for velho in criados[:2]:
        situacao = await _status(client, auth_admin, velho["id"])
        assert situacao["motivo_encerramento"] == "SUBSTITUIDO"


async def test_faxina_apaga_o_que_ja_nao_serve(client, admin, auth_admin, auth_vendedor) -> None:
    velho = await _parear(client, auth_admin, auth_vendedor)
    recente = await _parear(client, auth_admin, auth_vendedor)  # o velho vira TROCOU
    await _bipar(client, auth_vendedor, recente, "ONTEM")
    await _bipar(client, auth_vendedor, recente, "AGORA")
    await _sql(
        "UPDATE leitor_pareamentos SET encerrado_em = now() - interval '31 days' WHERE id = :id",
        id=velho,
    )
    await _sql(
        "UPDATE leitor_bipes SET criado_em = now() - interval '25 hours' WHERE codigo = 'ONTEM'"
    )

    await _criar(client, auth_admin)

    ids = {i for (i,) in await _sql("SELECT id FROM leitor_pareamentos")}
    assert velho not in ids and recente in ids
    codigos = {c for (c,) in await _sql("SELECT codigo FROM leitor_bipes")}
    assert codigos == {"AGORA"}


async def test_excluir_a_conta_de_quem_pareou_nao_trava(
    client, vendedor, auth_admin, auth_vendedor
) -> None:
    """Pareamento não é histórico da loja: a exclusão da conta (LGPD) leva junto."""
    pid = await _parear(client, auth_admin, auth_vendedor)
    await _bipar(client, auth_vendedor, pid)
    r = await client.delete(f"/usuarios/{vendedor.id}", headers=auth_admin)
    assert r.status_code == 204, r.text
    assert await _sql("SELECT id FROM leitor_pareamentos WHERE id = :id", id=pid) == []


# ------------------------------------------------------------------ tempo real e diário


async def test_tempo_real_avisa_pareamento_e_bipe_mas_nao_a_retirada(
    client, auth_admin, auth_vendedor
) -> None:
    def drenar(fila) -> list:
        eventos = []
        while not fila.empty():
            eventos.append(fila.get_nowait())
        return eventos

    async with central.inscrever() as fila:
        criado = await _criar(client, auth_admin)
        assert Assunto.LEITOR in {e.assunto for e in drenar(fila)}

        await _aceitar(client, auth_vendedor, criado["codigo"])
        assert {e.assunto for e in drenar(fila)} == {Assunto.LEITOR}

        await _bipar(client, auth_vendedor, criado["id"], "7891234567895")
        eventos = drenar(fila)
        assert {e.assunto for e in eventos} == {Assunto.LEITOR}
        # Só o assunto: o código lido nunca vai no aviso.
        assert all("7891234567895" not in str(e.como_json()) for e in eventos)

        retirada = await _retirar(client, auth_admin, criado["id"])
        assert len(retirada.json()["items"]) == 1
        assert drenar(fila) == [], "a retirada avisou — cada tela retiraria de novo, em eco"

        await client.delete(f"/leitor/pareamentos/{criado['id']}", headers=auth_admin)
        assert {e.assunto for e in drenar(fila)} == {Assunto.LEITOR}


async def test_diario_registra_ligar_e_desligar_e_so(client, auth_admin, auth_vendedor) -> None:
    async def linhas() -> list[tuple[str, str]]:
        return [
            (acao, descricao)
            for acao, descricao in await _sql(
                "SELECT acao, descricao FROM audit_log WHERE acao NOT LIKE 'LOGIN%' ORDER BY id"
            )
        ]

    criado = await _criar(client, auth_admin)
    assert await linhas() == [], "gerar o código entrou no diário"

    await _aceitar(client, auth_vendedor, criado["codigo"])
    pid = criado["id"]
    await _bipar(client, auth_vendedor, pid)
    await _retirar(client, auth_admin, pid)
    await client.delete(f"/leitor/pareamentos/{pid}", headers=auth_vendedor)

    assert await linhas() == [
        ("LEITOR_PAREADO", "Ligou o celular como leitor de código de barras de um computador"),
        ("LEITOR_DESLIGADO", f"Desligou o celular-leitor #{pid}"),
    ]
