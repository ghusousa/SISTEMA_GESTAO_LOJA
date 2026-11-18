import uuid
from datetime import date

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.pagination import Paginacao
from app.modules.catalogo.models import Product, ProductVariant
from app.modules.clientes.models import Customer
from app.modules.condicionais.models import Consignment, StatusCondicional
from app.modules.condicionais.schemas import FiltroCondicionais
from app.modules.usuarios.models import User


class CondicionalRepository:
    """Leituras e a transição de status da condicional.

    Junta cliente, usuário e catálogo para a tela mostrar nomes sem outra chamada — é read
    model, como o extrato do estoque, não escrita em domínio alheio.
    """

    def __init__(self, session: AsyncSession):
        self.session = session

    async def por_id(self, condicional_id: int) -> Consignment | None:
        stmt = (
            select(Consignment)
            .where(Consignment.id == condicional_id)
            .execution_options(populate_existing=True)
        )
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def abertas_da_cliente(self, cliente_id: int) -> int:
        stmt = select(func.count()).where(
            Consignment.customer_id == cliente_id,
            Consignment.status == StatusCondicional.ABERTA,
        )
        return int(await self.session.scalar(stmt) or 0)

    async def por_client_uuid(self, client_uuid: uuid.UUID) -> Consignment | None:
        stmt = select(Consignment).where(Consignment.client_uuid == client_uuid)
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def marcar_fechada(
        self, condicional_id: int, *, usuario_id: int, closing_uuid: uuid.UUID
    ) -> bool:
        """ABERTA vira FECHADA numa instrução, e diz se foi ESTA requisição quem fechou.

        O `WHERE status = 'ABERTA'` serializa dois fechamentos simultâneos (dois aparelhos,
        toque duplo): o segundo espera a trava da linha, relê a condição depois do commit do
        primeiro e não acha nada para mudar. Conferir o status em memória deixaria os dois
        devolverem as peças — e a cliente seria cobrada duas vezes.
        """
        resultado = await self.session.execute(
            update(Consignment)
            .where(
                Consignment.id == condicional_id,
                Consignment.status == StatusCondicional.ABERTA,
            )
            .values(
                status=StatusCondicional.FECHADA,
                closed_at=func.now(),
                closed_by_id=usuario_id,
                closing_uuid=closing_uuid,
            )
        )
        return (resultado.rowcount or 0) == 1

    async def ligar_venda(self, condicional_id: int, venda_id: int) -> None:
        await self.session.execute(
            update(Consignment).where(Consignment.id == condicional_id).values(sale_id=venda_id)
        )

    def _filtros(self, filtro: FiltroCondicionais, hoje: date, cliente_id: int | None) -> list:
        filtros = []
        if filtro == FiltroCondicionais.ABERTAS:
            filtros.append(Consignment.status == StatusCondicional.ABERTA)
        elif filtro == FiltroCondicionais.VENCIDAS:
            filtros += [
                Consignment.status == StatusCondicional.ABERTA,
                Consignment.due_date < hoje,
            ]
        elif filtro == FiltroCondicionais.FECHADAS:
            filtros.append(Consignment.status == StatusCondicional.FECHADA)
        if cliente_id is not None:
            filtros.append(Consignment.customer_id == cliente_id)
        return filtros

    async def listar(
        self, p: Paginacao, filtro: FiltroCondicionais, hoje: date, cliente_id: int | None
    ) -> tuple[list[Consignment], int]:
        filtros = self._filtros(filtro, hoje, cliente_id)
        total = await self.session.scalar(
            select(func.count()).select_from(Consignment).where(*filtros)
        )
        if filtro in (FiltroCondicionais.ABERTAS, FiltroCondicionais.VENCIDAS):
            # A que vence primeiro em cima: é a próxima ligação a fazer.
            ordem = (Consignment.due_date, Consignment.id)
        else:
            ordem = (Consignment.id.desc(),)
        stmt = select(Consignment).where(*filtros).order_by(*ordem).offset(p.offset).limit(p.limit)
        return list((await self.session.execute(stmt)).scalars().all()), int(total or 0)

    async def nomes(self, condicionais: list[Consignment]) -> dict[int, tuple]:
        """`id -> (cliente, telefone, vendedora, quem fechou)` de uma página inteira, numa
        consulta. Cliente excluída aparece com o nome que ficou (anonimizado, se for o caso):
        a condicional é passado da loja e continua de pé."""
        if not condicionais:
            return {}
        vendedora = aliased(User)
        fechou = aliased(User)
        stmt = (
            select(
                Consignment.id,
                Customer.name,
                Customer.phone,
                vendedora.name,
                fechou.name,
            )
            .join(Customer, Customer.id == Consignment.customer_id)
            .join(vendedora, vendedora.id == Consignment.seller_id)
            .outerjoin(fechou, fechou.id == Consignment.closed_by_id)
            .where(Consignment.id.in_([c.id for c in condicionais]))
        )
        return {linha[0]: tuple(linha[1:]) for linha in (await self.session.execute(stmt)).all()}

    async def pecas(self, variante_ids: list[int]) -> dict[int, tuple[ProductVariant, Product]]:
        """Peça e produto SEM filtrar exclusão: a condicional antiga continua legível."""
        if not variante_ids:
            return {}
        stmt = (
            select(ProductVariant, Product)
            .join(Product, Product.id == ProductVariant.product_id)
            .where(ProductVariant.id.in_(set(variante_ids)))
        )
        return {v.id: (v, p) for v, p in (await self.session.execute(stmt)).all()}
