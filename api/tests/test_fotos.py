"""Foto da peça: no disco (a loja de sempre) ou no Vercel Blob (ADR-42, "Fotos no Vercel Blob").

Nada aqui vai para a internet: `BlobFalso` faz o papel do Blob atrás de um
`httpx.MockTransport` e guarda o que recebeu — o que foi enviado, com que cabeçalhos, e o
que foi apagado. O invariante que importa: o store guarda exatamente a foto para a qual o
banco aponta (nem órfã, nem apagada debaixo da tela).

Na demonstração que sobe com a loja (ADR-46), o disco tem teto: o volume dela mora no disco do
banco da loja, e quem tem a senha da demo não pode enchê-lo.
"""

import asyncio
import errno
import json
import logging
import os
import subprocess
import sys
from pathlib import Path

import httpx
import pytest
from conftest import criar_produto
from fastapi import FastAPI
from httpx import AsyncClient
from pydantic import SecretStr
from sqlalchemy import text
from starlette import formparsers

from app.core.config import Settings, settings
from app.core.db import engine
from app.modules.catalogo import fotos
from app.modules.catalogo.fotos import (
    FotosDaDemonstracao,
    FotosNoBlob,
    FotosNoDisco,
    FotosSemLugar,
)

TOKEN = "vercel_blob_rw_LOJA123_segredo"
API = "https://blob.teste/api/blob"
LOJA = "https://loja123.public.blob.vercel-storage.com"
PASTA_API = Path(__file__).resolve().parents[1]
MB = 1024 * 1024

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
#: 64 KB cravados, múltiplo do bloco do disco: o que ocupa é o que mede.
FOTO_64K = PNG + b"\x00" * (64 * 1024 - len(PNG))
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


def _ligar_blob(monkeypatch: pytest.MonkeyPatch, falso: BlobFalso, pasta: str) -> None:
    monkeypatch.setattr(
        fotos,
        "fabrica",
        lambda: FotosNoBlob(
            TOKEN, pasta=pasta, base_url=API, transport=httpx.MockTransport(falso)
        ),
    )


@pytest.fixture
def blob(monkeypatch: pytest.MonkeyPatch) -> BlobFalso:
    falso = BlobFalso()
    monkeypatch.setattr(settings, "blob_read_write_token", SecretStr(TOKEN))
    monkeypatch.setattr(settings, "vercel", True)
    monkeypatch.setattr(settings, "vercel_env", "production")
    _ligar_blob(monkeypatch, falso, "produtos/production")
    return falso


@pytest.fixture
def disco(monkeypatch: pytest.MonkeyPatch, tmp_path):
    monkeypatch.setattr(settings, "blob_read_write_token", SecretStr(""))
    monkeypatch.setattr(settings, "vercel", False)
    monkeypatch.setattr(settings, "media_dir", str(tmp_path))
    return tmp_path


@pytest.fixture
def demo(monkeypatch: pytest.MonkeyPatch, disco):
    """A demonstração que sobe com a loja (ADR-46): o disco, com lugar para 3 fotos de 64 KB."""
    monkeypatch.setattr(settings, "demonstracao", True)
    monkeypatch.setattr(settings, "demo_fotos_max_bytes", 3 * len(FOTO_64K) + 1024)
    return disco


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


async def test_pasta_de_fotos_que_nao_se_cria_na_loja_nao_derruba_a_api_e_o_envio_diz_o_que_falta(
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
    # Na loja a conversa é a pasta de fotos dela, não a Vercel.
    assert "MEDIA_DIR" in resp.json()["message"]
    assert "Vercel" not in resp.text and "BLOB" not in resp.text
    assert await _foto_no_banco(produto["id"]) is None


async def test_na_loja_disco_cheio_responde_503_sem_falar_de_vercel_e_o_errno_vai_para_o_log(
    client, auth_admin, produto, disco, monkeypatch, caplog
) -> None:
    def disco_cheio(self, dados):
        raise OSError(errno.ENOSPC, "No space left on device")

    monkeypatch.setattr(Path, "write_bytes", disco_cheio)
    # O `fileConfig` do Alembic (as migrations do conftest) desliga os loggers já criados.
    monkeypatch.setattr(fotos.log, "disabled", False)
    with caplog.at_level(logging.ERROR, logger=fotos.__name__):
        resp = await _enviar(client, auth_admin, produto["id"])
    assert resp.status_code == 503
    corpo = resp.json()
    assert corpo["code"] == "FOTO_NAO_GUARDADA"
    assert corpo["detail"] == {"motivo": "disco"}
    assert "MEDIA_DIR" in corpo["message"] and "espaço" in corpo["message"]
    assert "Vercel" not in resp.text and "BLOB" not in resp.text
    assert "errno 28" in caplog.text
    assert await _foto_no_banco(produto["id"]) is None


# ------------------------------------------------------------------ demonstração (ADR-46)
def _fotos_na_pasta(media: Path) -> list[str]:
    return sorted(f.name for f in (media / "produtos").iterdir())


async def test_na_demonstracao_a_foto_que_passaria_do_teto_e_recusada(
    client, auth_admin, produto, demo
) -> None:
    """Quem tem a senha da demo (a Apple, quem o dono leva para conhecer o sistema) não enche
    o disco da loja: cabem três, a quarta é recusada com o código da demo e a de antes fica."""
    aceitas = [await _enviar(client, auth_admin, produto["id"], FOTO_64K) for _ in range(3)]
    assert [r.status_code for r in aceitas] == [200, 200, 200]
    na_tela = aceitas[-1].json()["foto_url"]

    resp = await _enviar(client, auth_admin, produto["id"], FOTO_64K)
    assert resp.status_code == 409, resp.text
    assert resp.json()["code"] == "DEMONSTRACAO_SEM_ESPACO"
    assert resp.json()["detail"] == {"limite_mb": 0.2}
    assert "madrugada" in resp.json()["message"]
    assert len(_fotos_na_pasta(demo)) == 3
    assert await _foto_no_banco(produto["id"]) == na_tela


async def test_na_demonstracao_envios_juntos_nao_furam_o_teto(
    client, auth_admin, produto, demo
) -> None:
    """Medir a pasta e gravar são um passo só: cinco envios ao mesmo tempo, lugar para três."""
    respostas = await asyncio.gather(
        *(_enviar(client, auth_admin, produto["id"], FOTO_64K) for _ in range(5))
    )
    assert sorted(r.status_code for r in respostas) == [200, 200, 200, 409, 409]
    assert len(_fotos_na_pasta(demo)) == 3


async def test_na_demonstracao_a_foto_minuscula_conta_o_bloco_que_ocupa(
    client, auth_admin, produto, demo, monkeypatch
) -> None:
    """Uma "foto" de 9 bytes (só a assinatura do PNG) ocupa um bloco inteiro: pelo tamanho,
    milhões delas passariam pelo teto enchendo o disco (e os inodes) do mesmo jeito."""
    minuscula = PNG[:8] + b"\x00"
    sonda = demo / "sonda"
    sonda.write_bytes(minuscula)
    bloco = sonda.stat().st_blocks * 512
    sonda.unlink()
    if bloco <= len(minuscula):
        pytest.skip("este disco guarda arquivo minúsculo sem bloco próprio")
    monkeypatch.setattr(settings, "demo_fotos_max_bytes", 2 * bloco + 100)

    codigos = [
        (await _enviar(client, auth_admin, produto["id"], minuscula)).status_code
        for _ in range(4)
    ]
    assert codigos == [200, 200, 200, 409]


async def test_fora_da_demonstracao_a_pasta_de_fotos_nao_tem_teto(
    client, auth_admin, produto, disco, monkeypatch
) -> None:
    """Na loja de verdade a variável, se vier, não vale: as fotos são da loja, e o disco dela
    é o dono quem cuida (o vigia avisa a partir de 90%)."""
    monkeypatch.setattr(settings, "demonstracao", False)
    monkeypatch.setattr(settings, "demo_fotos_max_bytes", len(FOTO_64K))
    respostas = [await _enviar(client, auth_admin, produto["id"], FOTO_64K) for _ in range(3)]
    assert [r.status_code for r in respostas] == [200, 200, 200]
    assert len(_fotos_na_pasta(disco)) == 3


def test_na_demonstracao_a_fabrica_escolhe_o_disco_com_teto(monkeypatch) -> None:
    for nome in ("BLOB_READ_WRITE_TOKEN", "VERCEL", "VERCEL_ENV", "DEMO_FOTOS_MAX_BYTES"):
        monkeypatch.delenv(nome, raising=False)
    monkeypatch.setenv("AMBIENTE", "test")
    monkeypatch.setenv("LOJA_DEMONSTRACAO", "1")

    def casa():
        return fotos._fabricar(Settings(_env_file=None))

    na_demo = casa()
    assert isinstance(na_demo, FotosDaDemonstracao)
    assert na_demo._teto == 200 * MB  # o padrão
    monkeypatch.setenv("BLOB_READ_WRITE_TOKEN", TOKEN)
    assert isinstance(casa(), FotosNoBlob)  # no Blob, nem teto nem pasta
    monkeypatch.delenv("BLOB_READ_WRITE_TOKEN")
    monkeypatch.delenv("LOJA_DEMONSTRACAO")
    assert type(casa()) is FotosNoDisco  # a loja: o disco de sempre, sem teto


def test_esvaziar_leva_as_fotos_e_deixa_as_pastas(tmp_path) -> None:
    """O que a renovação chama: só os arquivos da pasta de fotos saem."""
    casa = FotosDaDemonstracao(tmp_path, teto=MB)
    assert casa.esvaziar() == 0  # nem a pasta existe ainda
    (tmp_path / "produtos").mkdir()
    for nome in ("1-a.jpg", "2-b.png"):
        (tmp_path / "produtos" / nome).write_bytes(JPEG)
    (tmp_path / "leia-me.txt").write_text("fica")
    assert casa.esvaziar() == 2
    assert list((tmp_path / "produtos").iterdir()) == []
    assert (tmp_path / "leia-me.txt").read_text() == "fica"


def _ambiente_limpo(**extra: str) -> dict[str, str]:
    """O ambiente deste processo sem nada de Vercel nem de fotos, mais o que o teste pede."""
    env = {
        k: v
        for k, v in os.environ.items()
        if not k.startswith("VERCEL") and k not in {"BLOB_READ_WRITE_TOKEN", "MEDIA_DIR"}
    }
    # AMBIENTE escrito: na Vercel o padrão dele vira produção, que pede segredo de verdade.
    env.update(PYTHONPATH=str(PASTA_API), AMBIENTE="test", **extra)
    return env


#: Importa o app DE VERDADE (o `main.py`, com o que ele monta no import) e conta o que viu.
_IMPORTAR_MAIN = """
import asyncio, json
from app.main import app
from app.core.config import Settings
from app.modules.catalogo import fotos

casa = fotos.armazenamento()
visto = {
    "media": [r.path for r in app.routes if getattr(r, "path", "").startswith("/media")],
    "fotos_no_blob": Settings().fotos_no_blob,
    "casa": type(casa).__name__,
    "limite": fotos.limite_do_envio(),
}
if isinstance(casa, fotos.FotosSemLugar):  # o Blob nunca é chamado: nada vai para a rede
    try:
        asyncio.run(casa.gravar("1-prova.png", b"x", "image/png"))
    except fotos.FotoNaoGuardada as exc:
        visto["envio"] = [exc.http_status, exc.code, exc.detail]
print(json.dumps(visto))
"""


def _importar_main(env: dict[str, str]) -> dict:
    feito = subprocess.run(
        [sys.executable, "-c", _IMPORTAR_MAIN],
        cwd=PASTA_API,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert feito.returncode == 0, feito.stderr[-2000:]
    return json.loads(feito.stdout.strip().splitlines()[-1])


def test_main_com_blob_importa_sem_criar_pasta_nem_montar_media() -> None:
    """O `mkdir(MEDIA_DIR)` no import derrubava a função da Vercel (disco só leitura)."""
    pasta = "/proc/nao-pode/media"  # nem root cria pasta aqui: é o disco só leitura
    visto = _importar_main(_ambiente_limpo(BLOB_READ_WRITE_TOKEN=TOKEN, MEDIA_DIR=pasta))
    assert visto["media"] == []
    assert visto["fotos_no_blob"] is True
    assert visto["casa"] == "FotosNoBlob"
    assert not Path(pasta).exists()


def test_main_na_vercel_sem_blob_nao_monta_media_e_o_envio_responde_503(tmp_path) -> None:
    """O /tmp da função GRAVA (é por ele que a V1 aponta MEDIA_DIR), mas é de cada instância:
    a foto responderia 200 e sumiria. Quem decide é a variável VERCEL, não o mkdir."""
    pasta = tmp_path / "media"
    visto = _importar_main(
        _ambiente_limpo(VERCEL="1", VERCEL_ENV="production", MEDIA_DIR=str(pasta))
    )
    assert visto["media"] == []
    assert visto["casa"] == "FotosSemLugar"
    assert visto["envio"] == [503, "FOTO_NAO_GUARDADA", {"motivo": "sem_blob"}]
    assert visto["limite"] == 4 * MB
    assert not pasta.exists()


def test_main_na_loja_continua_montando_media_no_disco(tmp_path) -> None:
    pasta = tmp_path / "media"
    visto = _importar_main(_ambiente_limpo(MEDIA_DIR=str(pasta)))
    assert visto["media"] == ["/media"]
    assert visto["casa"] == "FotosNoDisco"
    assert visto["fotos_no_blob"] is False
    assert visto["limite"] == 5 * MB
    assert pasta.is_dir()


def test_a_fabrica_escolhe_pelas_variaveis_de_ambiente(monkeypatch) -> None:
    for nome in ("BLOB_READ_WRITE_TOKEN", "VERCEL", "VERCEL_ENV"):
        monkeypatch.delenv(nome, raising=False)
    # Escrito: na Vercel o padrão do AMBIENTE vira produção, que exige segredo de verdade.
    monkeypatch.setenv("AMBIENTE", "test")

    def casa():
        return fotos._fabricar(Settings(_env_file=None))

    assert isinstance(casa(), FotosNoDisco)
    monkeypatch.setenv("BLOB_READ_WRITE_TOKEN", "   ")
    assert isinstance(casa(), FotosNoDisco)
    monkeypatch.setenv("VERCEL", "1")
    assert isinstance(casa(), FotosSemLugar)  # na Vercel, token em branco é sem token
    monkeypatch.setenv("BLOB_READ_WRITE_TOKEN", TOKEN)
    assert isinstance(casa(), FotosNoBlob)
    monkeypatch.delenv("VERCEL")
    assert isinstance(casa(), FotosNoBlob)
    assert TOKEN not in repr(Settings(_env_file=None))


async def test_na_vercel_sem_blob_o_envio_responde_503_e_nada_fica_no_tmp(
    client, auth_admin, produto, monkeypatch, tmp_path
) -> None:
    monkeypatch.setattr(settings, "blob_read_write_token", SecretStr(""))
    monkeypatch.setattr(settings, "vercel", True)
    monkeypatch.setattr(settings, "media_dir", str(tmp_path / "media"))  # gravável
    app = FastAPI()
    fotos.servir_fotos_do_disco(app)
    assert _media(app) == []

    resp = await _enviar(client, auth_admin, produto["id"])
    assert resp.status_code == 503
    assert resp.json()["code"] == "FOTO_NAO_GUARDADA"
    assert resp.json()["detail"] == {"motivo": "sem_blob"}
    assert "Blob" in resp.json()["message"]
    assert list(tmp_path.iterdir()) == []
    assert await _foto_no_banco(produto["id"]) is None


# ------------------------------------------------------------------ Vercel Blob
async def test_no_blob_a_foto_sobe_publica_e_o_banco_guarda_a_url_absoluta(
    client, auth_admin, auth_vendedor, produto, blob
) -> None:
    # PNG com nome .jpg: o tipo gravado vem da assinatura, não da extensão de quem envia.
    resp = await _enviar(client, auth_admin, produto["id"], PNG, "foto.jpg")
    assert resp.status_code == 200, resp.text
    foto = resp.json()["foto_url"]
    assert foto.startswith(f"{LOJA}/produtos/production/{produto['id']}-")
    assert foto.endswith(".jpg")
    assert blob.guardados == {foto: PNG}

    envio = blob.envios[0]
    assert envio.url.params["pathname"].startswith(f"produtos/production/{produto['id']}-")
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


async def test_no_preview_trocar_a_foto_nao_apaga_a_da_producao(
    client, auth_admin, produto, blob, monkeypatch
) -> None:
    """Store ligado à Production e à Preview, e o banco do preview (branch do Neon) é cópia
    do de produção: a foto antiga é a que a loja está mostrando, e fica."""
    da_producao = f"{LOJA}/produtos/production/{produto['id']}-vitrine.png"
    blob.guardados[da_producao] = PNG
    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE products SET photo_url = :url WHERE id = :id"),
            {"url": da_producao, "id": produto["id"]},
        )
    _ligar_blob(monkeypatch, blob, "produtos/preview")

    nova = (await _enviar(client, auth_admin, produto["id"], JPEG, "n.jpg")).json()["foto_url"]
    assert nova.startswith(f"{LOJA}/produtos/preview/")
    assert blob.apagados == []
    assert blob.guardados[da_producao] == PNG
    # A do próprio preview, essa sim, sai na troca seguinte.
    outra = (await _enviar(client, auth_admin, produto["id"])).json()["foto_url"]
    assert blob.apagados == [nova]
    assert set(blob.guardados) == {da_producao, outra}


def test_a_pasta_no_blob_vem_do_ambiente_da_vercel() -> None:
    def pasta(ambiente: str) -> str:
        return fotos.pasta_no_blob(Settings(_env_file=None, vercel_env=ambiente))

    assert pasta("production") == "produtos/production"
    assert pasta("preview") == "produtos/preview"
    assert pasta("development") == "produtos/development"
    assert pasta("") == "produtos/local"
    assert pasta("../Pre view") == "produtos/preview"  # nada de sair da pasta


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


async def test_na_vercel_o_teto_e_4_mb_e_a_api_recusa_antes_do_413_da_funcao(
    client, auth_admin, produto, blob
) -> None:
    """A função da Vercel devolve 413 sem o JSON da API acima de 4,5 MB (doc: functions/
    limitations). Anunciar 5 MB deixava a foto entre 4,5 e 5 MB num erro que a tela não lê."""
    resp = await _enviar(client, auth_admin, produto["id"], PNG + b"\x00" * (4 * MB))
    assert resp.status_code == 422
    assert resp.json()["detail"] == {"limite_mb": 4.0}
    assert blob.envios == []
    cabe = await _enviar(client, auth_admin, produto["id"], PNG + b"\x00" * (4 * MB - 1024))
    assert cabe.status_code == 200, cabe.text


async def test_na_loja_o_teto_continua_5_mb(client, auth_admin, produto, disco) -> None:
    quatro_e_meio = PNG + b"\x00" * (4 * MB + MB // 2)
    assert (await _enviar(client, auth_admin, produto["id"], quatro_e_meio)).status_code == 200
    resp = await _enviar(client, auth_admin, produto["id"], PNG + b"\x00" * (5 * MB))
    assert resp.status_code == 422
    assert resp.json()["detail"] == {"limite_mb": 5.0}


def test_limite_do_envio_nunca_passa_do_que_o_dono_configurou() -> None:
    def limite(**campos) -> int:
        return fotos.limite_do_envio(Settings(_env_file=None, ambiente="test", **campos))

    assert limite() == 5 * MB
    assert limite(vercel=True) == 4 * MB
    assert limite(blob_read_write_token=TOKEN) == 4 * MB  # Blob sem VERCEL (variáveis de
    # sistema desligadas no painel): o corpo continua passando pela função
    assert limite(vercel=True, max_upload_bytes=MB) == MB
    assert limite(max_upload_bytes=8 * MB) == 8 * MB


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


# ------------------------------------------------------------------ o login antes do corpo
FRONTEIRA = "fronteira-do-envio"
FIM_DO_ENVIO = f"\r\n--{FRONTEIRA}--\r\n".encode()


def _comeco_do_envio(nome: str = "foto.png") -> bytes:
    return (
        f"--{FRONTEIRA}\r\n"
        f'Content-Disposition: form-data; name="arquivo"; filename="{nome}"\r\n'
        "Content-Type: image/png\r\n\r\n"
    ).encode()


def _pedido_de_foto(produto_id: int, partes: list[bytes], token: str | None = None) -> dict:
    """O escopo ASGI de um PUT .../foto, como o uvicorn o monta (ASGI 2.3)."""
    caminho = f"/api/v1/produtos/{produto_id}/foto"
    cabecalhos = [
        (b"host", b"test"),
        (b"content-type", f"multipart/form-data; boundary={FRONTEIRA}".encode()),
        (b"content-length", str(sum(map(len, partes))).encode()),
    ]
    if token:
        cabecalhos.append((b"authorization", f"Bearer {token}".encode()))
    return {
        "type": "http", "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1", "method": "PUT", "scheme": "http", "path": caminho,
        "raw_path": caminho.encode(), "root_path": "", "query_string": b"",
        "headers": cabecalhos, "client": ("127.0.0.1", 50000), "server": ("test", 80),
    }


class _QuemEnvia:
    """O outro lado da conexão: manda os cabeçalhos e só entrega o corpo depois de
    `liberado` — o celular lento, ou quem segura o envio de propósito. Conta os pedaços que
    a aplicação levou."""

    def __init__(self, partes: list[bytes], *, liberado: bool = False) -> None:
        self.partes = partes
        self.entregues = 0
        self.pediu = asyncio.Event()
        self.liberado = asyncio.Event()
        if liberado:
            self.liberado.set()
        self.mensagens: list[dict] = []

    async def receive(self) -> dict:
        self.pediu.set()
        await self.liberado.wait()
        if self.entregues < len(self.partes):
            self.entregues += 1
            return {
                "type": "http.request",
                "body": self.partes[self.entregues - 1],
                "more_body": self.entregues < len(self.partes),
            }
        await asyncio.Event().wait()  # depois do corpo, só a desconexão — que não vem
        raise AssertionError("inalcançável")

    async def send(self, mensagem: dict) -> None:
        self.mensagens.append(mensagem)

    @property
    def status(self) -> int | None:
        inicio = [m for m in self.mensagens if m["type"] == "http.response.start"]
        return inicio[0]["status"] if inicio else None

    def json(self) -> dict:
        corpo = b"".join(
            m.get("body", b"") for m in self.mensagens if m["type"] == "http.response.body"
        )
        return json.loads(corpo)


async def test_envio_sem_login_responde_401_sem_ler_o_corpo(monkeypatch) -> None:
    """O FastAPI lia o multipart inteiro ANTES das dependências — e o Starlette gravava o
    arquivo num temporário: um PUT de 10 MB sem login ocupava o disco até sair o 401, e um
    envio segurado de propósito prendia a requisição esperando o resto. Agora o crachá vem
    primeiro: o 401 sai sem esperar o corpo e sem montar o multipart."""
    from app.main import app as aplicacao

    temporarios: list[int] = []
    original = formparsers.SpooledTemporaryFile

    def contar_temporario(*args, **kwargs):
        temporarios.append(1)
        return original(*args, **kwargs)

    monkeypatch.setattr(formparsers, "SpooledTemporaryFile", contar_temporario)
    partes = [_comeco_do_envio(), *[PNG + b"\x00" * (64 * 1024)] * 160, FIM_DO_ENVIO]  # ~10 MB

    # Quem envia segura o corpo: o 401 sai assim mesmo, sem um pedaço lido.
    segurando = _QuemEnvia(partes)
    try:
        await asyncio.wait_for(
            aplicacao(_pedido_de_foto(1, partes), segurando.receive, segurando.send), timeout=10
        )
    except TimeoutError:
        pytest.fail("a API ficou esperando o corpo do envio antes de conferir o login")
    assert segurando.status == 401
    assert segurando.json()["code"] == "TOKEN_INVALIDO"
    assert segurando.entregues == 0

    # O corpo inteiro à disposição: 401, e nenhum temporário — o multipart nem foi montado.
    inteiro = _QuemEnvia(partes, liberado=True)
    await asyncio.wait_for(
        aplicacao(_pedido_de_foto(1, partes), inteiro.receive, inteiro.send), timeout=30
    )
    assert inteiro.status == 401
    assert temporarios == []


async def test_com_login_o_corpo_e_lido_depois_sem_conexao_presa(
    client, auth_admin, produto, disco
) -> None:
    """Quem entrou envia normalmente. E, enquanto o celular manda a foto, a requisição não
    segura conexão do pool nem a transação aberta pelo login (com a trava de leitura de
    `users`, a que o TRUNCATE da renovação da demo espera)."""
    from app.main import app as aplicacao

    token = auth_admin["Authorization"].removeprefix("Bearer ")
    partes = [_comeco_do_envio("peca.png"), PNG, FIM_DO_ENVIO]
    quem = _QuemEnvia(partes)
    pool = engine.sync_engine.pool
    antes = pool.checkedout()
    pedido = asyncio.create_task(
        aplicacao(_pedido_de_foto(produto["id"], partes, token), quem.receive, quem.send)
    )
    try:
        await asyncio.wait_for(quem.pediu.wait(), timeout=10)
        assert quem.status is None  # passou do login e espera o corpo
        assert pool.checkedout() == antes, "a leitura do envio segurou uma conexão do banco"
        quem.liberado.set()
        await asyncio.wait_for(pedido, timeout=30)
    finally:
        pedido.cancel()
    assert quem.status == 200, quem.mensagens
    assert quem.json()["foto_url"].startswith(f"/media/produtos/{produto['id']}-")
    assert (await _foto_no_banco(produto["id"])) == quem.json()["foto_url"]

    # E o caminho de sempre (httpx), com a validação de sempre.
    assert (await _enviar(client, auth_admin, produto["id"], JPEG, "x.jpg")).status_code == 200
    sem_arquivo = await client.put(
        f"/produtos/{produto['id']}/foto", headers=auth_admin,
        files={"foto": ("x.png", PNG, "image/png")},
    )
    assert sem_arquivo.status_code == 422
    assert sem_arquivo.json()["detail"]["campos"] == [
        {"campo": "arquivo", "erro": "Field required"}
    ]


def test_a_documentacao_do_envio_continua_com_o_campo_arquivo() -> None:
    """A rota lê o multipart ela mesma (depois do login); a documentação continua dizendo o
    que enviar."""
    from app.main import app as aplicacao

    esquema_todo = aplicacao.openapi()
    corpo = esquema_todo["paths"]["/api/v1/produtos/{produto_id}/foto"]["put"]["requestBody"]
    assert corpo["required"] is True
    esquema = corpo["content"]["multipart/form-data"]["schema"]
    if "$ref" in esquema:
        esquema = esquema_todo["components"]["schemas"][esquema["$ref"].rsplit("/", 1)[1]]
    assert esquema["required"] == ["arquivo"]
    assert esquema["properties"]["arquivo"]["type"] == "string"
