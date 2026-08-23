"""Regras da identidade da loja. São poucas — de propósito."""

from app.core.segmentos import Segmento, Vocabulario, vocabulario
from app.modules.configuracao.models import StoreConfig
from app.modules.configuracao.repository import ConfiguracaoRepository
from app.modules.configuracao.schemas import ConfiguracaoUpdate
from sqlalchemy.ext.asyncio import AsyncSession


class ConfiguracaoService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.repo = ConfiguracaoRepository(session)

    async def obter(self) -> StoreConfig:
        config = await self.repo.obter_ou_criar()
        await self.session.commit()
        return config

    async def atualizar(self, dados: ConfiguracaoUpdate) -> StoreConfig:
        config = await self.repo.obter_ou_criar()
        campos = dados.model_dump(exclude_unset=True)
        for campo, valor in campos.items():
            setattr(config, campo, valor.value if isinstance(valor, Segmento) else valor)
        await self.session.commit()
        await self.session.refresh(config)
        return config

    async def vocabulario(self) -> Vocabulario:
        """As palavras da loja, para quem precisa delas no servidor (ex.: o recibo)."""
        return vocabulario((await self.repo.obter_ou_criar()).segmento)
