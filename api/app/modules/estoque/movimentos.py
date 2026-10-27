"""Núcleo do estoque: a única forma de mudar um saldo.

Fica numa camada baixa (sem depender de catálogo ou vendas) porque quatro módulos precisam
dela — catálogo (estoque inicial), estoque (entrada/ajuste/inventário) e vendas (baixa e
estorno). Assim ninguém precisa importar o repository do outro.

Invariantes garantidas aqui:
- saldo só muda junto com uma linha em `stock_movements`, na mesma transação;
- o UPDATE é atômico por linha (`quantity + delta` no próprio banco), então duas vendas
  simultâneas da última peça serializam sozinhas;
- o CHECK `quantity >= 0` é a rede de segurança: quem perder a corrida recebe erro,
  nunca estoque negativo;
- mercadoria que ENTRA (delta positivo) só entra em peça ativa: antes do saldo, o catálogo
  trava a peça e diz qual a recebe (`catalogo.service.peca_que_recebe`, ADR-30). É a única
  pergunta que este módulo faz ao catálogo, e por isso a import é tardia.
"""

from sqlalchemy import select, update
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


async def travar_saldos(session: AsyncSession, variante_ids: list[int]) -> dict[int, int]:
    """Os saldos lidos COM trava (`FOR UPDATE`), em ordem de variant_id.

    Para quem decide pelo número antes de escrever: o inventário, que SUBSTITUI o saldo
    pelo contado, e a exclusão, que só vale com saldo zero. Ler solto e escrever depois
    deixava outra transação passar no meio: duas contagens de 8 sobre um saldo de 10 liam
    10 as duas, aplicavam -2 cada uma, e o saldo ia a 6.

    Peça que nunca movimentou não tem linha de saldo, e `FOR UPDATE` sem linha não trava
    nada: por isso quem chama trava a PEÇA antes (ADR-30), e é essa trava que segura a
    primeira entrada de uma peça sem saldo.
    """
    ids = ordenar_para_evitar_deadlock(variante_ids)
    if not ids:
        return {}
    linhas = await session.execute(
        select(StockBalance.variant_id, StockBalance.quantity)
        .where(StockBalance.variant_id.in_(ids))
        .order_by(StockBalance.variant_id)
        .with_for_update()
    )
    return {vid: qtd for vid, qtd in linhas.all()}


#: A mercadoria que volta da cliente. Se a peça saiu do catálogo depois da venda, ela não
#: pode ser recusada — está fisicamente de volta na loja (ADR-30).
_VOLTA_DA_CLIENTE = frozenset({TipoMovimento.ESTORNO, TipoMovimento.DEVOLUCAO})


async def aplicar_movimento(
    session: AsyncSession,
    *,
    variante_id: int,
    delta: int,
    tipo: TipoMovimento,
    user_id: int,
    entry_id: int | None = None,
    sale_id: int | None = None,
    return_id: int | None = None,
    observacao: str | None = None,
) -> StockMovement:
    """Aplica `delta` ao saldo e registra a movimentação. Devolve a movimentação criada.

    `delta` vem com sinal: positivo entra, negativo sai. Zero é recusado — movimentação que
    não move nada só polui o extrato.
    """
    if delta == 0:
        raise ValueError("Movimentação com quantidade zero não faz sentido.")

    if delta > 0:
        # Antes do saldo, a peça: travada, e ativa (ADR-30). Sem isto, a devolução de uma
        # venda de produto já excluído punha as peças numa peça invisível e invendável.
        # Import tardia: o catálogo importa este módulo.
        from app.modules.catalogo.service import peca_que_recebe

        variante_id, nota = await peca_que_recebe(
            session, variante_id, devolucao=tipo in _VOLTA_DA_CLIENTE
        )
        if nota:
            observacao = f"{observacao} — {nota}" if observacao else nota

    # UPDATE primeiro, INSERT só se a peça ainda não tem linha de saldo. Um
    # `INSERT ... ON CONFLICT DO UPDATE` não serve aqui: o Postgres avalia o CHECK do
    # valor inserido ANTES de detectar o conflito, então toda saída (delta negativo) de
    # uma peça já existente estouraria o CHECK sem nem chegar no UPDATE.
    atualizar = (
        update(StockBalance)
        .where(StockBalance.variant_id == variante_id)
        .values(quantity=StockBalance.quantity + delta)
        .returning(StockBalance.quantity)
    )
    try:
        saldo_apos = (await session.execute(atualizar)).scalar_one_or_none()

        if saldo_apos is None:
            if delta < 0:
                raise EstoqueInsuficiente(
                    "Esta peça não tem estoque.",
                    {"variante_id": variante_id, "quantidade_solicitada": abs(delta)},
                )
            # ON CONFLICT cobre a corrida entre duas primeiras entradas da mesma peça.
            criar = (
                insert(StockBalance)
                .values(variant_id=variante_id, quantity=delta)
                .on_conflict_do_update(
                    index_elements=[StockBalance.variant_id],
                    set_={"quantity": StockBalance.quantity + delta},
                )
                .returning(StockBalance.quantity)
            )
            saldo_apos = (await session.execute(criar)).scalar_one()
    except IntegrityError as exc:
        # Só o CHECK quantity >= 0 chega aqui: a corrida pelo último item foi perdida.
        await session.rollback()
        raise EstoqueInsuficiente(
            "Estoque insuficiente para concluir a operação.",
            {"variante_id": variante_id, "quantidade_solicitada": abs(delta)},
        ) from exc

    saldo_apos = int(saldo_apos)

    movimento = StockMovement(
        variant_id=variante_id,
        movement_type=tipo,
        quantity=delta,
        balance_after=saldo_apos,
        entry_id=entry_id,
        sale_id=sale_id,
        return_id=return_id,
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
