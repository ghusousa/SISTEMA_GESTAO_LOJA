import calendar
from datetime import UTC, date, datetime
from decimal import Decimal

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import Duplicado, NaoEncontrado, OperacaoInvalida, Validacao
from app.core.pagination import Pagina, Paginacao
from app.modules.despesas.models import Expense, ExpenseCategory
from app.modules.despesas.repository import DespesaRepository
from app.modules.despesas.schemas import (
    CategoriaDespesaIn,
    CategoriaDespesaOut,
    DespesaIn,
    DespesaOut,
    DespesaUpdate,
    ReplicacaoOut,
)

ZERO = Decimal("0.00")


def _competencia_para_data(competencia: str) -> date:
    ano, mes = competencia.split("-")
    return date(int(ano), int(mes), 1)


def _dia_no_mes(referencia: date, dia_desejado: int) -> date:
    """Aluguel que vence dia 31 cai no último dia de fevereiro, em vez de estourar."""
    ultimo_dia = calendar.monthrange(referencia.year, referencia.month)[1]
    return date(referencia.year, referencia.month, min(dia_desejado, ultimo_dia))


class DespesaService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.repo = DespesaRepository(session)

    # ------------------------------------------------------------ categorias
    async def listar_categorias(self, p: Paginacao) -> Pagina[CategoriaDespesaOut]:
        items, total = await self.repo.listar_categorias(p)
        return Pagina.montar([CategoriaDespesaOut.model_validate(c) for c in items], total, p)

    async def criar_categoria(self, dados: CategoriaDespesaIn) -> ExpenseCategory:
        if await self.repo.categoria_por_nome(dados.nome) is not None:
            raise Duplicado(f"Já existe a categoria de despesa '{dados.nome}'.")
        categoria = ExpenseCategory(name=dados.nome)
        self.session.add(categoria)
        try:
            await self.session.commit()
        except IntegrityError as exc:
            await self.session.rollback()
            raise Duplicado(f"Já existe a categoria de despesa '{dados.nome}'.") from exc
        await self.session.refresh(categoria)
        return categoria

    async def atualizar_categoria(
        self, categoria_id: int, dados: CategoriaDespesaIn
    ) -> ExpenseCategory:
        categoria = await self.repo.categoria_por_id(categoria_id)
        if categoria is None:
            raise NaoEncontrado("Categoria de despesa não encontrada.")
        existente = await self.repo.categoria_por_nome(dados.nome)
        if existente is not None and existente.id != categoria_id:
            raise Duplicado(f"Já existe a categoria de despesa '{dados.nome}'.")
        categoria.name = dados.nome
        await self.session.commit()
        await self.session.refresh(categoria)
        return categoria

    async def excluir_categoria(self, categoria_id: int) -> None:
        categoria = await self.repo.categoria_por_id(categoria_id)
        if categoria is None:
            raise NaoEncontrado("Categoria de despesa não encontrada.")
        if await self.repo.categoria_tem_despesas(categoria_id):
            raise OperacaoInvalida("Esta categoria ainda tem despesas lançadas.")
        categoria.deleted_at = datetime.now(UTC)
        await self.session.commit()

    # ------------------------------------------------------------ despesas
    @staticmethod
    def _out(despesa: Expense) -> DespesaOut:
        return DespesaOut(
            id=despesa.id,
            categoria_id=despesa.category_id,
            categoria=despesa.category.name if despesa.category else "",
            descricao=despesa.description,
            valor=despesa.amount,
            data=despesa.expense_date,
            competencia=despesa.competencia.strftime("%Y-%m"),
            recorrente=despesa.is_recurring,
            observacao=despesa.note,
            origem_recorrente_id=despesa.recurring_source_id,
        )

    async def obter(self, despesa_id: int) -> DespesaOut:
        despesa = await self.repo.por_id(despesa_id)
        if despesa is None:
            raise NaoEncontrado("Despesa não encontrada.")
        return self._out(despesa)

    async def listar(
        self,
        p: Paginacao,
        inicio: date | None,
        fim: date | None,
        categoria_id: int | None,
        recorrente: bool | None,
    ) -> Pagina[DespesaOut]:
        if inicio and fim and inicio > fim:
            raise Validacao("A data inicial é depois da final.")
        items, total = await self.repo.listar(p, inicio, fim, categoria_id, recorrente)
        return Pagina.montar([self._out(d) for d in items], total, p)

    async def criar(self, dados: DespesaIn) -> DespesaOut:
        if await self.repo.categoria_por_id(dados.categoria_id) is None:
            raise NaoEncontrado("Categoria de despesa não encontrada.")
        despesa = Expense(
            category_id=dados.categoria_id,
            description=dados.descricao,
            amount=dados.valor,
            expense_date=dados.data,
            is_recurring=dados.recorrente,
            note=dados.observacao,
        )
        self.session.add(despesa)
        await self.session.commit()
        return await self.obter(despesa.id)

    async def atualizar(self, despesa_id: int, dados: DespesaUpdate) -> DespesaOut:
        despesa = await self.repo.por_id(despesa_id)
        if despesa is None:
            raise NaoEncontrado("Despesa não encontrada.")
        if dados.categoria_id is not None:
            if await self.repo.categoria_por_id(dados.categoria_id) is None:
                raise NaoEncontrado("Categoria de despesa não encontrada.")
            despesa.category_id = dados.categoria_id
        for campo, valor in (
            ("description", dados.descricao),
            ("amount", dados.valor),
            ("expense_date", dados.data),
            ("is_recurring", dados.recorrente),
            ("note", dados.observacao),
        ):
            if valor is not None:
                setattr(despesa, campo, valor)
        await self.session.commit()
        return await self.obter(despesa_id)

    async def excluir(self, despesa_id: int) -> None:
        despesa = await self.repo.por_id(despesa_id)
        if despesa is None:
            raise NaoEncontrado("Despesa não encontrada.")
        despesa.deleted_at = datetime.now(UTC)
        await self.session.commit()

    # ------------------------------------------------------------ recorrentes
    async def replicar_recorrentes(self, competencia: str) -> ReplicacaoOut:
        """Traz as contas fixas para o mês pedido.

        Idempotente pela UNIQUE (origem, competência): rodar de novo não duplica o aluguel,
        devolve quantas já existiam.
        """
        referencia = _competencia_para_data(competencia)
        modelos = await self.repo.recorrentes_ate(referencia)
        ja_lancadas = await self.repo.lancamentos_da_competencia(referencia)

        criadas: list[Expense] = []
        ja_existentes = 0
        for modelo in modelos:
            chave = (modelo.category_id, modelo.description.strip().lower())
            if chave in ja_lancadas:
                ja_existentes += 1
                continue
            # A origem da réplica é sempre a despesa-raiz, não a réplica anterior:
            # assim a UNIQUE cobre a cadeia inteira e o mês nunca duplica.
            origem_id = modelo.recurring_source_id or modelo.id
            nova = Expense(
                category_id=modelo.category_id,
                description=modelo.description,
                amount=modelo.amount,
                expense_date=_dia_no_mes(referencia, modelo.expense_date.day),
                is_recurring=True,
                note=modelo.note,
                recurring_source_id=origem_id,
            )
            self.session.add(nova)
            criadas.append(nova)
            ja_lancadas.add(chave)

        try:
            await self.session.commit()
        except IntegrityError as exc:
            await self.session.rollback()
            # Só a corrida das duas replicações simultâneas é "já estava lá". Qualquer outra
            # violação (categoria excluída no meio, valor inválido) é erro de verdade e não
            # pode virar um "tudo certo" que esconde despesa faltando no mês.
            if "recurring_source_id" not in str(exc.orig):
                raise
            return ReplicacaoOut(
                competencia=competencia,
                criadas=0,
                ja_existentes=len(modelos),
                valor_total=ZERO,
                despesas=[],
            )

        resultado = [await self.obter(d.id) for d in criadas]
        return ReplicacaoOut(
            competencia=competencia,
            criadas=len(resultado),
            ja_existentes=ja_existentes,
            valor_total=sum((d.valor for d in resultado), ZERO),
            despesas=resultado,
        )
