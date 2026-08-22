from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.pagination import Paginacao
from app.modules.usuarios.models import User


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
        stmt = select(User)
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
        stmt = stmt.order_by(User.name).offset(p.offset).limit(p.limit)
        items = list((await self.session.execute(stmt)).scalars().all())
        return items, int(total or 0)

    async def contar_admins_ativos(self, excluindo_id: int | None = None) -> int:
        stmt = select(func.count()).select_from(User).where(
            User.role == "ADMIN", User.is_active.is_(True)
        )
        if excluindo_id is not None:
            stmt = stmt.where(User.id != excluindo_id)
        return int(await self.session.scalar(stmt) or 0)

    def adicionar(self, user: User) -> User:
        self.session.add(user)
        return user
