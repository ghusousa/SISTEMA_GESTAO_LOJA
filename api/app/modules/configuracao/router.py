"""A porta da identidade da loja.

`GET` é **aberto, sem login**: a tela de login precisa dizer o nome da loja antes de
existir sessão, e o app precisa saber que falou com o servidor certo antes de alguém
digitar senha. O que sai daqui é o que já está na fachada — nome, ramo, contato. Nenhum
número, nenhum dado de cliente, nenhuma contagem.

`PATCH` é do dono (`CONFIGURAR_LOJA`).
"""

from fastapi import APIRouter

from app.core.deps import ExigeConfigurarLoja, SessionDep
from app.core.segmentos import VOCABULARIO
from app.modules.configuracao.schemas import (
    ConfiguracaoOut,
    ConfiguracaoUpdate,
    SegmentoOut,
)
from app.modules.configuracao.service import ConfiguracaoService

router = APIRouter(prefix="/configuracao", tags=["configuracao"])


@router.get("", response_model=ConfiguracaoOut)
async def obter(session: SessionDep) -> ConfiguracaoOut:
    config = await ConfiguracaoService(session).obter()
    return ConfiguracaoOut.de_modelo(config)


@router.get("/segmentos", response_model=list[SegmentoOut])
async def listar_segmentos() -> list[SegmentoOut]:
    """Os ramos que o sistema conhece, para a tela montar o seletor sem lista própria."""
    return [
        SegmentoOut(valor=s.value, rotulo=v.rotulo, eixo1=v.eixo1, eixo2=v.eixo2)
        for s, v in VOCABULARIO.items()
    ]


@router.patch("", response_model=ConfiguracaoOut)
async def atualizar(
    dados: ConfiguracaoUpdate, session: SessionDep, _: ExigeConfigurarLoja
) -> ConfiguracaoOut:
    config = await ConfiguracaoService(session).atualizar(dados)
    return ConfiguracaoOut.de_modelo(config)
