"""Regras do backup. São poucas, e a mais importante é o que NÃO acontece aqui:
esta camada não faz backup nenhum. Ela guarda a configuração que o `backup.sh` vai ler.
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.backup.models import BackupConfig
from app.modules.backup.schemas import BackupUpdate


class BackupService:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def _obter_ou_criar(self) -> BackupConfig:
        c = await self.session.scalar(select(BackupConfig).where(BackupConfig.id == 1))
        if c is None:
            c = BackupConfig(id=1)
            self.session.add(c)
            await self.session.flush()
        return c

    async def obter(self) -> BackupConfig:
        c = await self._obter_ou_criar()
        await self.session.commit()
        return c

    async def atualizar(self, dados: BackupUpdate) -> BackupConfig:
        c = await self._obter_ou_criar()
        campos = dados.model_dump(exclude_unset=True)

        # Token só é sobrescrito quando vem um NOVO. Mandar `null` (ou nada) não apaga o
        # que já está lá: a tela salva "ligar/desligar" sem reenviar credencial, e um
        # PATCH descuidado não deixa a loja sem backup sem ninguém perceber.
        if campos.get("rclone_token") is None:
            campos.pop("rclone_token", None)

        for campo, valor in campos.items():
            setattr(c, campo, valor)

        # Ligar sem token seria mentira na tela: diria "ativo" e nada aconteceria.
        if c.ativo and not c.rclone_token:
            from app.core.exceptions import OperacaoInvalida

            raise OperacaoInvalida(
                "Antes de ligar o backup, conecte a conta do Google Drive."
            )

        await self.session.commit()
        await self.session.refresh(c)
        return c
