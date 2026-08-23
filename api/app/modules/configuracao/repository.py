"""Leitura e escrita da linha única de configuração."""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.segmentos import Segmento
from app.modules.configuracao.models import StoreConfig

#: Nome de uma loja que ainda não se apresentou. Nunca fica em branco na tela.
NOME_PADRAO = "Minha Loja"


class ConfiguracaoRepository:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def obter(self) -> StoreConfig | None:
        return await self.session.scalar(select(StoreConfig).where(StoreConfig.id == 1))

    async def obter_ou_criar(self) -> StoreConfig:
        """Instalação antiga que subiu sem passar pelo instalador novo não pode ficar sem
        configuração — a tela de login quebraria. Aqui ela nasce com o nome neutro."""
        config = await self.obter()
        if config is None:
            config = StoreConfig(id=1, nome=NOME_PADRAO, segmento=Segmento.OUTRO.value)
            self.session.add(config)
            await self.session.flush()
        return config
