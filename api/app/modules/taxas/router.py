"""A porta da tabela de taxas da maquininha.

Ler é de quem vê dinheiro (`VER_DINHEIRO`): o gerente lê o Resultado, que já desconta as
taxas, e precisa poder conferir de onde saiu o número. Mudar é do dono
(`CONFIGURAR_LOJA`): a taxa é o contrato que ELE assinou com a credenciadora, e mexer nela
muda o resultado de todas as vendas dali em diante (ADR-35).
"""

from typing import Annotated

from fastapi import APIRouter, Depends, status

from app.core.deps import ExigeConfigurarLoja, ExigeDinheiro, SessionDep
from app.core.pagination import Pagina, Paginacao, paginacao
from app.modules.taxas.schemas import TaxaIn, TaxaOut, TaxaUpdate
from app.modules.taxas.service import TaxaService

router = APIRouter(prefix="/taxas-cartao", tags=["taxas"])


@router.get("", response_model=Pagina[TaxaOut], summary="Taxas da maquininha por forma e parcela")
async def listar(
    session: SessionDep,
    _: ExigeDinheiro,
    p: Annotated[Paginacao, Depends(paginacao)],
) -> Pagina[TaxaOut]:
    return await TaxaService(session).listar(p)


@router.post("", response_model=TaxaOut, status_code=status.HTTP_201_CREATED)
async def criar(session: SessionDep, _: ExigeConfigurarLoja, dados: TaxaIn) -> TaxaOut:
    return await TaxaService(session).criar(dados)


@router.patch("/{taxa_id}", response_model=TaxaOut)
async def atualizar(
    session: SessionDep, _: ExigeConfigurarLoja, taxa_id: int, dados: TaxaUpdate
) -> TaxaOut:
    return await TaxaService(session).atualizar(taxa_id, dados)


@router.delete("/{taxa_id}", status_code=status.HTTP_204_NO_CONTENT)
async def excluir(session: SessionDep, _: ExigeConfigurarLoja, taxa_id: int) -> None:
    await TaxaService(session).excluir(taxa_id)
