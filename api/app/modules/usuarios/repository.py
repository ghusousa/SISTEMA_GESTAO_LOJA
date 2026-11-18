from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.pagination import Paginacao
from app.modules.usuarios.models import User

#: SQLSTATE da violação de FK: a linha é referenciada por um FK RESTRICT.
FK_VIOLADA = "23503"


class UsuarioRepository:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def por_id(self, user_id: int) -> User | None:
        return await self.session.get(User, user_id)

    async def por_email(self, email: str) -> User | None:
        stmt = select(User).where(func.lower(User.email) == email.strip().lower())
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def listar(
        self,
        p: Paginacao,
        q: str | None = None,
        papel: str | None = None,
        ativo: bool | None = None,
    ) -> tuple[list[User], int]:
        # Conta excluída que ficou para segurar o histórico não é equipe (ADR-45).
        stmt = select(User).where(User.deleted_at.is_(None))
        if q:
            termo = f"%{q.strip().lower()}%"
            stmt = stmt.where(
                or_(func.lower(User.name).like(termo), func.lower(User.email).like(termo))
            )
        if papel:
            stmt = stmt.where(User.role == papel)
        if ativo is not None:
            stmt = stmt.where(User.is_active.is_(ativo))

        total = await self.session.scalar(
            select(func.count()).select_from(stmt.subquery())
        )
        stmt = stmt.order_by(User.name, User.id).offset(p.offset).limit(p.limit)
        items = list((await self.session.execute(stmt)).scalars().all())
        return items, int(total or 0)

    async def outros_donos_ativos(self, excluindo_id: int) -> int:
        """Quantos donos ativos sobram sem `excluindo_id`, com as linhas de dono TRAVADAS
        (`FOR UPDATE`, em ordem de id) até o commit de quem perguntou.

        Contar sem travar deixava dois donos saírem juntos — cada um contava o outro, os
        dois se excluíam (ou se rebaixavam) e a loja ficava sem dono. Travado, o segundo
        espera o primeiro terminar e conta o que ele deixou: a linha que saiu ou ficou
        inativa já não entra no `WHERE`. A ordem por id é a mesma para todo mundo, e duas
        saídas não se travam uma à outra.
        """
        ids = await self.session.scalars(
            select(User.id)
            .where(User.role == "ADMIN", User.is_active.is_(True))
            .order_by(User.id)
            .with_for_update()
        )
        return sum(1 for user_id in ids if user_id != excluindo_id)

    async def travar_viva(self, user_id: int) -> bool:
        """Trava a linha da conta até o commit e diz se ela ainda existe (e não foi excluída).

        Duas exclusões da mesma conta ao mesmo tempo — dois aparelhos da pessoa, ou ela e o
        dono — viram uma: a segunda espera a primeira e encontra a conta já excluída, em vez
        de tentar apagar uma linha que não está mais lá (500 no flush).
        """
        achou = await self.session.scalar(
            select(User.id)
            .where(User.id == user_id, User.deleted_at.is_(None))
            .with_for_update()
        )
        return achou is not None

    async def apagar(self, user: User) -> bool:
        """Tenta apagar a linha, num SAVEPOINT. `False` quando um FK RESTRICT a segura.

        Quem já vendeu, abriu caixa, deu entrada ou fez condicional tem a linha presa à
        contabilidade da loja (os FKs são RESTRICT de propósito). Aí só a tentativa é
        desfeita — o resto da transação segue — e quem chamou decide o que fazer com a
        linha que ficou. O que não for violação de FK continua sendo erro.
        """
        try:
            async with self.session.begin_nested():
                await self.session.delete(user)
                await self.session.flush()
        except IntegrityError as exc:
            if getattr(exc.orig, "sqlstate", None) != FK_VIOLADA:
                raise
            return False
        return True

    def adicionar(self, user: User) -> User:
        self.session.add(user)
        return user
