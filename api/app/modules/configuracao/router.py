"""A porta da identidade da loja.

`GET` é **aberto, sem login**: a tela de login precisa dizer o nome da loja antes de
existir sessão, e o app precisa saber que falou com o servidor certo antes de alguém
digitar senha. O que sai daqui é só o que já está na fachada — nome, ramo, fuso e as
palavras da tela. Nenhum documento, nenhum contato, nenhum número.

Com sessão válida, o próprio `GET` já devolve a configuração completa: os apps instalados
antes do `/completa` existir leem documento, telefone e endereço daqui e os reenviam no
`PATCH` da tela "A loja" — recebendo a versão pública, apagariam os três do banco.

`GET /completa` acrescenta documento, telefone e endereço, e pede sessão de QUALQUER
papel: a vendedora imprime o recibo, e o recibo leva os três. Fechar para todo mundo menos
o dono quebraria o balcão; abrir para quem não entrou entregava o CPF e o endereço de casa
do dono MEI a quem digitasse a URL.

`PATCH` é do dono (`CONFIGURAR_LOJA`).
"""

from fastapi import APIRouter

from app.core.deps import CurrentUser, ExigeConfigurarLoja, SessionDep, UsuarioOpcional
from app.core.segmentos import VOCABULARIO
from app.modules.configuracao.schemas import (
    ConfiguracaoOut,
    ConfiguracaoPublicaOut,
    ConfiguracaoUpdate,
    SegmentoOut,
)
from app.modules.configuracao.service import ConfiguracaoService

router = APIRouter(prefix="/configuracao", tags=["configuracao"])


# `response_model=None`: a resposta muda com quem pede (CLAUDE.md), e o modelo público
# apagaria os campos que o logado recebe.
@router.get("", response_model=None)
async def obter(
    session: SessionDep, usuario: UsuarioOpcional
) -> ConfiguracaoOut | ConfiguracaoPublicaOut:
    config = await ConfiguracaoService(session).obter()
    if usuario is not None:
        return ConfiguracaoOut.de_modelo(config)
    return ConfiguracaoPublicaOut.de_modelo(config)


@router.get("/completa", response_model=ConfiguracaoOut)
async def obter_completa(session: SessionDep, _: CurrentUser) -> ConfiguracaoOut:
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
