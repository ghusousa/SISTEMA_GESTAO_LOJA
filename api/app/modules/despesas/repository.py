from datetime import date

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload

from app.core.pagination import Paginacao
from app.modules.despesas.models import Expense, ExpenseCategory


class DespesaRepository:
    def __init__(self, session: AsyncSession):
        self.session = session

    # ------------------------------------------------------------ categorias
    async def categoria_por_id(self, categoria_id: int) -> ExpenseCategory | None:
        cat = await self.session.get(ExpenseCategory, categoria_id)
        return cat if cat is not None and cat.deleted_at is None else None

    async def categoria_por_nome(self, nome: str) -> ExpenseCategory | None:
        stmt = select(ExpenseCategory).where(
            func.lower(ExpenseCategory.name) == nome.strip().lower(),
            ExpenseCategory.deleted_at.is_(None),
        )
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def listar_categorias(
        self, p: Paginacao
    ) -> tuple[list[ExpenseCategory], int]:
        stmt = select(ExpenseCategory).where(ExpenseCategory.deleted_at.is_(None))
        total = await self.session.scalar(select(func.count()).select_from(stmt.subquery()))
        stmt = stmt.order_by(ExpenseCategory.name, ExpenseCategory.id).offset(p.offset).limit(p.limit)
        return list((await self.session.execute(stmt)).scalars().all()), int(total or 0)

    async def categoria_tem_despesas(self, categoria_id: int) -> bool:
        stmt = select(func.count()).select_from(Expense).where(
            Expense.category_id == categoria_id, Expense.deleted_at.is_(None)
        )
        return bool(await self.session.scalar(stmt))

    # ------------------------------------------------------------ despesas
    async def por_id(self, despesa_id: int) -> Expense | None:
        stmt = (
            select(Expense)
            .options(joinedload(Expense.category))
            .where(Expense.id == despesa_id, Expense.deleted_at.is_(None))
        )
        return (await self.session.execute(stmt)).unique().scalar_one_or_none()

    async def listar(
        self,
        p: Paginacao,
        inicio: date | None,
        fim: date | None,
        categoria_id: int | None,
        recorrente: bool | None,
    ) -> tuple[list[Expense], int]:
        stmt = (
            select(Expense)
            .options(joinedload(Expense.category))
            .where(Expense.deleted_at.is_(None))
        )
        if inicio:
            stmt = stmt.where(Expense.expense_date >= inicio)
        if fim:
            stmt = stmt.where(Expense.expense_date <= fim)
        if categoria_id:
            stmt = stmt.where(Expense.category_id == categoria_id)
        if recorrente is not None:
            stmt = stmt.where(Expense.is_recurring.is_(recorrente))
        total = await self.session.scalar(select(func.count()).select_from(stmt.subquery()))
        stmt = stmt.order_by(Expense.expense_date.desc(), Expense.id.desc())
        stmt = stmt.offset(p.offset).limit(p.limit)
        return list((await self.session.execute(stmt)).unique().scalars().all()), int(total or 0)

    async def recorrentes_ate(self, competencia: date) -> list[Expense]:
        """Modelos de recorrência: despesas marcadas como recorrentes de meses anteriores.

        Uma por (categoria, descrição) — a mais recente vale, então mudar o valor do
        aluguel em julho faz a réplica de agosto sair com o valor novo.
        """
        stmt = (
            select(Expense)
            .options(joinedload(Expense.category))
            .where(
                Expense.is_recurring.is_(True),
                Expense.deleted_at.is_(None),
                Expense.competencia < competencia,
            )
            .order_by(
                Expense.category_id,
                func.lower(Expense.description),
                Expense.competencia.desc(),
            )
        )
        vistos: set[tuple[int, str]] = set()
        modelos: list[Expense] = []
        for despesa in (await self.session.execute(stmt)).unique().scalars().all():
            chave = (despesa.category_id, despesa.description.strip().lower())
            if chave not in vistos:
                vistos.add(chave)
                modelos.append(despesa)
        return modelos

    async def lancamentos_da_competencia(self, competencia: date) -> set[tuple[int, str]]:
        """O que já está lançado no mês, por (categoria, descrição).

        A chave não é o `recurring_source_id` porque o aluguel do mês pode ter sido digitado
        à mão — sem origem — e aí "Lançar fixas" acharia que faltava e criaria o segundo.
        """
        stmt = select(Expense.category_id, Expense.description).where(
            Expense.competencia == competencia, Expense.deleted_at.is_(None)
        )
        return {
            (categoria_id, descricao.strip().lower())
            for categoria_id, descricao in (await self.session.execute(stmt)).all()
        }
