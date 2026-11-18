"""Contas a pagar do fornecedor. O módulo inteiro é de quem vê dinheiro (ADR-40).

A vendedora dá entrada de mercadoria, mas a nota do fornecedor — quanto a loja pagou e
quando paga — é informação de resultado, como o custo da peça.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response, status

from app.core.deps import ExigeDinheiro, SessionDep
from app.core.pagination import Pagina, Paginacao, paginacao
from app.modules.contas_pagar.schemas import (
    ContaPagarIn,
    ContaPagarOut,
    ContaPagarUpdate,
    FiltroContas,
    LancamentoContasOut,
    PagamentoContaIn,
    ResumoContasOut,
)
from app.modules.contas_pagar.service import ContaPagarService

router = APIRouter(prefix="/contas-pagar", tags=["contas a pagar"])


# Rotas de nome fixo antes de `/{conta_id}`: senão "resumo" seria lido como id.
@router.get(
    "/resumo",
    response_model=ResumoContasOut,
    summary="Vencidas, a pagar nos próximos 7 dias e total em aberto (rota leve, para aviso)",
)
async def resumo(session: SessionDep, _: ExigeDinheiro) -> ResumoContasOut:
    return await ContaPagarService(session).resumo()


@router.get("", response_model=Pagina[ContaPagarOut], summary="Lista as contas a pagar")
async def listar(
    session: SessionDep,
    _: ExigeDinheiro,
    p: Annotated[Paginacao, Depends(paginacao)],
    situacao: Annotated[
        FiltroContas, Query(description="abertas (padrão), vencidas, proximos_7_dias, pagas, todas")
    ] = FiltroContas.ABERTAS,
    fornecedor: Annotated[str | None, Query(max_length=120)] = None,
    entrada_id: int | None = None,
) -> Pagina[ContaPagarOut]:
    return await ContaPagarService(session).listar(p, situacao, fornecedor, entrada_id)


@router.post(
    "",
    response_model=LancamentoContasOut,
    status_code=status.HTTP_201_CREATED,
    summary="Lança uma nota de fornecedor sem Entrada (uma conta por parcela, idempotente)",
)
async def lancar(
    session: SessionDep, usuario: ExigeDinheiro, dados: ContaPagarIn, resposta: Response
) -> LancamentoContasOut:
    servico = ContaPagarService(session)
    lancamento = await servico.lancar(dados, usuario)
    if servico.replay:
        resposta.status_code = status.HTTP_200_OK
    return lancamento


@router.get("/{conta_id}", response_model=ContaPagarOut, summary="Detalhe da conta")
async def obter(session: SessionDep, _: ExigeDinheiro, conta_id: int) -> ContaPagarOut:
    return await ContaPagarService(session).obter(conta_id)


@router.patch("/{conta_id}", response_model=ContaPagarOut, summary="Corrige uma conta aberta")
async def editar(
    session: SessionDep, _: ExigeDinheiro, conta_id: int, dados: ContaPagarUpdate
) -> ContaPagarOut:
    return await ContaPagarService(session).editar(conta_id, dados)


@router.delete(
    "/{conta_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Exclui uma conta aberta"
)
async def excluir(session: SessionDep, _: ExigeDinheiro, conta_id: int) -> Response:
    await ContaPagarService(session).excluir(conta_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/{conta_id}/pagamento",
    response_model=ContaPagarOut,
    summary="Marca a conta como paga (dia e forma). Reenvio igual é atendido",
)
async def pagar(
    session: SessionDep, usuario: ExigeDinheiro, conta_id: int, dados: PagamentoContaIn
) -> ContaPagarOut:
    return await ContaPagarService(session).pagar(conta_id, dados, usuario)


@router.delete(
    "/{conta_id}/pagamento",
    response_model=ContaPagarOut,
    summary="Desfaz o pagamento marcado por engano: a conta volta a ser devida",
)
async def desfazer_pagamento(session: SessionDep, _: ExigeDinheiro, conta_id: int) -> ContaPagarOut:
    return await ContaPagarService(session).desfazer_pagamento(conta_id)
