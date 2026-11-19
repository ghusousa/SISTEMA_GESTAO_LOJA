"""O computador chama o celular do mesmo login (ADR-47): o leitor por chamado.

O que não pode quebrar: só o MESMO login atende, e só pelo id do chamado (sem código — o
código sorteado nunca sai e nunca abre o aceite por código); cada aba tem o seu chamado e o
seu sinal; o reenvio vale só para a MESMA instalação do app, e o bipe de outra instalação é
recusado; o leitor ligado não é derrubado por um chamado novo sem passar pelo desligar (que
vai ao diário); um login chama no máximo a cada 2 s; e o que não serve tem UMA resposta só.
"""

import asyncio
import contextlib
import uuid
from datetime import timedelta

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy.exc import IntegrityError
from starlette import status as http

from app.core.eventos import Assunto, central
from app.core.exceptions import AppError, registrar_handlers
from app.modules.leitor import service
from app.modules.leitor.repository import LeitorRepository
from app.modules.leitor.service import FORMATO_DO_SINAL, TETO_POR_COMPUTADOR
from tests.test_leitor import _cliente, _diario, _retirar, _sql, _status

MENSAGEM_CHAMADO = (
    "Este chamado venceu, foi cancelado ou já foi atendido. Toque de novo no botão do "
    "computador."
)
CHAMADO_INVALIDO = {"code": "LEITOR_CHAMADO_INVALIDO", "message": MENSAGEM_CHAMADO, "detail": {}}


@pytest.fixture(autouse=True)
def _sem_intervalo(monkeypatch: pytest.MonkeyPatch) -> None:
    """Os testes chamam várias vezes seguidas; o teto de 2 s tem teste próprio, que o religa."""
    monkeypatch.setattr(service, "INTERVALO_ENTRE_CHAMADOS", timedelta(0))


# ------------------------------------------------------------------ ajudantes


async def _chamar(
    client: AsyncClient,
    auth: dict[str, str],
    *,
    chave: str | None = None,
    substitui_id: int | None = None,
):
    corpo: dict[str, object] = {"client_uuid": chave or str(uuid.uuid4())}
    if substitui_id is not None:
        corpo["substitui_id"] = substitui_id
    return await client.post("/leitor/chamados", headers=auth, json=corpo)


async def _chamado(client: AsyncClient, auth: dict[str, str], **kw: object) -> dict:
    r = await _chamar(client, auth, **kw)
    assert r.status_code == 201, r.text
    return r.json()["pareamento"]


async def _atender(
    client: AsyncClient, auth: dict[str, str], pareamento_id: int, instalacao: uuid.UUID
):
    return await client.post(
        f"/leitor/chamados/{pareamento_id}/atender",
        headers=auth,
        json={"instalacao": str(instalacao)},
    )


async def _abertos(client: AsyncClient, auth: dict[str, str], **params: object) -> dict:
    r = await client.get("/leitor/chamados/abertos", headers=auth, params=params)
    assert r.status_code == 200, r.text
    return r.json()


async def _bipar_de(
    client: AsyncClient,
    auth: dict[str, str],
    pareamento_id: int,
    instalacao: uuid.UUID | None,
    codigo: str = "7891234567895",
):
    corpo: dict[str, object] = {
        "client_uuid": str(uuid.uuid4()),
        "pareamento_id": pareamento_id,
        "codigo": codigo,
    }
    if instalacao is not None:
        corpo["instalacao"] = str(instalacao)
    return await client.post("/leitor/bipes", headers=auth, json=corpo)


async def _codigo_no_banco(pareamento_id: int) -> str:
    ((codigo,),) = await _sql(
        "SELECT codigo FROM leitor_pareamentos WHERE id = :id", id=pareamento_id
    )
    return codigo


def _encontro_com_prazo(monkeypatch: pytest.MonkeyPatch, metodo: str) -> list[str]:
    """As duas requisições se esperam DEPOIS de `metodo`, com prazo de 1,5 s.

    Não é o `_encontro` com barreira do test_leitor: chamar, atender e aceitar do mesmo login
    pegam a mesma trava advisory antes da linha, então a segunda só chega aqui depois do
    commit da primeira — com barreira, as duas esperariam uma pela outra até o fim do prazo e
    o teste cairia. O prazo deixa a primeira seguir; o que se confere é que as duas passaram
    pelo ponto da corrida e o resultado é o certo.
    """
    original = getattr(LeitorRepository, metodo)
    chegaram: list[str] = []
    as_duas = asyncio.Event()

    async def com_encontro(self, *args, **kwargs):
        resultado = await original(self, *args, **kwargs)
        chegaram.append(metodo)
        if len(chegaram) == 2:
            as_duas.set()
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(as_duas.wait(), timeout=1.5)
        return resultado

    monkeypatch.setattr(LeitorRepository, metodo, com_encontro)
    return chegaram


# ------------------------------------------------------------------ chamar


async def test_chamar_cria_aguardando_com_sinal_e_sem_codigo(client, admin, auth_admin) -> None:
    r = await _chamar(client, auth_admin)
    assert r.status_code == 201, r.text
    corpo = r.json()
    assert set(corpo) == {"pareamento", "notificacao", "celulares"}
    p = corpo["pareamento"]
    assert p["status"] == "AGUARDANDO"
    assert p["chamado"] is True
    assert FORMATO_DO_SINAL.fullmatch(p["sinal"]), p["sinal"]
    assert p["codigo"] is None
    assert p["computador_nome"] == admin.name and p["aparelho_nome"] is None
    # Ninguém com este login tem o app atualizado: é o que a tela do computador diz.
    assert corpo["notificacao"] == "SEM_CELULAR" and corpo["celulares"] == 0

    # O código existe no banco (o NOT NULL e o UNIQUE parcial pedem), mas nunca sai.
    codigo = await _codigo_no_banco(p["id"])
    assert codigo and codigo not in r.text
    visto = await client.get(f"/leitor/pareamentos/{p['id']}", headers=auth_admin)
    assert visto.json()["codigo"] is None and codigo not in visto.text


async def test_chamados_abertos_so_do_mesmo_login_e_paginado(
    client, auth_admin, auth_vendedor, auth_gerente
) -> None:
    primeiro = await _chamado(client, auth_admin)
    segundo = await _chamado(client, auth_admin)
    qr = await client.post("/leitor/pareamentos", headers=auth_admin, json=None)
    assert qr.status_code == 201
    do_gerente = await _chamado(client, auth_gerente)

    abertos = await _abertos(client, auth_admin)
    assert set(abertos) == {"items", "total", "page", "size"}
    assert abertos["total"] == 2 and abertos["page"] == 1 and abertos["size"] == 10
    # Do mais novo ao mais velho; o pareamento de QR nunca aparece; nada de código nem nome.
    assert [c["id"] for c in abertos["items"]] == [segundo["id"], primeiro["id"]]
    for item, chamado in zip(abertos["items"], (segundo, primeiro), strict=True):
        assert set(item) == {"id", "sinal", "criado_em", "vence_em"}
        assert item["sinal"] == chamado["sinal"]
        assert item["vence_em"] == chamado["codigo_expira_em"]

    vazio = await _abertos(client, auth_vendedor)
    assert vazio["items"] == [] and vazio["total"] == 0
    so_dele = await _abertos(client, auth_gerente)
    assert [c["id"] for c in so_dele["items"]] == [do_gerente["id"]]

    pagina = await _abertos(client, auth_admin, page=2, size=1)
    assert [c["id"] for c in pagina["items"]] == [primeiro["id"]]
    assert (pagina["total"], pagina["page"], pagina["size"]) == (2, 2, 1)
    # O teto de 10 vivos por login cabe numa página: mais que isso não é pedido.
    grande = await client.get("/leitor/chamados/abertos?size=11", headers=auth_admin)
    assert grande.status_code == 422

    # Atendido sai da lista.
    assert (await _atender(client, auth_admin, segundo["id"], uuid.uuid4())).status_code == 200
    assert [c["id"] for c in (await _abertos(client, auth_admin))["items"]] == [primeiro["id"]]


async def test_atender_liga_sem_codigo_e_o_bipe_chega_ao_computador(
    client, admin, auth_admin
) -> None:
    chamado = await _chamado(client, auth_admin)
    pid = chamado["id"]
    instalacao = uuid.uuid4()

    r = await _atender(client, auth_admin, pid, instalacao)
    assert r.status_code == 200, r.text
    ligado = r.json()
    assert ligado["status"] == "ATIVO" and ligado["chamado"] is True
    assert ligado["sinal"] == chamado["sinal"] and ligado["codigo"] is None
    assert ligado["aparelho_nome"] == admin.name and ligado["computador_nome"] == admin.name
    assert "aparelho_instalacao" not in ligado and str(instalacao) not in r.text
    ((aceito_em, expira_em, gravada),) = await _sql(
        "SELECT aceito_em, expira_em, aparelho_instalacao FROM leitor_pareamentos WHERE id = :id",
        id=pid,
    )
    assert expira_em - aceito_em == timedelta(hours=12)
    assert str(gravada) == str(instalacao)

    # O computador (o web, que consulta o pareamento) vê o celular ligado.
    assert (await _status(client, auth_admin, pid))["status"] == "ATIVO"

    bipe = await _bipar_de(client, auth_admin, pid, instalacao, " 7891234567895 ")
    assert bipe.status_code == 201, bipe.text
    retirada = (await _retirar(client, auth_admin, pid)).json()
    assert [i["codigo"] for i in retirada["items"]] == ["7891234567895"]
    de_novo = (await _retirar(client, auth_admin, pid)).json()
    assert de_novo["items"] == [] and de_novo["descartados"] == 0, "entregou duas vezes"


CASOS_QUE_NAO_SERVEM = [
    "inexistente",
    "de outro login",
    "pareamento de QR",
    "vencido",
    "cancelado",
    "substituído",
    "atendido há mais de 5 min",
    "atendido por outra instalação",
]


@pytest.mark.parametrize("caso", CASOS_QUE_NAO_SERVEM)
async def test_atender_tem_uma_resposta_so_para_tudo_que_nao_serve(
    client, auth_admin, auth_vendedor, caso: str
) -> None:
    instalacao = uuid.uuid4()
    quem = auth_admin
    if caso == "inexistente":
        pid = 999_999
    elif caso == "pareamento de QR":
        r = await client.post("/leitor/pareamentos", headers=auth_admin, json=None)
        pid = r.json()["id"]
    else:
        pid = (await _chamado(client, auth_admin))["id"]
    if caso == "de outro login":
        quem = auth_vendedor
    elif caso == "vencido":
        await _sql(
            "UPDATE leitor_pareamentos SET codigo_expira_em = now() - interval '1 second' "
            "WHERE id = :id",
            id=pid,
        )
    elif caso == "cancelado":
        apagar = await client.delete(f"/leitor/pareamentos/{pid}", headers=auth_admin)
        assert apagar.status_code == 204
    elif caso == "substituído":
        await _chamado(client, auth_admin, substitui_id=pid)
    elif caso == "atendido há mais de 5 min":
        assert (await _atender(client, auth_admin, pid, instalacao)).status_code == 200
        await _sql(
            "UPDATE leitor_pareamentos SET codigo_expira_em = now() - interval '1 second' "
            "WHERE id = :id",
            id=pid,
        )
    elif caso == "atendido por outra instalação":
        assert (await _atender(client, auth_admin, pid, uuid.uuid4())).status_code == 200

    r = await _atender(client, quem, pid, instalacao)
    assert r.status_code == 404, r.text
    assert r.json() == CHAMADO_INVALIDO


async def test_reenvio_do_atender_da_mesma_instalacao_e_fora_do_diario(
    client, admin, auth_admin
) -> None:
    """A resposta do atender se perdeu: a MESMA instalação manda de novo e recebe o mesmo
    pareamento. Nada ligou de novo, então o diário continua com UM "Ligou"."""
    pid = (await _chamado(client, auth_admin))["id"]
    instalacao = uuid.uuid4()
    primeiro = await _atender(client, auth_admin, pid, instalacao)
    de_novo = await _atender(client, auth_admin, pid, instalacao)
    assert primeiro.status_code == de_novo.status_code == 200
    assert de_novo.json() == primeiro.json()
    assert await _diario() == [("LEITOR_PAREADO", admin.name)]


@pytest.mark.parametrize("mesma_instalacao", [False, True], ids=["dois aparelhos", "reenvio"])
async def test_dois_aparelhos_do_mesmo_login_atendendo_juntos(
    client, auth_admin, monkeypatch, mesma_instalacao: bool
) -> None:
    """Dois celulares com o mesmo login tocando "Abrir o leitor" no mesmo chamado: um liga, o
    outro recebe o 404 de sempre (ficaria bipando no mesmo computador, fora do diário). O
    mesmo celular reenviando: os dois pedidos recebem o mesmo pareamento. Sempre UM "Ligou"."""
    pid = (await _chamado(client, auth_admin))["id"]
    chegaram = _encontro_com_prazo(monkeypatch, "chamado_para_atender")
    a = uuid.uuid4()
    b = a if mesma_instalacao else uuid.uuid4()

    async def atender(instalacao: uuid.UUID):
        async with _cliente() as c:
            return await _atender(c, auth_admin, pid, instalacao)

    r1, r2 = await asyncio.gather(atender(a), atender(b))
    assert len(chegaram) == 2
    if mesma_instalacao:
        assert r1.status_code == r2.status_code == 200
        assert r1.json() == r2.json()
    else:
        assert sorted((r1.status_code, r2.status_code)) == [200, 404]
        perdeu = r1 if r1.status_code == 404 else r2
        assert perdeu.json() == CHAMADO_INVALIDO
    linhas = await _sql("SELECT count(*) FROM audit_log WHERE acao = 'LEITOR_PAREADO'")
    assert linhas == [(1,)]


async def test_bipe_de_outra_instalacao_e_recusado(
    client, auth_admin, auth_vendedor
) -> None:
    pid = (await _chamado(client, auth_admin))["id"]
    minha = uuid.uuid4()
    assert (await _atender(client, auth_admin, pid, minha)).status_code == 200

    for outra in (uuid.uuid4(), None):
        r = await _bipar_de(client, auth_admin, pid, outra)
        assert r.status_code == 404 and r.json()["code"] == "NAO_ENCONTRADO", r.text
    assert (await _bipar_de(client, auth_admin, pid, minha)).status_code == 201

    # Pareamento ligado por app antigo (sem instalação): o bipe sem instalação continua.
    qr = (await client.post("/leitor/pareamentos", headers=auth_admin, json=None)).json()
    aceito = await client.post(
        "/leitor/pareamentos/aceitar", headers=auth_vendedor, json={"codigo": qr["codigo"]}
    )
    assert aceito.status_code == 200
    assert (await _bipar_de(client, auth_vendedor, qr["id"], None)).status_code == 201


async def test_trocou_vale_por_instalacao(
    client, auth_admin, auth_gerente, auth_supervisora, auth_vendedor
) -> None:
    """Um celular, um computador — por APARELHO: a instalação A atender um chamado desliga só
    o que A lia (e o que foi ligado por app antigo, que não dá para separar); o leitor da
    instalação B do mesmo login continua no computador dele."""
    a, b = uuid.uuid4(), uuid.uuid4()

    async def aceitar_qr(auth_pc: dict[str, str], instalacao: uuid.UUID) -> int:
        qr = (await client.post("/leitor/pareamentos", headers=auth_pc, json=None)).json()
        r = await client.post(
            "/leitor/pareamentos/aceitar",
            headers=auth_admin,
            json={"codigo": qr["codigo"], "instalacao": str(instalacao)},
        )
        assert r.status_code == 200, r.text
        return qr["id"]

    da_b = await aceitar_qr(auth_gerente, b)
    da_a = await aceitar_qr(auth_supervisora, a)
    do_app_antigo = await aceitar_qr(auth_vendedor, uuid.uuid4())
    await _sql(
        "UPDATE leitor_pareamentos SET aparelho_instalacao = NULL WHERE id = :id",
        id=do_app_antigo,
    )

    chamado = (await _chamado(client, auth_admin))["id"]
    assert (await _atender(client, auth_admin, chamado, a)).status_code == 200

    situacao = {
        pid: (await _status(client, auth_admin, pid))
        for pid in (da_b, da_a, do_app_antigo, chamado)
    }
    assert situacao[da_b]["status"] == "ATIVO"
    for pid in (da_a, do_app_antigo):
        assert situacao[pid]["status"] == "ENCERRADO"
        assert situacao[pid]["motivo_encerramento"] == "TROCOU"
    assert situacao[chamado]["status"] == "ATIVO"


async def test_codigo_de_chamado_nao_abre_no_aceite_por_codigo(
    client, auth_admin, auth_vendedor
) -> None:
    pid = (await _chamado(client, auth_admin))["id"]
    codigo = await _codigo_no_banco(pid)
    for auth in (auth_vendedor, auth_admin):
        r = await client.post(
            "/leitor/pareamentos/aceitar", headers=auth, json={"codigo": codigo}
        )
        assert r.status_code == 404 and r.json()["code"] == "LEITOR_CODIGO_INVALIDO"
    assert (await _status(client, auth_admin, pid))["status"] == "AGUARDANDO"

    # O reenvio do aceite por código também não acha o chamado, nem atendido pelo mesmo app.
    instalacao = uuid.uuid4()
    assert (await _atender(client, auth_admin, pid, instalacao)).status_code == 200
    for corpo in ({"codigo": codigo}, {"codigo": codigo, "instalacao": str(instalacao)}):
        r = await client.post("/leitor/pareamentos/aceitar", headers=auth_admin, json=corpo)
        assert r.status_code == 404 and r.json()["code"] == "LEITOR_CODIGO_INVALIDO"


async def test_banco_recusa_chamado_atendido_por_outro_login(
    client, vendedor, auth_admin
) -> None:
    pid = (await _chamado(client, auth_admin))["id"]
    with pytest.raises(IntegrityError, match="ck_leitor_pareamentos_chamado_do_mesmo_login"):
        await _sql(
            "UPDATE leitor_pareamentos SET aparelho_user_id = :u, aceito_em = now(), "
            "expira_em = now() + interval '12 hours' WHERE id = :id",
            u=vendedor.id,
            id=pid,
        )


@pytest.mark.parametrize(
    ("colunas", "restricao"),
    [
        ("true, NULL, NULL", "ck_leitor_pareamentos_sinal_do_chamado"),
        ("true, '0O1', NULL", "ck_leitor_pareamentos_sinal_do_chamado"),
        ("false, '7K3', NULL", "ck_leitor_pareamentos_sinal_do_chamado"),
        ("false, NULL, gen_random_uuid()", "ck_leitor_pareamentos_chave_do_chamado"),
    ],
    ids=["chamado sem sinal", "sinal fora do formato", "QR com sinal", "QR com chave"],
)
async def test_banco_recusa_chamado_sem_sinal(admin, colunas: str, restricao: str) -> None:
    with pytest.raises(IntegrityError, match=restricao):
        await _sql(
            "INSERT INTO leitor_pareamentos (codigo, computador_user_id, codigo_expira_em, "
            f"chamado, sinal, client_uuid) VALUES ('ZZZZZZ', :u, now(), {colunas})",
            u=admin.id,
        )
    # E a instalação só existe depois do aceite.
    with pytest.raises(IntegrityError, match="ck_leitor_pareamentos_instalacao_do_aceite"):
        await _sql(
            "INSERT INTO leitor_pareamentos (codigo, computador_user_id, codigo_expira_em, "
            "aparelho_instalacao) VALUES ('ZZZZZZ', :u, now(), gen_random_uuid())",
            u=admin.id,
        )


async def test_chamado_vence_em_5_min(client, auth_admin) -> None:
    pid = (await _chamado(client, auth_admin))["id"]
    ((criado_em, vence),) = await _sql(
        "SELECT criado_em, codigo_expira_em FROM leitor_pareamentos WHERE id = :id", id=pid
    )
    assert vence - criado_em == timedelta(minutes=5)

    await _sql(
        "UPDATE leitor_pareamentos SET codigo_expira_em = now() - interval '1 second' "
        "WHERE id = :id",
        id=pid,
    )
    assert (await _status(client, auth_admin, pid))["status"] == "EXPIRADO"
    assert (await _abertos(client, auth_admin))["items"] == []
    r = await _atender(client, auth_admin, pid, uuid.uuid4())
    assert r.status_code == 404 and r.json() == CHAMADO_INVALIDO


async def test_um_chamado_por_aba(client, auth_admin, monkeypatch) -> None:
    """Mesmo login em duas abas (dois caixas): cada uma tem o seu chamado e o seu sinal — o
    segundo não derruba o primeiro. A aba que chama de novo troca só o dela."""
    sorteios = iter(["7K3", "7K3", "2A2", "9Z9"])
    monkeypatch.setattr(service, "gerar_sinal", lambda: next(sorteios))

    caixa1 = await _chamado(client, auth_admin)
    caixa2 = await _chamado(client, auth_admin)
    # O sorteio repetiu o sinal de um chamado vivo do login: sorteou de novo.
    assert (caixa1["sinal"], caixa2["sinal"]) == ("7K3", "2A2")
    abertos = await _abertos(client, auth_admin)
    assert [c["id"] for c in abertos["items"]] == [caixa2["id"], caixa1["id"]]

    de_novo = await _chamado(client, auth_admin, substitui_id=caixa1["id"])
    assert de_novo["sinal"] == "9Z9"
    antigo = await _status(client, auth_admin, caixa1["id"])
    assert antigo["status"] == "ENCERRADO" and antigo["motivo_encerramento"] == "SUBSTITUIDO"
    assert (await _status(client, auth_admin, caixa2["id"]))["status"] == "AGUARDANDO"


async def test_substitui_id_de_ativo_e_409_no_chamado_e_no_qr(
    client, admin, auth_admin, auth_vendedor
) -> None:
    """Trocar um pareamento LIGADO desligaria o celular sem linha no diário: recusado, com o
    id, para a tela refazer o status. O ATIVO continua ATIVO."""
    pid = (await _chamado(client, auth_admin))["id"]
    assert (await _atender(client, auth_admin, pid, uuid.uuid4())).status_code == 200
    qr = (await client.post("/leitor/pareamentos", headers=auth_admin, json=None)).json()
    aceito = await client.post(
        "/leitor/pareamentos/aceitar", headers=auth_vendedor, json={"codigo": qr["codigo"]}
    )
    assert aceito.status_code == 200

    for ligado in (pid, qr["id"]):
        respostas = [
            await _chamar(client, auth_admin, substitui_id=ligado),
            await client.post(
                "/leitor/pareamentos", headers=auth_admin, json={"substitui_id": ligado}
            ),
        ]
        for r in respostas:
            assert r.status_code == 409, r.text
            assert r.json()["code"] == "LEITOR_JA_LIGADO"
            assert r.json()["detail"] == {"pareamento_id": ligado}
        assert (await _status(client, auth_admin, ligado))["status"] == "ATIVO"
    assert await _diario() == [("LEITOR_PAREADO", admin.name), ("LEITOR_PAREADO", "Ana Vendedora")]
    # Nada novo nasceu nas tentativas recusadas.
    assert (await _abertos(client, auth_admin))["items"] == []


async def test_chamar_de_novo_com_leitor_ligado_passa_pelo_desligar(
    client, admin, auth_admin
) -> None:
    """O "Chamar de novo" do computador com o leitor ligado: desliga (DELETE, que vai ao
    diário) e só então chama. O celular antigo fica sabendo pelo bipe recusado."""
    antigo = (await _chamado(client, auth_admin))["id"]
    instalacao = uuid.uuid4()
    assert (await _atender(client, auth_admin, antigo, instalacao)).status_code == 200

    desligar = await client.delete(f"/leitor/pareamentos/{antigo}", headers=auth_admin)
    assert desligar.status_code == 204
    novo = await _chamado(client, auth_admin)
    assert novo["id"] != antigo and novo["status"] == "AGUARDANDO"

    r = await _bipar_de(client, auth_admin, antigo, instalacao)
    assert r.status_code == 409 and r.json()["code"] == "LEITOR_DESLIGADO"
    assert await _diario() == [("LEITOR_PAREADO", admin.name), ("LEITOR_DESLIGADO", admin.name)]


async def test_chave_do_chamado_e_idempotente(client, auth_admin, auth_vendedor, expo) -> None:
    registro = await client.put(
        "/notificacoes/aparelho",
        headers=auth_admin,
        json={
            "instalacao": str(uuid.uuid4()),
            "plataforma": "ios",
            "token": "ExponentPushToken[idempotente]",
        },
    )
    assert registro.status_code == 204
    chave = str(uuid.uuid4())

    primeiro = await _chamar(client, auth_admin, chave=chave)
    assert primeiro.status_code == 201, primeiro.text
    assert primeiro.json()["notificacao"] == "ENVIADA"
    de_novo = await _chamar(client, auth_admin, chave=chave)
    assert de_novo.status_code == 200, de_novo.text
    assert de_novo.json() == {
        "pareamento": primeiro.json()["pareamento"],
        "notificacao": None,
        "celulares": 0,
    }
    assert len(expo.lotes) == 1, "o reenvio da chave mandou o push de novo"
    assert len((await _abertos(client, auth_admin))["items"]) == 1

    alheia = await _chamar(client, auth_vendedor, chave=chave)
    assert alheia.status_code == 409 and alheia.json()["code"] == "DUPLICADO"
    assert (await _abertos(client, auth_vendedor))["items"] == []


async def test_um_chamado_a_cada_2_s_por_login(
    client, auth_admin, auth_vendedor, monkeypatch
) -> None:
    monkeypatch.setattr(service, "INTERVALO_ENTRE_CHAMADOS", timedelta(seconds=2))
    chave = str(uuid.uuid4())
    assert (await _chamar(client, auth_admin, chave=chave)).status_code == 201

    rapido = await _chamar(client, auth_admin)
    assert rapido.status_code == 429, rapido.text
    assert rapido.json()["code"] == "LEITOR_CHAMADO_RAPIDO"
    espera = rapido.json()["detail"]["retry_after"]
    assert espera in (1, 2)
    assert rapido.headers["Retry-After"] == str(espera)

    # O reenvio da mesma chave não é chamado novo: não leva 429.
    assert (await _chamar(client, auth_admin, chave=chave)).status_code == 200
    # Outro login não espera pelo primeiro.
    assert (await _chamar(client, auth_vendedor)).status_code == 201
    # Passados os 2 s, chama de novo.
    await _sql(
        "UPDATE leitor_pareamentos SET criado_em = criado_em - interval '3 seconds'"
    )
    assert (await _chamar(client, auth_admin)).status_code == 201


async def test_todo_429_com_retry_after_leva_o_cabecalho() -> None:
    """O cabeçalho vem do prazo no `detail`, e não de um `code` conhecido: o 429 novo ganha o
    Retry-After sem ninguém lembrar de pôr. 429 sem prazo, e prazo fora de 429, não."""

    class Devagar(AppError):
        code = "QUALQUER_429"
        http_status = http.HTTP_429_TOO_MANY_REQUESTS

    class Conflito(AppError):
        code = "QUALQUER_409"
        http_status = http.HTTP_409_CONFLICT

    mini = FastAPI()
    registrar_handlers(mini)

    @mini.get("/com-prazo")
    async def com_prazo() -> None:
        raise Devagar(detail={"retry_after": 7})

    @mini.get("/sem-prazo")
    async def sem_prazo() -> None:
        raise Devagar()

    @mini.get("/nao-e-429")
    async def nao_e_429() -> None:
        raise Conflito(detail={"retry_after": 7})

    async with AsyncClient(transport=ASGITransport(app=mini), base_url="http://t") as c:
        com = await c.get("/com-prazo")
        assert com.status_code == 429 and com.headers["Retry-After"] == "7"
        assert "Retry-After" not in (await c.get("/sem-prazo")).headers
        assert "Retry-After" not in (await c.get("/nao-e-429")).headers


# ------------------------------------------------------------------ desligar


async def test_desligar_pelo_celular_com_o_mesmo_login_grava_celular(
    client, auth_admin, auth_vendedor, auth_gerente
) -> None:
    async def ligado() -> int:
        pid = (await _chamado(client, auth_admin))["id"]
        assert (await _atender(client, auth_admin, pid, uuid.uuid4())).status_code == 200
        return pid

    async def desligar(pid: int, auth: dict[str, str], ponta: str | None = None):
        sufixo = f"?ponta={ponta}" if ponta else ""
        return await client.delete(f"/leitor/pareamentos/{pid}{sufixo}", headers=auth)

    pelo_celular = await ligado()
    assert (await desligar(pelo_celular, auth_admin, "celular")).status_code == 204
    assert (await _status(client, auth_admin, pelo_celular))["motivo_encerramento"] == "CELULAR"

    sem_ponta = await ligado()
    assert (await desligar(sem_ponta, auth_admin)).status_code == 204
    assert (await _status(client, auth_admin, sem_ponta))["motivo_encerramento"] == "COMPUTADOR"

    torto = await ligado()
    assert (await desligar(torto, auth_admin, "xyz")).status_code == 422
    assert (await desligar(torto, auth_gerente, "celular")).status_code == 404
    assert (await _status(client, auth_admin, torto))["status"] == "ATIVO"

    # Quem é só o computador não vira celular por dizer que é.
    qr = (await client.post("/leitor/pareamentos", headers=auth_admin, json=None)).json()
    aceito = await client.post(
        "/leitor/pareamentos/aceitar", headers=auth_vendedor, json={"codigo": qr["codigo"]}
    )
    assert aceito.status_code == 200
    assert (await desligar(qr["id"], auth_admin, "celular")).status_code == 204
    assert (await _status(client, auth_admin, qr["id"]))["motivo_encerramento"] == "COMPUTADOR"


# ------------------------------------------------------------------ tempo real e diário


async def test_tempo_real_chamado_e_bipe_por_assunto(client, auth_admin) -> None:
    def drenar(fila) -> list:
        eventos = []
        while not fila.empty():
            eventos.append(fila.get_nowait())
        return eventos

    todos = []
    async with central.inscrever() as fila:
        chamado = await _chamado(client, auth_admin)
        eventos = drenar(fila)
        todos += eventos
        assert {e.assunto for e in eventos} == {Assunto.LEITOR_PAREAMENTO}

        instalacao = uuid.uuid4()
        await _atender(client, auth_admin, chamado["id"], instalacao)
        eventos = drenar(fila)
        todos += eventos
        assert {e.assunto for e in eventos} == {Assunto.LEITOR_PAREAMENTO}

        await _bipar_de(client, auth_admin, chamado["id"], instalacao)
        eventos = drenar(fila)
        todos += eventos
        assert {e.assunto for e in eventos} == {Assunto.LEITOR}

        await _retirar(client, auth_admin, chamado["id"])
        r = await client.put(
            "/notificacoes/aparelho",
            headers=auth_admin,
            json={"instalacao": str(instalacao), "plataforma": "android", "token": None},
        )
        assert r.status_code == 204
        assert drenar(fila) == [], "retirar ou registrar o aparelho avisou as telas"

        await client.delete(f"/leitor/pareamentos/{chamado['id']}", headers=auth_admin)
        eventos = drenar(fila)
        todos += eventos
        assert {e.assunto for e in eventos} == {Assunto.LEITOR_PAREAMENTO}

    # Só o assunto: nem o id, nem o código, nem o sinal, nem quem foi chamado.
    assert todos and all(e.dados == {} for e in todos)
    assert all(chamado["sinal"] not in str(e.como_json()) for e in todos)


async def test_diario_do_chamado(client, auth_admin) -> None:
    async def linhas() -> list[tuple[str, str]]:
        return [
            (acao, descricao)
            for acao, descricao in await _sql(
                "SELECT acao, descricao FROM audit_log WHERE acao NOT LIKE 'LOGIN%' ORDER BY id"
            )
        ]

    instalacao = uuid.uuid4()
    registro = {"instalacao": str(instalacao), "plataforma": "ios", "token": None}
    assert (
        await client.put("/notificacoes/aparelho", headers=auth_admin, json=registro)
    ).status_code == 204
    pid = (await _chamado(client, auth_admin))["id"]
    assert await linhas() == [], "chamar ou registrar o aparelho entrou no diário"

    await _atender(client, auth_admin, pid, instalacao)
    await _bipar_de(client, auth_admin, pid, instalacao)
    await _retirar(client, auth_admin, pid)
    await client.delete(f"/leitor/pareamentos/{pid}?ponta=celular", headers=auth_admin)
    fora = await client.request(
        "DELETE", "/notificacoes/aparelho", json={"instalacao": str(instalacao)}
    )
    assert fora.status_code == 204

    assert await linhas() == [
        ("LEITOR_PAREADO", f"Ligou o celular como leitor do computador pelo chamado #{pid}"),
        ("LEITOR_DESLIGADO", f"Desligou o celular-leitor #{pid}"),
    ]


async def test_teto_e_faxina_valem_para_chamado(client, auth_admin) -> None:
    criados = [await _chamado(client, auth_admin) for _ in range(TETO_POR_COMPUTADOR + 2)]
    abertos = await _abertos(client, auth_admin)
    assert abertos["total"] == TETO_POR_COMPUTADOR
    assert {c["id"] for c in abertos["items"]} == {c["id"] for c in criados[-TETO_POR_COMPUTADOR:]}
    for velho in criados[:2]:
        assert (await _status(client, auth_admin, velho["id"]))["motivo_encerramento"] == (
            "SUBSTITUIDO"
        )

    # Terminado há mais de 30 dias some no próximo chamado, como o pareamento de QR.
    velho = criados[0]["id"]
    await _sql(
        "UPDATE leitor_pareamentos SET encerrado_em = now() - interval '31 days' WHERE id = :id",
        id=velho,
    )
    await _chamado(client, auth_admin)
    assert await _sql("SELECT id FROM leitor_pareamentos WHERE id = :id", id=velho) == []
