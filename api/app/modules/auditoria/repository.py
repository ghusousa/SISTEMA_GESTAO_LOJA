"""Leitura e escrita do diário.

O dia a dia é só INSERT e SELECT: nenhuma tela edita uma linha. As duas exceções são de
LGPD, nunca de conteúdo (ADR-23): a faxina que apaga o que passou do prazo de retenção, e
a máscara do e-mail de quem teve a conta excluída. Nenhuma das duas toca no nome e no
papel congelados de quem AGIU.
"""

from datetime import datetime

from sqlalchemy import Select, delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.auditoria.models import AuditLog

#: Quantas linhas a faxina apaga por login. A primeira faxina depois de ligar a retenção
#: pode achar anos de diário; em lotes, nenhum login fica esperando um DELETE gigante, e os
#: próximos logins terminam o serviço.
LOTE_DA_FAXINA = 5000


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

    async def apagar_anteriores(self, limite: datetime) -> int:
        """Apaga um lote do que é mais velho que `limite`. Devolve quantas linhas saíram."""
        velhas = (
            select(AuditLog.id).where(AuditLog.created_at < limite).limit(LOTE_DA_FAXINA)
        )
        resultado = await self.session.execute(
            delete(AuditLog)
            .where(AuditLog.id.in_(velhas))
            .execution_options(synchronize_session=False)
        )
        return int(resultado.rowcount or 0)

    async def linhas_com_email(self, email: str) -> list[AuditLog]:
        """As linhas em que o e-mail aparece: no lugar do nome ou dentro da frase.

        É o formato antigo do LOGIN_FALHOU (o e-mail digitado ia nas duas colunas). ILIKE
        porque a pessoa digita com maiúscula; os curingas do LIKE são escapados para um
        e-mail com `_` não casar com o de outra pessoa.
        """
        alvo = email.strip().lower()
        padrao = alvo.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        return list(
            (
                await self.session.execute(
                    select(AuditLog).where(
                        or_(
                            func.lower(AuditLog.user_nome) == alvo,
                            AuditLog.descricao.ilike(f"%{padrao}%", escape="\\"),
                        )
                    )
                )
            ).scalars().all()
        )
