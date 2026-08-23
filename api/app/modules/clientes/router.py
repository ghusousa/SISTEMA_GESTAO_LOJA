"""Clientes e crediário. Tudo aqui exige `GERIR_CREDIARIO`.

A porta é única de propósito: quem pode cadastrar cliente é quem pode vender fiado e
receber — separar as três coisas daria a impressão de controle e só multiplicaria telas.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Query, status

from app.core.deps import ExigeCrediario, SessionDep
from app.core.pagination import Pagina, Paginacao, paginacao
from app.modules.clientes.schemas import (
    ClienteIn,
    ClienteOut,
    ClienteUpdate,
    ExtratoClienteOut,
    PagamentoClienteIn,
    PagamentoClienteOut,
)
from app.modules.clientes.service import ClienteService

router = APIRouter(prefix="/clientes", tags=["clientes"])


@router.get("", response_model=Pagina[ClienteOut], summary="Lista clientes")
async def listar(
    session: SessionDep,
    _: ExigeCrediario,
    p: Annotated[Paginacao, Depends(paginacao)],
    q: Annotated[str | None, Query(description="Nome, telefone ou documento")] = None,
    somente_devendo: bool = False,
) -> Pagina[ClienteOut]:
    return await ClienteService(session).listar(p, q, somente_devendo)


@router.post("", response_model=ClienteOut, status_code=status.HTTP_201_CREATED)
async def criar(session: SessionDep, _: ExigeCrediario, dados: ClienteIn) -> ClienteOut:
    return await ClienteService(session).criar(dados)


@router.get("/{cliente_id}", response_model=ClienteOut, summary="Detalhe do cliente")
async def obter(session: SessionDep, _: ExigeCrediario, cliente_id: int) -> ClienteOut:
    return await ClienteService(session).obter(cliente_id)


@router.get(
    "/{cliente_id}/extrato",
    response_model=ExtratoClienteOut,
    summary="O que deve, o que já pagou",
)
async def extrato(
    session: SessionDep, _: ExigeCrediario, cliente_id: int
) -> ExtratoClienteOut:
    return await ClienteService(session).extrato(cliente_id)


@router.patch("/{cliente_id}", response_model=ClienteOut)
async def atualizar(
    session: SessionDep, _: ExigeCrediario, cliente_id: int, dados: ClienteUpdate
) -> ClienteOut:
    return await ClienteService(session).atualizar(cliente_id, dados)


@router.delete("/{cliente_id}", status_code=status.HTTP_204_NO_CONTENT)
async def excluir(session: SessionDep, _: ExigeCrediario, cliente_id: int) -> None:
    await ClienteService(session).excluir(cliente_id)


@router.post(
    "/{cliente_id}/pagamentos",
    response_model=PagamentoClienteOut,
    status_code=status.HTTP_201_CREATED,
    summary="A cliente veio pagar o que devia",
)
async def receber(
    session: SessionDep,
    usuario: ExigeCrediario,
    cliente_id: int,
    dados: PagamentoClienteIn,
) -> PagamentoClienteOut:
    return await ClienteService(session).receber(cliente_id, dados, usuario)
