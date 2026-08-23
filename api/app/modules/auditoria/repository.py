"""Leitura e escrita do diário. Só INSERT e SELECT — nunca UPDATE nem DELETE pela aplicação."""

from datetime import datetime

from sqlalchemy import Select, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.auditoria.models import AuditLog


class AuditoriaRepository:
    def __init__(self, session: AsyncSession):
        self.session = session

    def registrar(
        self,
        *,
        user_id: int | None,
        user_nome: str,
        user_papel: str | None,
        acao: str,
        descricao: str,
        metodo: str | None = None,
        caminho: str | None = None,
        entidade: str | None = None,
        entidade_id: int | None = None,
        ip: str | None = None,
        status_http: int | None = None,
    ) -> AuditLog:
        linha = AuditLog(
            user_id=user_id,
            user_nome=user_nome[:160],
            user_papel=user_papel,
            acao=acao,
            descricao=descricao[:300],
            metodo=metodo,
            caminho=(caminho or None) and caminho[:300],
            entidade=entidade,
            entidade_id=entidade_id,
            ip=ip,
            status_http=status_http,
        )
        self.session.add(linha)
        return linha

    def _filtrar(
        self,
        stmt: Select,
        *,
        usuario_id: int | None,
        acao: str | None,
        inicio: datetime | None,
        fim: datetime | None,
    ) -> Select:
        if usuario_id is not None:
            stmt = stmt.where(AuditLog.user_id == usuario_id)
        if acao:
            stmt = stmt.where(AuditLog.acao == acao)
        if inicio is not None:
            stmt = stmt.where(AuditLog.created_at >= inicio)
        if fim is not None:
            stmt = stmt.where(AuditLog.created_at < fim)
        return stmt

    async def listar(
        self,
        *,
        usuario_id: int | None,
        acao: str | None,
        inicio: datetime | None,
        fim: datetime | None,
        offset: int,
        limit: int,
    ) -> tuple[list[AuditLog], int]:
        base = self._filtrar(
            select(AuditLog), usuario_id=usuario_id, acao=acao, inicio=inicio, fim=fim
        )
        total = await self.session.scalar(
            select(func.count()).select_from(base.subquery())
        )
        linhas = (
            await self.session.execute(
                base.order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
                .offset(offset)
                .limit(limit)
            )
        ).scalars().all()
        return list(linhas), int(total or 0)
