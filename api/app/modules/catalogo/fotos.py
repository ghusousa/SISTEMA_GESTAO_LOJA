"""Onde a foto da peça mora (ADR-42, "Fotos no Vercel Blob").

Duas casas, escolhidas só pelo ambiente — a tela e o banco não sabem qual está ligada:

- **Disco** (padrão, a loja de sempre): `MEDIA_DIR/produtos`, servido pela própria API em
  `/media`. O banco guarda o caminho RELATIVO `/media/produtos/<nome>`, e quem mostra a foto
  completa o endereço com o servidor de onde a tela veio.
- **Vercel Blob** (com `BLOB_READ_WRITE_TOKEN` no ambiente): o disco da função é só leitura e
  não sobrevive à instância, então a foto vai para um store PÚBLICO e o banco guarda a URL
  ABSOLUTA que o Blob devolveu (`https://<store>.public.blob.vercel-storage.com/...`). Foto de
  peça é vitrine, não dado pessoal: público é o lugar dela. A URL vem da resposta do Blob,
  nunca do header Host — a mesma regra que fez o disco gravar caminho relativo.

O cliente do Blob é `httpx` direto, nas duas chamadas de que a loja precisa (enviar e apagar),
espelhando o que o SDK Python oficial (`vercel-blob` 0.5.1, `_internal/api_client.py`) manda:
o SDK puxaria quatro pacotes novos (`vercel-blob`, `vercel-internal-core`, `vercel-oidc`,
`vercel-headers`; o guarda-chuva `vercel` puxa ainda sandbox, workflow, fila e websockets),
todos 0.x, e roda sobre `httpx2` — onde o `httpx.MockTransport` dos testes não entra.
"""

import logging
from pathlib import Path
from typing import Protocol
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI, status
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from app.core.config import settings
from app.core.exceptions import AppError

log = logging.getLogger(__name__)

#: Endereço da API do Blob, o mesmo padrão do SDK oficial (`VERCEL_BLOB_API_URL` o troca).
API_BLOB = "https://vercel.com/api/blob"
#: Versão do protocolo que o SDK oficial 0.5.1 anuncia em toda chamada.
VERSAO_API_BLOB = "12"
#: Foto de até MAX_UPLOAD_BYTES (5 MB). Passou disso, a rede está ruim demais para esperar.
TIMEOUT_S = 20.0
#: Domínio de entrega do Blob. Só URL daqui é apagada, e só URL PÚBLICA daqui é gravada.
DOMINIO_BLOB = ".blob.vercel-storage.com"
DOMINIO_BLOB_PUBLICO = ".public" + DOMINIO_BLOB


class FotoNaoGuardada(AppError):
    code = "FOTO_NAO_GUARDADA"
    http_status = status.HTTP_503_SERVICE_UNAVAILABLE
    message = "Não deu para guardar a foto agora. Tente de novo em instantes."


# ------------------------------------------------------------------ o que é imagem
def tipo_da_imagem(conteudo: bytes) -> str | None:
    """O tipo pela ASSINATURA do arquivo, não pela extensão (que quem envia escolhe).

    JPEG, PNG e WebP (RIFF com "WEBP" no oitavo byte); qualquer outra coisa é None. É o
    `Content-Type` que o Blob grava, e a mesma régua que o upload sempre usou para recusar
    um HTML disfarçado de foto.
    """
    if conteudo.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if conteudo.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if conteudo.startswith(b"RIFF") and conteudo[8:12] == b"WEBP":
        return "image/webp"
    return None


def eh_url_do_blob(url: str, *, so_publica: bool = False) -> bool:
    """URL https do domínio de entrega do Blob. `/media/...` (foto do disco, de um banco que
    veio de uma loja local) e qualquer outro endereço não são — e não se apagam por aqui."""
    partes = urlsplit(url)
    host = (partes.hostname or "").lower()
    dominio = DOMINIO_BLOB_PUBLICO if so_publica else DOMINIO_BLOB
    return partes.scheme == "https" and host.endswith(dominio) and bool(partes.path.strip("/"))


# ------------------------------------------------------------------ as duas casas
class Armazenamento(Protocol):
    async def gravar(self, nome: str, conteudo: bytes, tipo: str) -> str:
        """Guarda a foto e devolve o que vai para `products.photo_url`."""
        ...

    async def apagar(self, url: str) -> None:
        """Tira uma foto que ninguém mais aponta. Nunca levanta: foto órfã custa espaço,
        uma troca de foto que falha por causa da antiga custa a paciência de quem cadastra."""
        ...


class FotosNoDisco:
    """A loja de sempre: arquivo em `MEDIA_DIR/produtos`, servido em `/media`."""

    def __init__(self, pasta_media: str | Path) -> None:
        self._pasta = Path(pasta_media) / "produtos"

    async def gravar(self, nome: str, conteudo: bytes, tipo: str) -> str:
        try:
            self._pasta.mkdir(parents=True, exist_ok=True)
            # Gravação é I/O bloqueante: fora da thread do event loop, senão a foto trava o PDV.
            await run_in_threadpool((self._pasta / nome).write_bytes, conteudo)
        except OSError as exc:
            log.error("Foto não gravada em %s: %s", self._pasta, exc)
            raise FotoNaoGuardada(
                "Sem lugar para guardar a foto neste servidor. Na Vercel, conecte um Blob "
                "store público ao projeto (BLOB_READ_WRITE_TOKEN)."
            ) from exc
        # Caminho relativo, nunca derivado do header Host: uma requisição com
        # `Host: atacante.com` gravaria essa URL no banco e todo mundo passaria a buscar a
        # imagem no servidor do atacante.
        return f"/media/produtos/{nome}"

    async def apagar(self, url: str) -> None:
        # No disco, a foto trocada FICA, como sempre ficou. O backup do banco e a pasta de
        # fotos são cópias separadas: restaurar o banco da semana passada volta a apontar
        # para a foto de antes, e ela tem de estar lá.
        return None


class FotosNoBlob:
    """Vercel Blob, store público. Duas chamadas: PUT da foto e POST /delete da antiga."""

    def __init__(
        self,
        token: str,
        *,
        base_url: str = API_BLOB,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._token = token
        self._base = base_url.rstrip("/")
        #: Os testes passam um `httpx.MockTransport`; em produção é a rede de verdade.
        self._transport = transport

    def _cliente(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            headers={
                "authorization": f"Bearer {self._token}",
                "x-api-version": VERSAO_API_BLOB,
            },
            timeout=TIMEOUT_S,
            transport=self._transport,
        )

    async def gravar(self, nome: str, conteudo: bytes, tipo: str) -> str:
        try:
            async with self._cliente() as cliente:
                resposta = await cliente.put(
                    self._base,
                    params={"pathname": f"produtos/{nome}"},
                    content=conteudo,
                    headers={
                        "x-vercel-blob-access": "public",
                        "x-content-type": tipo,
                        # O nome já é único (id do produto + uuid4): sufixo aleatório só
                        # tornaria a URL imprevisível nos testes, e sobrescrever nunca é o caso.
                        "x-add-random-suffix": "0",
                        "x-allow-overwrite": "0",
                    },
                )
        except httpx.HTTPError as exc:
            log.warning("Blob fora do ar ao enviar a foto %s: %r", nome, exc)
            raise FotoNaoGuardada(detail={"motivo": "rede"}) from exc

        if not resposta.is_success:
            # O corpo do erro do Blob vai para o log, nunca para a tela: pode citar o store.
            log.warning(
                "Blob recusou a foto %s: HTTP %s %s",
                nome,
                resposta.status_code,
                resposta.text[:300],
            )
            raise FotoNaoGuardada(detail={"motivo": "recusada", "status": resposta.status_code})

        try:
            url = resposta.json().get("url")
        except ValueError:
            url = None
        if not isinstance(url, str) or not eh_url_do_blob(url, so_publica=True):
            # Store PRIVADO devolve `.private.blob...`: a foto não abriria em tela nenhuma
            # (o navegador não manda o token). Melhor recusar agora que gravar foto quebrada.
            log.error("Blob devolveu URL que não é de store público: %r", url)
            raise FotoNaoGuardada(
                "O Blob store desta loja não é público. Crie um store com acesso público "
                "e conecte-o ao projeto.",
                {"motivo": "store_nao_publico"},
            )
        return url

    async def apagar(self, url: str) -> None:
        if not eh_url_do_blob(url):
            return
        try:
            async with self._cliente() as cliente:
                resposta = await cliente.post(f"{self._base}/delete", json={"urls": [url]})
        except httpx.HTTPError as exc:
            log.warning("Blob fora do ar ao apagar %s: %r", url, exc)
            return
        if not resposta.is_success:
            log.warning(
                "Blob não apagou %s: HTTP %s %s", url, resposta.status_code, resposta.text[:300]
            )


# ------------------------------------------------------------------ qual casa
def _fabricar() -> Armazenamento:
    if settings.fotos_no_blob:
        return FotosNoBlob(
            settings.blob_read_write_token.get_secret_value().strip(),
            base_url=settings.vercel_blob_api_url,
        )
    return FotosNoDisco(settings.media_dir)


#: Ponto de troca para os testes: o teste põe aqui um `FotosNoBlob` com `httpx.MockTransport`
#: — e nada vai para a internet.
fabrica = _fabricar


def armazenamento() -> Armazenamento:
    return fabrica()


def servir_fotos_do_disco(app: FastAPI) -> None:
    """`/media` só existe quando a foto mora no disco.

    Com o Blob ligado não há pasta para criar (o disco da Vercel é só leitura: o `mkdir` no
    import derrubava a função inteira) nem nada para servir — a foto sai da CDN do Blob.
    Pasta que não se cria (disco só leitura sem Blob configurado) não derruba a API: a loja
    vende sem foto, o log diz por quê, e o upload responde 503 com o que falta.
    """
    if settings.fotos_no_blob:
        return
    pasta = Path(settings.media_dir)
    try:
        pasta.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        log.error(
            "Pasta de fotos %s não pôde ser criada (%s): /media desligado. Na Vercel, conecte "
            "um Blob store público (BLOB_READ_WRITE_TOKEN).",
            pasta,
            exc,
        )
        return
    app.mount("/media", StaticFiles(directory=str(pasta)), name="media")
