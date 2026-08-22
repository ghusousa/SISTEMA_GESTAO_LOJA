"""Núcleo do estoque: a única forma de mudar um saldo.

Fica numa camada baixa (sem depender de catálogo ou vendas) porque quatro módulos precisam
dela — catálogo (estoque inicial), estoque (entrada/ajuste/inventário) e vendas (baixa e
estorno). Assim ninguém precisa importar o repository do outro.

Invariantes garantidas aqui:
- saldo só muda junto com uma linha em `stock_movements`, na mesma transação;
- o UPDATE é atômico por linha (`quantity + delta` no próprio banco), então duas vendas
  simultâneas da última peça serializam sozinhas;
- o CHECK `quantity >= 0` é a rede de segurança: quem perder a corrida recebe erro,
  nunca estoque negativo.
"""

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import EstoqueInsuficiente
from app.modules.estoque.models import StockBalance, StockMovement, TipoMovimento


async def saldo_atual(session: AsyncSession, variante_id: int) -> int:
    saldo = await session.scalar(
        select(StockBalance.quantity).where(StockBalance.variant_id == variante_id)
    )
    return int(saldo or 0)


async def saldos_de(session: AsyncSession, variante_ids: list[int]) -> dict[int, int]:
    if not variante_ids:
        return {}
    linhas = await session.execute(
        select(StockBalance.variant_id, StockBalance.quantity).where(
            StockBalance.variant_id.in_(variante_ids)
        )
    )
    return {vid: qtd for vid, qtd in linhas.all()}


async def aplicar_movimento(
    session: AsyncSession,
    *,
    variante_id: int,
    delta: int,
    tipo: TipoMovimento,
    user_id: int,
    entry_id: int | None = None,
    sale_id: int | None = None,
    observacao: str | None = None,
) -> StockMovement:
    """Aplica `delta` ao saldo e registra a movimentação. Devolve a movimentação criada.

    `delta` vem com sinal: positivo entra, negativo sai. Zero é recusado — movimentação que
    não move nada só polui o extrato.
    """
    if delta == 0:
        raise ValueError("Movimentação com quantidade zero não faz sentido.")

    stmt = (
        insert(StockBalance)
        .values(variant_id=variante_id, quantity=delta)
        .on_conflict_do_update(
            index_elements=[StockBalance.variant_id],
            set_={"quantity": StockBalance.quantity + delta},
        )
        .returning(StockBalance.quantity)
    )
    try:
        saldo_apos = int((await session.execute(stmt)).scalar_one())
    except IntegrityError as exc:
        # Só o CHECK quantity >= 0 pode falhar aqui: a corrida foi perdida.
        await session.rollback()
        raise EstoqueInsuficiente(
            "Estoque insuficiente para concluir a operação.",
            {"variante_id": variante_id, "quantidade_solicitada": abs(delta)},
        ) from exc

    movimento = StockMovement(
        variant_id=variante_id,
        movement_type=tipo,
        quantity=delta,
        balance_after=saldo_apos,
        entry_id=entry_id,
        sale_id=sale_id,
        user_id=user_id,
        note=observacao,
    )
    session.add(movimento)
    await session.flush()
    return movimento


async def conferir_disponibilidade(
    session: AsyncSession, necessidades: dict[int, int]
) -> None:
    """Erro amigável ANTES de tentar a baixa: diz qual peça faltou e quanto tem.

    Não substitui o CHECK — entre esta conferência e a baixa outra venda pode passar.
    """
    saldos = await saldos_de(session, list(necessidades))
    faltantes = [
        {"variante_id": vid, "solicitado": qtd, "disponivel": saldos.get(vid, 0)}
        for vid, qtd in necessidades.items()
        if saldos.get(vid, 0) < qtd
    ]
    if faltantes:
        raise EstoqueInsuficiente(
            "Não há estoque suficiente para todos os itens.", {"itens": faltantes}
        )


def ordenar_para_evitar_deadlock(variante_ids: list[int]) -> list[int]:
    """Duas transações que travam as mesmas linhas em ordens opostas se abraçam.

    Escrever sempre na ordem crescente de variante_id elimina esse abraço.
    """
    return sorted(set(variante_ids))
