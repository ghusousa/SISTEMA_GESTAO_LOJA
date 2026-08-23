"""Serviço da auditoria: escrever o diário (usado pela borda) e lê-lo (usado pelo dono)."""

from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.pagination import Pagina, Paginacao
from app.modules.auditoria.repository import AuditoriaRepository
from app.modules.auditoria.schemas import AuditoriaOut


class AuditoriaService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.repo = AuditoriaRepository(session)

    async def listar(
        self,
        p: Paginacao,
        *,
        usuario_id: int | None = None,
        acao: str | None = None,
        inicio: datetime | None = None,
        fim: datetime | None = None,
    ) -> Pagina[AuditoriaOut]:
        linhas, total = await self.repo.listar(
            usuario_id=usuario_id,
            acao=acao,
            inicio=inicio,
            fim=fim,
            offset=p.offset,
            limit=p.limit,
        )
        return Pagina.montar(
            [AuditoriaOut.model_validate(l) for l in linhas], total, p
        )
