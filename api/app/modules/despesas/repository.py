from datetime import date

from sqlalchemy import func, or_, select
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
        """Modelos de recorrência: um por conta fixa, tirado dos meses anteriores.

        A conta fixa é a CADEIA: a despesa-raiz mais as réplicas que apontam para ela, e
        também a recorrente digitada à mão com o mesmo nome e categoria. A linha mais recente
        da cadeia é o modelo, então mudar o valor do aluguel em julho faz a réplica de
        agosto sair com o valor novo, e renomear a réplica não faz a raiz voltar como uma
        segunda conta (eram dois modelos com a mesma origem, e a UNIQUE derrubava o mês).

        A mais recente decide COM OU SEM a marca: desmarcar "recorrente" na réplica de
        fevereiro para a conta ali. Olhar só as marcadas pegava a raiz de janeiro como
        modelo, e para parar o aluguel a dona teria de desmarcar o histórico inteiro.
        Despesa digitada à mão sem a marca fica de fora — desmarcada é o padrão da tela, e
        não pode ser lida como "parou".
        """
        stmt = (
            select(Expense)
            .options(joinedload(Expense.category))
            .where(
                Expense.deleted_at.is_(None),
                Expense.competencia < competencia,
                or_(Expense.is_recurring.is_(True), Expense.recurring_source_id.is_not(None)),
            )
            .order_by(Expense.competencia.desc(), Expense.id.desc())
        )
        origens_vistas: set[int] = set()
        chaves_vistas: set[tuple[int, str]] = set()
        modelos: list[Expense] = []
        for despesa in (await self.session.execute(stmt)).unique().scalars().all():
            origem = despesa.recurring_source_id or despesa.id
            chave = (despesa.category_id, despesa.description.strip().lower())
            ja_decidida = origem in origens_vistas or chave in chaves_vistas
            # Marca as duas pontas mesmo quando a linha é pulada: a raiz "Aluguel" de uma
            # réplica renomeada ainda é a mesma conta do "Aluguel" digitado meses antes.
            origens_vistas.add(origem)
            chaves_vistas.add(chave)
            if not ja_decidida and despesa.is_recurring:
                modelos.append(despesa)
        return modelos

    async def dias_das_origens(self, origens: set[int]) -> dict[int, int]:
        """Dia de vencimento de cada despesa-raiz, mesmo excluída: ela ainda é a origem."""
        if not origens:
            return {}
        stmt = select(Expense.id, Expense.expense_date).where(Expense.id.in_(origens))
        return {
            despesa_id: data.day for despesa_id, data in (await self.session.execute(stmt)).all()
        }

    async def lancamentos_da_competencia(
        self, competencia: date
    ) -> tuple[set[int], set[tuple[int, str]]]:
        """O que já está lançado no mês: as origens replicadas e as (categoria, descrição).

        A origem pega a réplica que a dona renomeou; a (categoria, descrição) pega o
        aluguel do mês digitado à mão — sem origem —, senão "Lançar fixas" acharia que
        faltava e criaria o segundo.
        """
        stmt = select(Expense.recurring_source_id, Expense.category_id, Expense.description).where(
            Expense.competencia == competencia, Expense.deleted_at.is_(None)
        )
        origens: set[int] = set()
        chaves: set[tuple[int, str]] = set()
        for origem, categoria_id, descricao in (await self.session.execute(stmt)).all():
            if origem is not None:
                origens.add(origem)
            chaves.add((categoria_id, descricao.strip().lower()))
        return origens, chaves
