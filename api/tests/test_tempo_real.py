"""O canal de tempo real: quem entra, quem não entra, e o que chega.

O caso que motivou tudo está em `test_produto_novo_avisa_o_catalogo`: alguém cadastra uma
peça no computador do balcão e o celular da vendedora precisa saber, sem fechar e abrir o
app.
"""

import uuid

import pytest
from fastapi.testclient import TestClient

from app.core.eventos import Assunto, central
from app.main import app

pytestmark = pytest.mark.anyio

CODIGO_NAO_AUTENTICADO = 4401


def _entrar(ws, token: str) -> dict:
    ws.send_json({"tipo": "entrar", "token": token})
    return ws.receive_json()


def _token(auth: dict[str, str]) -> str:
    return auth["Authorization"].removeprefix("Bearer ")


# ------------------------------------------------------------------ quem entra


class FalsoWebSocket:
    """Só o suficiente para exercitar `_autenticar`.

    O `TestClient` roda num loop próprio, numa thread separada, e o asyncpg guarda as
    conexões do pool amarradas ao loop que as criou — misturar os dois dá
    "attached to a different loop" (a armadilha que o CLAUDE.md já registra). Os testes
    que passam pelo transporte de verdade são os de recusa, que nem chegam ao banco;
    para o caminho feliz, que consulta o usuário, o proveito de subir um servidor inteiro
    não paga a complicação: quem decide é `_autenticar`, e é ela que está aqui.
    """

    def __init__(self, primeira: object) -> None:
        self._primeira = primeira
        self.fechado: tuple[int, str] | None = None
        from starlette.websockets import WebSocketState

        self.client_state = WebSocketState.CONNECTED

    async def receive_json(self) -> object:
        return self._primeira

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.fechado = (code, reason)


async def test_token_valido_identifica_o_usuario(vendedor, auth_vendedor) -> None:
    from app.modules.tempo_real.router import _autenticar

    falso = FalsoWebSocket({"tipo": "entrar", "token": _token(auth_vendedor)})
    usuario = await _autenticar(falso)  # type: ignore[arg-type]
    assert usuario is not None
    assert usuario.id == vendedor.id
    assert falso.fechado is None


async def test_usuario_desativado_nao_entra(session, vendedor, auth_vendedor) -> None:
    """Desligar alguém precisa cortar também o canal aberto, não só as rotas REST."""
    from app.modules.tempo_real.router import CODIGO_NAO_AUTENTICADO, _autenticar

    vendedor.is_active = False
    session.add(vendedor)
    await session.commit()

    falso = FalsoWebSocket({"tipo": "entrar", "token": _token(auth_vendedor)})
    assert await _autenticar(falso) is None  # type: ignore[arg-type]
    assert falso.fechado is not None and falso.fechado[0] == CODIGO_NAO_AUTENTICADO


def test_token_invalido_e_recusado() -> None:
    from starlette.websockets import WebSocketDisconnect

    with TestClient(app) as cliente:
        with pytest.raises(WebSocketDisconnect) as erro:
            with cliente.websocket_connect("/api/v1/tempo-real") as ws:
                _entrar(ws, "isto-nao-e-um-token")
        assert erro.value.code == CODIGO_NAO_AUTENTICADO


def test_primeira_mensagem_precisa_ser_entrar(auth_admin: dict[str, str]) -> None:
    """Conexão que já chega mandando outra coisa não vira um ouvinte anônimo."""
    from starlette.websockets import WebSocketDisconnect

    with TestClient(app) as cliente:
        with pytest.raises(WebSocketDisconnect) as erro:
            with cliente.websocket_connect("/api/v1/tempo-real") as ws:
                ws.send_json({"tipo": "oi"})
                ws.receive_json()
        assert erro.value.code == CODIGO_NAO_AUTENTICADO


def test_a_porta_abre_sem_token_na_url() -> None:
    """O crachá vem no primeiro quadro, não na URL.

    É o ponto do desenho: token em query string entra no log de acesso do servidor, no
    log do proxy e no histórico de todo intermediário do caminho. Aqui a conexão é aceita
    sem parâmetro nenhum e só depois exige identificação — o teste de recusa acima prova
    a outra metade.
    """
    from starlette.websockets import WebSocketDisconnect

    with TestClient(app) as cliente:
        with pytest.raises(WebSocketDisconnect):
            with cliente.websocket_connect("/api/v1/tempo-real") as ws:
                # Aceitou a conexão (chegamos aqui) e agora recusa por falta de token.
                ws.send_json({"tipo": "entrar", "token": ""})
                ws.receive_json()


# ------------------------------------------------------------------ o que chega


async def test_publicar_chega_em_todos_os_ouvintes() -> None:
    async with central.inscrever() as um, central.inscrever() as outro:
        central.publicar(Assunto.ESTOQUE, variante_id=7)
        assert (await um.get()).assunto is Assunto.ESTOQUE
        evento = await outro.get()
        assert evento.dados == {"variante_id": 7}


async def test_ouvinte_que_sai_para_de_receber() -> None:
    async with central.inscrever() as fila:
        assert central.ouvintes == 1
    assert central.ouvintes == 0
    # Publicar sem ninguém ouvindo não pode explodir: acontece a noite inteira.
    central.publicar(Assunto.VENDAS)
    assert fila.empty()


async def test_ouvinte_lento_perde_aviso_mas_nao_derruba_o_servidor() -> None:
    """Celular com rede ruim não pode segurar memória do servidor da loja."""
    from app.core.eventos import FILA_MAXIMA

    async with central.inscrever() as fila:
        for _ in range(FILA_MAXIMA + 10):
            central.publicar(Assunto.ESTOQUE)
        assert fila.qsize() == FILA_MAXIMA


# ------------------------------------------- o caminho todo: escrita → aviso


async def test_produto_novo_avisa_o_catalogo(client, auth_admin) -> None:
    """O caso que motivou o recurso, ponta a ponta.

    Ninguém chama `publicar()` no service de catálogo: quem avisa é o commit do
    SQLAlchemy. Este teste é o que garante que a ligação continua de pé — se alguém
    mexer no registro dos eventos, aqui estoura.
    """
    async with central.inscrever() as fila:
        categoria = await client.post("/categorias", headers=auth_admin, json={"nome": "Blusas"})
        assert categoria.status_code == 201

        criado = await client.post(
            "/produtos",
            headers=auth_admin,
            json={
                "categoria_id": categoria.json()["id"],
                "nome": "Blusa Nova",
                "variantes": [
                    {
                        "tamanho": "M",
                        "cor": "Preta",
                        "preco_custo": "20.00",
                        "preco_venda": "69.90",
                        "estoque_inicial": 3,
                    }
                ],
            },
        )
        assert criado.status_code == 201

        recebidos = set()
        while not fila.empty():
            recebidos.add((await fila.get()).assunto)

    assert Assunto.CATALOGO in recebidos, "o celular não saberia da peça nova"
    # Estoque inicial é movimento de estoque: quem está na tela de saldos também precisa.
    assert Assunto.ESTOQUE in recebidos


async def test_venda_avisa_estoque_e_vendas(client, auth_admin) -> None:
    categoria = await client.post("/categorias", headers=auth_admin, json={"nome": "Calças"})
    produto = await client.post(
        "/produtos",
        headers=auth_admin,
        json={
            "categoria_id": categoria.json()["id"],
            "nome": "Calça Jeans",
            "variantes": [
                {
                    "tamanho": "40",
                    "cor": "Azul",
                    "preco_custo": "60.00",
                    "preco_venda": "159.90",
                    "estoque_inicial": 5,
                }
            ],
        },
    )
    variante_id = produto.json()["variantes"][0]["id"]

    async with central.inscrever() as fila:
        venda = await client.post(
            "/vendas",
            headers=auth_admin,
            json={
                "client_uuid": str(uuid.uuid4()),
                "itens": [{"variante_id": variante_id, "quantidade": 1}],
                "pagamentos": [{"forma": "DINHEIRO", "valor": "159.90"}],
            },
        )
        assert venda.status_code == 201

        recebidos = set()
        while not fila.empty():
            recebidos.add((await fila.get()).assunto)

    assert Assunto.VENDAS in recebidos
    assert Assunto.ESTOQUE in recebidos, "a outra vendedora continuaria vendo o saldo antigo"


async def test_leitura_nao_gera_aviso(client, auth_admin) -> None:
    """Só escrita avisa. Se um GET publicasse, cada tela mandaria todas as outras
    recarregarem, e a loja entraria numa avalanche de recargas."""
    async with central.inscrever() as fila:
        assert (await client.get("/produtos", headers=auth_admin)).status_code == 200
        assert (await client.get("/estoque/saldos", headers=auth_admin)).status_code == 200
        assert fila.empty()
