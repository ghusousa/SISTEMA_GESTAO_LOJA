"""O registro do aparelho e o push do chamado do leitor (ADR-47).

O que não pode quebrar: o token de push é credencial ao portador — nunca sai em rota, em log
nem em `repr`, e some no logout, na troca de senha, na desativação e depois de 30 dias; o push
leva só texto fixo e o sinal, para os aparelhos do MESMO login; nenhuma transação fica aberta
enquanto a Expo responde (até 4 s no total); e falha nenhuma da Expo derruba o chamado, que já
está gravado quando o push sai. A rede é sempre a Expo de mentira (`httpx.MockTransport`).
"""

import asyncio
import logging
import re
import time
import uuid

import httpx
import pytest
from httpx import AsyncClient
from sqlalchemy import text

from app.core.config import settings
from app.core.db import engine
from app.modules.leitor import service as leitor_service
from app.modules.notificacoes import expo as push_da_expo
from app.modules.notificacoes import service as notificacoes_service
from app.modules.notificacoes.expo import Mensagem, Recibo
from app.modules.notificacoes.models import AparelhoDeNotificacao
from tests.test_leitor import _sql

ROTA = "/notificacoes/aparelho"


@pytest.fixture(autouse=True)
def _sem_intervalo(monkeypatch: pytest.MonkeyPatch) -> None:
    from datetime import timedelta

    monkeypatch.setattr(leitor_service, "INTERVALO_ENTRE_CHAMADOS", timedelta(0))


def _token(nome: str) -> str:
    return f"ExponentPushToken[{nome}]"


async def _registrar(
    client: AsyncClient,
    auth: dict[str, str],
    instalacao: uuid.UUID,
    plataforma: str = "ios",
    **token: str | None,
):
    """`token=` ausente, `None` ou texto — os três estados do campo."""
    corpo: dict[str, object] = {"instalacao": str(instalacao), "plataforma": plataforma, **token}
    return await client.put(ROTA, headers=auth, json=corpo)


async def _aparelhos() -> list[tuple]:
    """(instalação, user_id, plataforma, token), na ordem do registro."""
    return [
        (str(i), u, p, t)
        for i, u, p, t in await _sql(
            "SELECT instalacao, user_id, plataforma, token FROM notificacao_aparelhos ORDER BY id"
        )
    ]


async def _chamar(client: AsyncClient, auth: dict[str, str]):
    r = await client.post(
        "/leitor/chamados", headers=auth, json={"client_uuid": str(uuid.uuid4())}
    )
    assert r.status_code == 201, r.text
    return r.json()


def _resposta(*itens: dict) -> httpx.Response:
    return httpx.Response(200, json={"data": list(itens)})


OK = {"status": "ok", "id": "recibo"}


def _erro(codigo: str, token: str) -> dict:
    # O `message` da Expo repete o token por extenso: o adaptador nunca o lê nem o loga.
    return {
        "status": "error",
        "message": f'"{token}" is not a registered push notification recipient',
        "details": {"error": codigo},
    }


# ------------------------------------------------------------------ o registro


async def test_registrar_e_idempotente_e_a_instalacao_muda_de_login(
    client, admin, vendedor, auth_admin, auth_vendedor
) -> None:
    instalacao = uuid.uuid4()
    r = await _registrar(client, auth_admin, instalacao, token=_token("a"))
    assert r.status_code == 204 and r.content == b""
    assert (await _registrar(client, auth_admin, instalacao, token=_token("a"))).status_code == 204
    assert await _aparelhos() == [(str(instalacao), admin.id, "ios", _token("a"))]

    # O mesmo aparelho, agora com outro login: um aparelho é de um login por vez.
    r = await _registrar(client, auth_vendedor, instalacao, "android")
    assert r.status_code == 204
    assert await _aparelhos() == [(str(instalacao), vendedor.id, "android", _token("a"))]

    sem_login = await client.put(
        ROTA, json={"instalacao": str(uuid.uuid4()), "plataforma": "ios"}
    )
    assert sem_login.status_code == 401


async def test_token_ausente_mantem_e_null_apaga(client, admin, auth_admin) -> None:
    instalacao = uuid.uuid4()
    await _registrar(client, auth_admin, instalacao, token=_token("guardado"))
    # O app não conseguiu falar com a Expo agora: o campo vem AUSENTE e o token fica.
    await _registrar(client, auth_admin, instalacao)
    assert (await _aparelhos())[0][3] == _token("guardado")
    # Sem permissão (ou Android sem FCM, ou Expo Go): `null` apaga o token e a instalação fica.
    await _registrar(client, auth_admin, instalacao, token=None)
    assert await _aparelhos() == [(str(instalacao), admin.id, "ios", None)]


async def test_mesmo_token_em_outra_instalacao_fica_so_na_nova(
    client, vendedor, auth_admin, auth_vendedor
) -> None:
    """O mesmo aparelho com outro id de instalação (o app trocou de servidor e voltou): o
    token não fica em duas linhas — o push sairia duas vezes, e a velha pode ser de outro
    login."""
    velha, nova = uuid.uuid4(), uuid.uuid4()
    await _registrar(client, auth_admin, velha, token=_token("unico"))
    r = await _registrar(client, auth_vendedor, nova, token=_token("unico"))
    assert r.status_code == 204
    assert await _aparelhos() == [(str(nova), vendedor.id, "ios", _token("unico"))]


@pytest.mark.parametrize(
    "corpo",
    [
        {"token": ""},
        {"token": "abc"},
        {"token": "ExponentPushToken[sem-fecho"},
        {"token": "ExponentPushToken[com espaco]"},
        {"token": "ExponentPushToken[com\nquebra]"},
        {"token": "ExponentPushToken[" + "x" * 182 + "]"},
        {"plataforma": "web"},
        {"instalacao": "nao-e-uuid"},
    ],
    ids=["vazio", "abc", "sem ]", "com espaço", "com \\n", "201 caracteres", "web", "id torto"],
)
async def test_token_fora_do_formato_e_422(client, auth_admin, corpo: dict) -> None:
    pedido = {"instalacao": str(uuid.uuid4()), "plataforma": "ios", **corpo}
    r = await client.put(ROTA, headers=auth_admin, json=pedido)
    assert r.status_code == 422, r.text
    assert r.json()["code"] == "VALIDACAO" and r.json()["detail"]["campos"]
    # A recusa não devolve o que veio no campo.
    if corpo.get("token"):
        assert corpo["token"] not in r.text
    assert await _aparelhos() == []

    # A grafia antiga da Expo vale, e 200 caracteres cabem.
    for valido in ("ExpoPushToken[antigo]", "ExponentPushToken[" + "x" * 181 + "]"):
        assert (await _registrar(client, auth_admin, uuid.uuid4(), token=valido)).status_code == 204


async def test_dez_aparelhos_por_login_os_mais_recentes(
    client, vendedor, auth_admin, auth_vendedor
) -> None:
    da_vendedora = uuid.uuid4()
    await _registrar(client, auth_vendedor, da_vendedora)
    instalacoes = [uuid.uuid4() for _ in range(12)]
    for i, instalacao in enumerate(instalacoes):
        await _registrar(client, auth_admin, instalacao, token=_token(f"n{i}"))
    ficaram = {i for i, *_ in await _aparelhos()}
    assert ficaram == {str(i) for i in instalacoes[-10:]} | {str(da_vendedora)}

    # Quem se registra de novo volta a ser recente: o mais velho é que sai.
    await _registrar(client, auth_admin, instalacoes[2])
    await _registrar(client, auth_admin, uuid.uuid4())
    ficaram = {i for i, *_ in await _aparelhos()}
    assert str(instalacoes[2]) in ficaram and str(instalacoes[3]) not in ficaram
    assert len(ficaram) == 11


async def test_aparelho_sem_uso_ha_30_dias_sai_na_faxina(
    client, auth_admin, auth_vendedor
) -> None:
    calado, ativo = uuid.uuid4(), uuid.uuid4()
    await _registrar(client, auth_admin, calado, token=_token("calado"))
    await _sql(
        "UPDATE notificacao_aparelhos SET visto_em = now() - interval '31 days' "
        "WHERE instalacao = :i",
        i=calado,
    )
    # Mesmo antes da faxina, o calado não conta como aparelho do login.
    assert (await _chamar(client, auth_admin))["notificacao"] == "SEM_CELULAR"

    await _registrar(client, auth_vendedor, ativo)
    assert [i for i, *_ in await _aparelhos()] == [str(ativo)]


async def test_esquecer_sem_sessao(client, auth_admin) -> None:
    sai, fica = uuid.uuid4(), uuid.uuid4()
    await _registrar(client, auth_admin, sai, token=_token("sai"))
    await _registrar(client, auth_admin, fica, token=_token("fica"))

    # Sem Authorization: o app esquece depois de a sessão cair, ou no servidor de antes.
    r = await client.request("DELETE", ROTA, json={"instalacao": str(sai)})
    assert r.status_code == 204 and r.content == b""
    assert [i for i, *_ in await _aparelhos()] == [str(fica)]

    # Id que não existe: o mesmo 204, e nada muda.
    r = await client.request("DELETE", ROTA, json={"instalacao": str(uuid.uuid4())})
    assert r.status_code == 204
    assert [i for i, *_ in await _aparelhos()] == [str(fica)]

    for torto in ({"instalacao": "x"}, {}):
        assert (await client.request("DELETE", ROTA, json=torto)).status_code == 422


# ------------------------------------------------------------------ o push


async def test_chamado_manda_push_so_aos_aparelhos_com_token_do_mesmo_login(
    client, auth_admin, auth_vendedor, expo
) -> None:
    await _registrar(client, auth_admin, uuid.uuid4(), "ios", token=_token("iphone"))
    await _registrar(client, auth_admin, uuid.uuid4(), "android", token=_token("android"))
    await _registrar(client, auth_admin, uuid.uuid4(), "ios", token=None)
    await _registrar(client, auth_vendedor, uuid.uuid4(), "ios", token=_token("alheio"))

    corpo = await _chamar(client, auth_admin)
    assert corpo["notificacao"] == "ENVIADA" and corpo["celulares"] == 2
    assert len(expo.lotes) == 1, "um POST só, com a lista"
    assert sorted(expo.tokens) == sorted([_token("iphone"), _token("android")])


async def test_push_nao_leva_dado_da_loja(client, admin, auth_admin, expo) -> None:
    await client.patch("/configuracao", headers=auth_admin, json={"nome": "Boutique da Maria"})
    await _registrar(client, auth_admin, uuid.uuid4(), token=_token("iphone"))
    chamado = (await _chamar(client, auth_admin))["pareamento"]
    ((codigo,),) = await _sql(
        "SELECT codigo FROM leitor_pareamentos WHERE id = :id", id=chamado["id"]
    )

    (lote,) = expo.lotes
    (mensagem,) = lote
    assert set(mensagem) == {
        "to", "title", "body", "data", "sound", "priority", "ttl", "channelId"
    }
    assert mensagem["data"] == {"tipo": "leitor-chamado", "sinal": chamado["sinal"]}
    assert mensagem["ttl"] == 300
    assert mensagem["title"] == "Leitor de código de barras"
    assert mensagem["body"] == (
        f"O computador do sinal {chamado['sinal']} está chamando: toque para abrir a câmera "
        "e ler as etiquetas."
    )
    valores = " ".join(str(v) for k, v in mensagem.items() if k != "to")
    assert not re.search(rf"\b{chamado['id']}\b", valores), "o id do chamado foi para a Expo"
    for proibido in (codigo, admin.name, admin.email, "Boutique", "http", "/api"):
        assert proibido not in valores, proibido


async def test_o_chamado_ja_esta_gravado_quando_o_push_sai(client, auth_admin, expo) -> None:
    """O commit vem antes do push: o celular que toca na notificação (ou o app aberto, pela
    faixa) já acha o chamado, mesmo que a Expo demore."""
    await _registrar(client, auth_admin, uuid.uuid4(), token=_token("iphone"))
    vistos: list[tuple] = []

    async def durante(lote: list[dict]) -> None:
        sinal = lote[0]["data"]["sinal"]
        async with engine.connect() as outra:
            linhas = await outra.execute(
                text(
                    "SELECT id, aceito_em, encerrado_em FROM leitor_pareamentos "
                    "WHERE chamado AND sinal = :s"
                ),
                {"s": sinal},
            )
            vistos.extend(linhas.all())

    expo.durante = durante
    chamado = (await _chamar(client, auth_admin))["pareamento"]
    assert vistos == [(chamado["id"], None, None)]


async def test_nenhuma_transacao_aberta_durante_o_envio(client, auth_admin, expo) -> None:
    """Enquanto a Expo responde (até 4 s), a requisição não segura trava nenhuma: uma outra
    conexão consegue o lock mais forte nas duas tabelas, sem esperar. Na demo, a renovação da
    madrugada (TRUNCATE) passaria por cima sem ficar na fila atrás de um push."""
    await _registrar(client, auth_admin, uuid.uuid4(), token=_token("iphone"))
    conseguiu: list[bool] = []

    async def durante(_lote: list[dict]) -> None:
        async with engine.connect() as outra:
            transacao = await outra.begin()
            try:
                await outra.execute(
                    text(
                        "LOCK TABLE notificacao_aparelhos, leitor_pareamentos "
                        "IN ACCESS EXCLUSIVE MODE NOWAIT"
                    )
                )
                conseguiu.append(True)
            except Exception:  # noqa: BLE001 - o teste olha o resultado abaixo
                conseguiu.append(False)
            finally:
                await transacao.rollback()

    expo.durante = durante
    assert (await _chamar(client, auth_admin))["notificacao"] == "ENVIADA"
    assert conseguiu == [True], "a requisição segurava uma transação durante o envio"


async def test_sem_aparelho_diz_sem_celular(client, auth_admin, auth_vendedor, expo) -> None:
    await _registrar(client, auth_vendedor, uuid.uuid4(), token=_token("de-outro-login"))
    corpo = await _chamar(client, auth_admin)
    assert (corpo["notificacao"], corpo["celulares"]) == ("SEM_CELULAR", 0)
    assert expo.lotes == []


async def test_aparelho_sem_token_diz_sem_notificacao(client, auth_admin, expo) -> None:
    await _registrar(client, auth_admin, uuid.uuid4(), "android", token=None)
    await _registrar(client, auth_admin, uuid.uuid4(), "ios", token=None)
    corpo = await _chamar(client, auth_admin)
    assert (corpo["notificacao"], corpo["celulares"]) == ("SEM_NOTIFICACAO", 2)
    assert expo.lotes == []


async def test_desligado_no_env_nao_chama_a_rede(
    client, auth_admin, expo, monkeypatch
) -> None:
    monkeypatch.setattr(settings, "notificacoes_push", "desligado")
    await _registrar(client, auth_admin, uuid.uuid4(), token=_token("iphone"))
    await _registrar(client, auth_admin, uuid.uuid4(), token=None)
    corpo = await _chamar(client, auth_admin)
    # Os dois aparelhos veem o chamado com o app aberto; push, nenhum.
    assert (corpo["notificacao"], corpo["celulares"]) == ("DESLIGADA", 2)
    assert expo.lotes == []


async def test_rede_caida_vira_falhou_e_o_chamado_vale(client, auth_admin, expo) -> None:
    await _registrar(client, auth_admin, uuid.uuid4(), token=_token("iphone"))

    async def cair(_lote: list[dict]) -> httpx.Response:
        raise httpx.ConnectError("sem rede")

    expo.responder = cair
    corpo = await _chamar(client, auth_admin)
    assert (corpo["notificacao"], corpo["celulares"]) == ("FALHOU", 0)
    assert corpo["pareamento"]["status"] == "AGUARDANDO"
    abertos = (await client.get("/leitor/chamados/abertos", headers=auth_admin)).json()
    assert [c["id"] for c in abertos["items"]] == [corpo["pareamento"]["id"]]
    # A instalação e o token ficam: rede caída não é token morto.
    assert (await _aparelhos())[0][3] == _token("iphone")


async def test_teto_total_do_envio(client, auth_admin, expo, monkeypatch) -> None:
    """O teto é do envio INTEIRO, não por fase do httpx: uma Expo que demora responde FALHOU
    no prazo, e o POST do chamado não fica preso nela."""
    monkeypatch.setattr(push_da_expo, "TETO_DO_ENVIO_S", 0.2)
    await _registrar(client, auth_admin, uuid.uuid4(), token=_token("iphone"))

    async def demorar(_lote: list[dict]) -> httpx.Response:
        await asyncio.sleep(3)
        return _resposta(OK)

    expo.responder = demorar
    inicio = time.monotonic()
    corpo = await _chamar(client, auth_admin)
    assert time.monotonic() - inicio < 1.5
    assert corpo["notificacao"] == "FALHOU"


@pytest.mark.parametrize(
    "resposta",
    [
        httpx.Response(500, json={"errors": [{"code": "INTERNAL_SERVER_ERROR"}]}),
        httpx.Response(429, json={"errors": [{"code": "TOO_MANY_REQUESTS"}]}),
        httpx.Response(200, text="<html>não é json</html>"),
        httpx.Response(200, json={"errors": [{"code": "PUSH_TOO_MANY_EXPERIENCE_IDS"}]}),
        httpx.Response(200, json={"data": "ok"}),
        httpx.Response(200, json={"data": []}),
        httpx.Response(200, json={"data": [{"status": "error", "details": {"error": "X"}}]}),
    ],
    ids=["500", "429", "html", "errors", "data texto", "data vazia", "erro desconhecido"],
)
async def test_5xx_e_json_estranho_viram_falhou(
    client, auth_admin, expo, resposta: httpx.Response
) -> None:
    await _registrar(client, auth_admin, uuid.uuid4(), token=_token("iphone"))

    async def responder(_lote: list[dict]) -> httpx.Response:
        return resposta

    expo.responder = responder
    corpo = await _chamar(client, auth_admin)
    assert (corpo["notificacao"], corpo["celulares"]) == ("FALHOU", 0)
    assert corpo["pareamento"]["status"] == "AGUARDANDO"


async def test_device_not_registered_anula_o_token(client, auth_admin, expo) -> None:
    morto, vivo = uuid.uuid4(), uuid.uuid4()
    await _registrar(client, auth_admin, morto, "ios", token=_token("morto"))
    await _registrar(client, auth_admin, vivo, "android", token=_token("vivo"))

    async def responder(lote: list[dict]) -> httpx.Response:
        return _resposta(
            *(_erro("DeviceNotRegistered", m["to"]) if m["to"] == _token("morto") else OK
              for m in lote)
        )

    expo.responder = responder
    corpo = await _chamar(client, auth_admin)
    assert (corpo["notificacao"], corpo["celulares"]) == ("ENVIADA", 1)
    tokens = {i: t for i, _, _, t in await _aparelhos()}
    # A instalação morta fica (com o app aberto ela ainda vê o chamado), sem o token.
    assert tokens == {str(morto): None, str(vivo): _token("vivo")}

    # Todos mortos: nenhum recebe push, mas os dois aparelhos veem o chamado aberto.
    async def todos_mortos(lote: list[dict]) -> httpx.Response:
        return _resposta(*(_erro("DeviceNotRegistered", m["to"]) for m in lote))

    expo.responder = todos_mortos
    corpo = await _chamar(client, auth_admin)
    assert (corpo["notificacao"], corpo["celulares"]) == ("SEM_NOTIFICACAO", 2)
    assert all(t is None for *_, t in await _aparelhos())


async def test_invalid_credentials_no_iphone_diz_sem_chave_da_apple(
    client, auth_admin, expo
) -> None:
    await _registrar(client, auth_admin, uuid.uuid4(), "ios", token=_token("iphone"))

    async def sem_chave(lote: list[dict]) -> httpx.Response:
        return _resposta(*(_erro("InvalidCredentials", m["to"]) for m in lote))

    expo.responder = sem_chave
    corpo = await _chamar(client, auth_admin)
    assert (corpo["notificacao"], corpo["celulares"]) == ("SEM_CHAVE_DA_APPLE", 0)
    # A credencial é de quem publica, não do aparelho: o token fica.
    assert (await _aparelhos())[0][3] == _token("iphone")

    # No Android a mesma recusa é outra credencial (a do FCM): não é a chave da Apple.
    await _sql("DELETE FROM notificacao_aparelhos")
    await _registrar(client, auth_admin, uuid.uuid4(), "android", token=_token("android"))
    corpo = await _chamar(client, auth_admin)
    assert (corpo["notificacao"], corpo["celulares"]) == ("FALHOU", 0)


async def test_token_nunca_aparece_no_log_nem_no_repr(
    client, auth_admin, expo, caplog, monkeypatch
) -> None:
    segredo = _token("segredo-do-aparelho")
    await _registrar(client, auth_admin, uuid.uuid4(), token=segredo)
    # O `fileConfig` do Alembic (as migrations do conftest) desliga os loggers já criados:
    # sem religar, o teste passaria sem nada ter sido logado.
    monkeypatch.setattr(push_da_expo.logger, "disabled", False)
    monkeypatch.setattr(notificacoes_service.logger, "disabled", False)
    caplog.set_level(logging.DEBUG)

    async def recusar(lote: list[dict]) -> httpx.Response:
        return _resposta(*(_erro("MessageRateExceeded", m["to"]) for m in lote))

    expo.responder = recusar
    assert (await _chamar(client, auth_admin))["notificacao"] == "FALHOU"

    async def cair_falando_o_token(lote: list[dict]) -> httpx.Response:
        raise httpx.ConnectError(f"conexão recusada ao mandar {lote[0]['to']}")

    expo.responder = cair_falando_o_token
    assert (await _chamar(client, auth_admin))["notificacao"] == "FALHOU"

    assert caplog.records, "o envio não logou nada — o teste não estaria provando nada"
    assert "segredo-do-aparelho" not in caplog.text

    mensagem = Mensagem(
        token=segredo, titulo="t", texto="x", dados={}, validade_s=300, plataforma="ios"
    )
    recibo = Recibo(token=segredo, plataforma="ios", situacao="ok")
    for objeto in (mensagem, recibo, AparelhoDeNotificacao(token=segredo, plataforma="ios")):
        assert "segredo-do-aparelho" not in repr(objeto)


async def test_nenhuma_rota_devolve_token_nem_instalacao(client, auth_admin, expo) -> None:
    segredo = _token("nunca-sai")
    instalacao = uuid.uuid4()
    respostas = [await _registrar(client, auth_admin, instalacao, token=segredo)]

    chamado = await client.post(
        "/leitor/chamados", headers=auth_admin, json={"client_uuid": str(uuid.uuid4())}
    )
    respostas.append(chamado)
    pid = chamado.json()["pareamento"]["id"]
    respostas.append(await client.get("/leitor/chamados/abertos", headers=auth_admin))
    respostas.append(
        await client.post(
            f"/leitor/chamados/{pid}/atender",
            headers=auth_admin,
            json={"instalacao": str(instalacao)},
        )
    )
    respostas.append(await client.get(f"/leitor/pareamentos/{pid}", headers=auth_admin))
    respostas.append(
        await client.post(
            "/leitor/bipes",
            headers=auth_admin,
            json={
                "client_uuid": str(uuid.uuid4()),
                "pareamento_id": pid,
                "codigo": "789",
                "instalacao": str(instalacao),
            },
        )
    )
    respostas.append(
        await client.post(f"/leitor/pareamentos/{pid}/retirar", headers=auth_admin)
    )
    respostas.append(
        await client.put(
            ROTA,
            headers=auth_admin,
            json={"instalacao": str(instalacao), "plataforma": "ios", "token": f"{segredo} x"},
        )
    )
    respostas.append(await client.get("/configuracao", headers=auth_admin))
    respostas.append(await client.delete(f"/leitor/pareamentos/{pid}", headers=auth_admin))
    respostas.append(await client.request("DELETE", ROTA, json={"instalacao": str(instalacao)}))

    assert [r.status_code for r in respostas] == [
        204, 201, 200, 200, 200, 201, 200, 422, 200, 204, 204
    ]
    for r in respostas:
        assert "nunca-sai" not in r.text, r.request.url
        assert str(instalacao) not in r.text, r.request.url


# ------------------------------------------------------------------ o fim do registro


async def test_trocar_a_senha_esquece_os_aparelhos(
    client, vendedor, auth_admin, auth_vendedor
) -> None:
    await _registrar(client, auth_vendedor, uuid.uuid4(), token=_token("da-ana"))
    await _registrar(client, auth_admin, uuid.uuid4(), token=_token("da-dona"))
    r = await client.patch(
        "/usuarios/me/senha",
        headers=auth_vendedor,
        json={"senha_atual": "senha1234", "nova_senha": "outra-senha-1"},
    )
    assert r.status_code == 204, r.text
    assert [t for *_, t in await _aparelhos()] == [_token("da-dona")]

    # Redefinida pelo dono, também: o celular que estava com o login sai junto.
    await _registrar(client, auth_vendedor, uuid.uuid4(), token=_token("da-ana-de-novo"))
    r = await client.patch(
        f"/usuarios/{vendedor.id}/senha", headers=auth_admin, json={"nova_senha": "outra-1234"}
    )
    assert r.status_code == 204, r.text
    assert [t for *_, t in await _aparelhos()] == [_token("da-dona")]


async def test_desativar_esquece_os_aparelhos(client, vendedor, auth_admin, auth_vendedor) -> None:
    await _registrar(client, auth_vendedor, uuid.uuid4(), token=_token("da-ana"))
    r = await client.patch(f"/usuarios/{vendedor.id}", headers=auth_admin, json={"ativo": False})
    assert r.status_code == 200, r.text
    assert await _aparelhos() == []
