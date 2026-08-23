"""Que versão está rodando aqui — e ela é a mais nova?

**A pergunta útil não é "qual versão", é "estou atrasado?".** Um hash de commit na tela não
diz nada para quem cuida da loja: `5c31d04` não é maior nem menor que `414c046`. O que
resolve a dúvida é o sistema afirmar "conferido há 4 minutos, está na mais nova" — ou
admitir que não confere há três dias, que é justamente quando a resposta importa.

**Quem sabe disso é o atualizador, não a API.** Comparar com o GitHub exige credencial do
repositório, e enfiar um token dentro do contêiner da API seria dar acesso ao código-fonte a
quem só precisa vender roupa. Então o `atualizar.sh` — que já tem a credencial e já
conversa com o GitHub a cada conferida — deixa o resultado escrito num arquivo, e esta rota
só lê. A API nunca fala com o GitHub.

Módulo sem service nem repository de propósito: não há domínio nem banco aqui, é a leitura
de um arquivo de estado. Inventar as duas camadas para atravessar seria cerimônia.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel

from app.core.config import settings
from app.core.deps import CurrentUser

router = APIRouter(tags=["sistema"])

#: Depois disto, "conferido" não tranquiliza mais ninguém: ou a atualização automática está
#: desligada, ou parou de funcionar, e nos dois casos a tela precisa dizer.
HORAS_ATE_ESQUECER = 24


class VersaoOut(BaseModel):
    """O suficiente para a tela dizer "está em dia" sem o usuário interpretar hash nenhum."""

    #: Commit curto (`5c31d04`) — serve para reportar problema, não para comparar.
    commit: str | None = None
    #: Quando esse commit foi feito.
    data: datetime | None = None
    #: Última vez que alguém perguntou ao GitHub se havia coisa nova.
    conferido_em: datetime | None = None
    #: Havia coisa nova nessa última conferida? `None` = nunca conferimos.
    atualizada: bool | None = None
    #: A conferida é recente o bastante para valer alguma coisa.
    conferido_recente: bool = False
    #: A frase pronta, para a tela não ter que montar (e web e app não divergirem).
    resumo: str


def _ler_estado() -> dict:
    caminho = Path(settings.estado_dir) / "versao.json"
    try:
        return json.loads(caminho.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        # Rodando fora do Docker (uvicorn na mão) não existe arquivo nenhum, e isso não é
        # erro: é desenvolvimento.
        return {}


def _texto(atualizada: bool | None, recente: bool, conferido: datetime | None) -> str:
    if conferido is None:
        return "Versão instalada na mão — sem conferir com o GitHub."
    if not recente:
        dias = max(1, (datetime.now(UTC) - conferido).days)
        return f"Não confere se há versão nova há {dias} dia(s)."
    if atualizada:
        return "Está na versão mais nova."
    return "Existe versão mais nova esperando para ser instalada."


@router.get("/versao", response_model=VersaoOut, summary="Versão instalada e se é a mais nova")
async def versao(_: CurrentUser) -> VersaoOut:
    estado = _ler_estado()

    def _quando(chave: str) -> datetime | None:
        bruto = estado.get(chave)
        if not isinstance(bruto, str):
            return None
        try:
            return datetime.fromisoformat(bruto)
        except ValueError:
            return None

    conferido = _quando("conferido_em")
    recente = (
        conferido is not None
        and (datetime.now(UTC) - conferido).total_seconds() < HORAS_ATE_ESQUECER * 3600
    )
    atualizada = estado.get("atualizada")
    if not isinstance(atualizada, bool):
        atualizada = None

    return VersaoOut(
        commit=estado.get("commit") or None,
        data=_quando("data"),
        conferido_em=conferido,
        atualizada=atualizada,
        conferido_recente=recente,
        resumo=_texto(atualizada, recente, conferido),
    )
