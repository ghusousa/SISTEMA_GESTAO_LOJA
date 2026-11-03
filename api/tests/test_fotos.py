"""Foto da peça: no disco (a loja de sempre) ou no Vercel Blob (ADR-42, "Fotos no Vercel Blob").

Nada aqui vai para a internet: `BlobFalso` faz o papel do Blob atrás de um
`httpx.MockTransport` e guarda o que recebeu — o que foi enviado, com que cabeçalhos, e o
que foi apagado. O invariante que importa: o store guarda exatamente a foto para a qual o
banco aponta (nem órfã, nem apagada debaixo da tela).
"""

import asyncio
import json

import httpx
import pytest
from conftest import criar_produto
from fastapi import FastAPI
from httpx import AsyncClient
from pydantic import SecretStr
from sqlalchemy import text

from app.core.config import settings
from app.core.db import engine
from app.modules.catalogo import fotos
from app.modules.catalogo.fotos import FotosNoBlob, FotosNoDisco

TOKEN = "vercel_blob_rw_LOJA123_segredo"
API = "https://blob.teste/api/blob"
LOJA = "https://loja123.public.blob.vercel-storage.com"

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64
WEBP = b"RIFF\x00\x00\x00\x00WEBPVP8 " + b"\x00" * 64


class BlobFalso:
    """O Blob público de mentira: PUT ?pathname= guarda, POST /delete apaga."""

    def __init__(self) -> None:
        self.guardados: dict[str, bytes] = {}
        self.envios: list[httpx.Request] = []
        self.apagados: list[str] = []
        self.fora_do_ar = False
        self.status_do_envio = 200
        self.status_do_apagar = 200
        self.url_privada = False
        self.durante_o_envio = None  # corrotina chamada no meio do PUT

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        if self.fora_do_ar:
            raise httpx.ConnectError("sem rede", request=request)
        assert request.headers["authorization"] == f"Bearer {TOKEN}"
        assert request.headers["x-api-version"] == "12"
        if request.method == "PUT":
            return await self._enviar(request)
        if request.method == "POST" and request.url.path.endswith("/delete"):
            urls = json.loads(request.content)["urls"]
            if self.status_do_apagar != 200:
                return httpx.Response(self.status_do_apagar, json={"error": "falhou"})
            for url in urls:
                self.apagados.append(url)
                self.guardados.pop(url, None)
            return httpx.Response(200)
        return httpx.Response(404)

    async def _enviar(self, request: httpx.Request) -> httpx.Response:
        self.envios.append(request)
        if self.durante_o_envio is not None:
            await self.durante_o_envio()
        await asyncio.sleep(0.01)  # deixa outra troca entrar no meio
        if self.status_do_envio != 200:
            return httpx.Response(
                self.status_do_envio, json={"error": {"message": "store_LOJA123 suspenso"}}
            )
        caminho = request.url.params["pathname"]
        base = LOJA.replace(".public.", ".private.") if self.url_privada else LOJA
        url = f"{base}/{caminho}"
        self.guardados[url] = request.content
        return httpx.Response(
            200,
            json={
                "url": url,
                "downloadUrl": f"{url}?download=1",
                "pathname": caminho,
                "contentType": request.headers["x-content-type"],
                "contentDisposition": "inline",
                "etag": '"abc"',
            },
        )


@pytest.fixture
def blob(monkeypatch: pytest.MonkeyPatch) -> BlobFalso:
    falso = BlobFalso()
    monkeypatch.setattr(settings, "blob_read_write_token", SecretStr(TOKEN))
    monkeypatch.setattr(
        fotos,
        "fabrica",
        lambda: FotosNoBlob(TOKEN, base_url=API, transport=httpx.MockTransport(falso)),
    )
    return falso


@pytest.fixture
def disco(monkeypatch: pytest.MonkeyPatch, tmp_path):
    monkeypatch.setattr(settings, "blob_read_write_token", SecretStr(""))
    monkeypatch.setattr(settings, "media_dir", str(tmp_path))
    return tmp_path


@pytest.fixture
async def produto(client: AsyncClient, auth_admin: dict[str, str]) -> dict:
    categoria = (
        await client.post("/categorias", headers=auth_admin, json={"nome": "Vestidos"})
    ).json()["id"]
    return await criar_produto(
        client,
        auth_admin,
        {
            "categoria_id": categoria,
            "nome": "Vestido Midi",
            "variantes": [
                {"tamanho": "M", "cor": "Azul", "codigo_barras": "7891234567895",
                 "preco_custo": "40.00", "preco_venda": "129.90"},
            ],
        },
    )


async def _enviar(client, auth, produto_id, conteudo=PNG, nome="foto.png"):
    return await client.put(
        f"/produtos/{produto_id}/foto",
        headers=auth,
        files={"arquivo": (nome, conteudo, "application/octet-stream")},
    )


def _media(app: FastAPI) -> list[str]:
    return [r.path for r in app.routes if r.path.startswith("/media")]


async def _foto_no_banco(produto_id: int) -> str | None:
    async with engine.connect() as conn:
        return await conn.scalar(
            text("SELECT photo_url FROM products WHERE id = :id"), {"id": produto_id}
        )


# ------------------------------------------------------------------ disco (padrão)
async def test_sem_token_do_blob_a_foto_vai_para_o_disco_com_caminho_relativo(
    client, auth_admin, produto, disco
) -> None:
    assert not settings.fotos_no_blob
    resp = await _enviar(client, auth_admin, produto["id"], JPEG, "peca.JPG")
    assert resp.status_code == 200, resp.text
    foto = resp.json()["foto_url"]
    assert foto.startswith(f"/media/produtos/{produto['id']}-") and foto.endswith(".jpg")
    arquivo = disco / "produtos" / foto.rsplit("/", 1)[1]
    assert arquivo.read_bytes() == JPEG


async def test_no_disco_trocar_a_foto_nao_apaga_a_antiga(
    client, auth_admin, produto, disco
) -> None:
    """Comportamento de sempre: o backup do banco e a pasta de fotos são cópias separadas, e
    o banco restaurado da semana passada aponta para a foto de antes."""
    primeira = (await _enviar(client, auth_admin, produto["id"])).json()["foto_url"]
    segunda = (await _enviar(client, auth_admin, produto["id"], WEBP, "x.webp")).json()["foto_url"]
    assert primeira != segunda
    assert (disco / "produtos" / primeira.rsplit("/", 1)[1]).exists()
    assert (disco / "produtos" / segunda.rsplit("/", 1)[1]).exists()


def test_no_disco_monta_media_e_cria_a_pasta(disco) -> None:
    pasta = disco / "fotos"
    settings.media_dir = str(pasta)
    app = FastAPI()
    fotos.servir_fotos_do_disco(app)
    assert pasta.is_dir()
    assert _media(app) == ["/media"]


def test_com_blob_nao_cria_pasta_nem_monta_media(blob, monkeypatch, tmp_path) -> None:
    """O disco da Vercel é só leitura: o `mkdir` no import derrubava a função inteira."""
    pasta = tmp_path / "nao-criar"
    monkeypatch.setattr(settings, "media_dir", str(pasta))
    app = FastAPI()
    fotos.servir_fotos_do_disco(app)
    assert not pasta.exists()
    assert _media(app) == []


async def test_disco_so_leitura_sem_blob_nao_derruba_a_api_e_o_envio_diz_o_que_falta(
    client, auth_admin, produto, disco
) -> None:
    (disco / "arquivo").write_text("não é pasta")
    settings.media_dir = str(disco / "arquivo" / "media")  # mkdir aqui é OSError
    app = FastAPI()
    fotos.servir_fotos_do_disco(app)  # não levanta
    assert _media(app) == []

    resp = await _enviar(client, auth_admin, produto["id"])
    assert resp.status_code == 503
    assert resp.json()["code"] == "FOTO_NAO_GUARDADA"
    assert "BLOB_READ_WRITE_TOKEN" in resp.json()["message"]
    assert await _foto_no_banco(produto["id"]) is None


def test_a_fabrica_escolhe_pela_variavel_de_ambiente(monkeypatch) -> None:
    monkeypatch.setattr(settings, "blob_read_write_token", SecretStr(""))
    assert isinstance(fotos._fabricar(), FotosNoDisco)
    monkeypatch.setattr(settings, "blob_read_write_token", SecretStr("   "))
    assert isinstance(fotos._fabricar(), FotosNoDisco)
    monkeypatch.setattr(settings, "blob_read_write_token", SecretStr(TOKEN))
    assert isinstance(fotos._fabricar(), FotosNoBlob)
    assert TOKEN not in repr(settings)


# ------------------------------------------------------------------ Vercel Blob
async def test_no_blob_a_foto_sobe_publica_e_o_banco_guarda_a_url_absoluta(
    client, auth_admin, auth_vendedor, produto, blob
) -> None:
    # PNG com nome .jpg: o tipo gravado vem da assinatura, não da extensão de quem envia.
    resp = await _enviar(client, auth_admin, produto["id"], PNG, "foto.jpg")
    assert resp.status_code == 200, resp.text
    foto = resp.json()["foto_url"]
    assert foto.startswith(f"{LOJA}/produtos/{produto['id']}-") and foto.endswith(".jpg")
    assert blob.guardados == {foto: PNG}

    envio = blob.envios[0]
    assert envio.url.params["pathname"].startswith(f"produtos/{produto['id']}-")
    assert envio.headers["x-vercel-blob-access"] == "public"
    assert envio.headers["x-content-type"] == "image/png"
    assert envio.headers["x-allow-overwrite"] == "0"

    assert await _foto_no_banco(produto["id"]) == foto
    # Quem lê a foto recebe a URL absoluta como está: o detalhe, a lista e o bipe do PDV.
    detalhe = await client.get(f"/produtos/{produto['id']}", headers=auth_vendedor)
    assert detalhe.json()["foto_url"] == foto
    lista = await client.get("/produtos", headers=auth_vendedor)
    assert lista.json()["items"][0]["foto_url"] == foto
    bipe = await client.get("/variantes/codigo-barras/7891234567895", headers=auth_vendedor)
    assert bipe.json()["foto_url"] == foto


async def test_no_blob_trocar_a_foto_apaga_a_antiga(client, auth_admin, produto, blob) -> None:
    primeira = (await _enviar(client, auth_admin, produto["id"])).json()["foto_url"]
    segunda = (await _enviar(client, auth_admin, produto["id"], JPEG, "b.jpeg")).json()["foto_url"]
    assert primeira != segunda
    assert blob.apagados == [primeira]
    assert blob.guardados == {segunda: JPEG}


async def test_foto_antiga_do_disco_nao_e_mandada_apagar_no_blob(
    client, auth_admin, produto, blob
) -> None:
    """Banco que veio de uma loja local (`/media/...`): o caminho não é do Blob."""
    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE products SET photo_url = '/media/produtos/velha.jpg' WHERE id = :id"),
            {"id": produto["id"]},
        )
    resp = await _enviar(client, auth_admin, produto["id"])
    assert resp.status_code == 200
    assert blob.apagados == []


async def test_blob_fora_do_ar_responde_503_e_a_foto_de_antes_fica(
    client, auth_admin, produto, blob
) -> None:
    antes = (await _enviar(client, auth_admin, produto["id"])).json()["foto_url"]
    blob.fora_do_ar = True
    resp = await _enviar(client, auth_admin, produto["id"], JPEG, "nova.jpg")
    assert resp.status_code == 503
    assert resp.json()["code"] == "FOTO_NAO_GUARDADA"
    assert await _foto_no_banco(produto["id"]) == antes
    assert antes in blob.guardados


async def test_blob_que_recusa_responde_503_sem_mostrar_o_erro_dele(
    client, auth_admin, produto, blob
) -> None:
    blob.status_do_envio = 403
    resp = await _enviar(client, auth_admin, produto["id"])
    assert resp.status_code == 503
    assert resp.json()["detail"] == {"motivo": "recusada", "status": 403}
    assert "store_LOJA123" not in resp.text
    assert TOKEN not in resp.text
    assert await _foto_no_banco(produto["id"]) is None


async def test_store_privado_e_recusado_em_vez_de_gravar_foto_que_nao_abre(
    client, auth_admin, produto, blob
) -> None:
    blob.url_privada = True
    resp = await _enviar(client, auth_admin, produto["id"])
    assert resp.status_code == 503
    assert resp.json()["detail"]["motivo"] == "store_nao_publico"
    assert await _foto_no_banco(produto["id"]) is None


async def test_falha_ao_apagar_a_antiga_nao_desfaz_a_troca(
    client, auth_admin, produto, blob
) -> None:
    await _enviar(client, auth_admin, produto["id"])
    blob.status_do_apagar = 500
    resp = await _enviar(client, auth_admin, produto["id"], JPEG, "nova.jpg")
    assert resp.status_code == 200
    assert await _foto_no_banco(produto["id"]) == resp.json()["foto_url"]


async def test_produto_excluido_enquanto_a_foto_subia_apaga_a_que_subiu(
    client, auth_admin, produto, blob
) -> None:
    async def excluir_no_meio() -> None:
        async with engine.begin() as conn:
            await conn.execute(
                text("UPDATE products SET deleted_at = now() WHERE id = :id"),
                {"id": produto["id"]},
            )

    blob.durante_o_envio = excluir_no_meio
    resp = await _enviar(client, auth_admin, produto["id"])
    assert resp.status_code == 404
    assert blob.guardados == {}  # a que subiu foi apagada: ninguém aponta para ela
    assert await _foto_no_banco(produto["id"]) is None


async def test_duas_trocas_ao_mesmo_tempo_nao_deixam_foto_orfa_no_blob(
    client, auth_admin, produto, blob
) -> None:
    await _enviar(client, auth_admin, produto["id"])
    respostas = await asyncio.gather(
        *(_enviar(client, auth_admin, produto["id"], JPEG, f"{i}.jpg") for i in range(3))
    )
    assert all(r.status_code == 200 for r in respostas)
    assert set(blob.guardados) == {await _foto_no_banco(produto["id"])}


@pytest.mark.parametrize(
    ("nome", "conteudo", "status"),
    [
        ("x.png", b"<html><script>alert(1)</script></html>", 422),  # HTML disfarçado
        ("x.gif", b"GIF89a" + b"\x00" * 16, 422),  # extensão fora da lista
        ("x.webp", b"RIFF\x00\x00\x00\x00WAVEfmt ", 422),  # RIFF que não é WebP
    ],
)
async def test_validacao_do_envio_continua_igual_com_blob(
    client, auth_admin, produto, blob, nome, conteudo, status
) -> None:
    resp = await _enviar(client, auth_admin, produto["id"], conteudo, nome)
    assert resp.status_code == status
    assert blob.envios == []  # recusado antes de qualquer byte sair para o Blob


async def test_foto_grande_demais_nao_sai_para_o_blob(
    client, auth_admin, produto, blob, monkeypatch
) -> None:
    monkeypatch.setattr(settings, "max_upload_bytes", 1024)
    resp = await _enviar(client, auth_admin, produto["id"], PNG + b"\x00" * 2048)
    assert resp.status_code == 422
    assert blob.envios == []


async def test_foto_de_produto_inexistente_e_404_sem_enviar_nada(
    client, auth_admin, blob
) -> None:
    resp = await _enviar(client, auth_admin, 999_999)
    assert resp.status_code == 404
    assert blob.envios == []


def test_url_do_blob_so_vale_https_no_dominio_de_entrega() -> None:
    assert fotos.eh_url_do_blob(f"{LOJA}/produtos/1-a.jpg", so_publica=True)
    privada = "https://x.private.blob.vercel-storage.com/a.jpg"
    assert fotos.eh_url_do_blob(privada)
    assert not fotos.eh_url_do_blob(privada, so_publica=True)
    assert not fotos.eh_url_do_blob("/media/produtos/1-a.jpg")
    assert not fotos.eh_url_do_blob("http://loja123.public.blob.vercel-storage.com/a.jpg")
    assert not fotos.eh_url_do_blob("https://blob.vercel-storage.com.atacante.com/a.jpg")
    assert not fotos.eh_url_do_blob(f"{LOJA}/")
