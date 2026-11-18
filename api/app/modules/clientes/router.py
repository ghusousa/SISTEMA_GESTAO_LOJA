"""Clientes e crediário.

Duas portas, dois schemas (ADR-36):

- **Balcão** (`ATENDER_CLIENTE`, da vendedora em diante): buscar, cadastrar e ver os
  aniversariantes, para pôr o nome da cliente em QUALQUER venda. Responde
  `ClienteBalcaoOut` — sem saldo, sem limite, sem observação do crediário.
- **Crediário** (`GERIR_CREDIARIO`): a ficha completa, o extrato, o fiado e o recebimento.
  Quem pode ver a dívida é quem pode vender fiado e receber.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response, status

from app.core.deps import ExigeAtenderCliente, ExigeCrediario, SessionDep
from app.core.pagination import Pagina, Paginacao, paginacao
from app.modules.clientes.schemas import (
    ClienteBalcaoIn,
    ClienteBalcaoOut,
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


# As rotas de nome fixo vêm ANTES de `/{cliente_id}`: senão "balcao" seria lido como id.
@router.get(
    "/balcao",
    response_model=Pagina[ClienteBalcaoOut],
    summary="Busca cliente no balcão (sem saldo nem limite)",
)
async def buscar_no_balcao(
    session: SessionDep,
    _: ExigeAtenderCliente,
    p: Annotated[Paginacao, Depends(paginacao)],
    q: Annotated[str | None, Query(description="Nome, telefone ou documento")] = None,
) -> Pagina[ClienteBalcaoOut]:
    return await ClienteService(session).buscar_no_balcao(p, q)


@router.post(
    "/balcao",
    response_model=ClienteBalcaoOut,
    status_code=status.HTTP_201_CREATED,
    summary="Cadastra cliente no balcão (idempotente por client_uuid)",
)
async def cadastrar_no_balcao(
    session: SessionDep, _: ExigeAtenderCliente, dados: ClienteBalcaoIn, resposta: Response
) -> ClienteBalcaoOut:
    servico = ClienteService(session)
    cliente = await servico.cadastrar_no_balcao(dados)
    if servico.replay:
        resposta.status_code = status.HTTP_200_OK
    return cliente


@router.get(
    "/aniversariantes",
    response_model=Pagina[ClienteBalcaoOut],
    summary="Quem faz aniversário no mês, na ordem do calendário",
)
async def aniversariantes(
    session: SessionDep,
    _: ExigeAtenderCliente,
    p: Annotated[Paginacao, Depends(paginacao)],
    mes: Annotated[
        int | None, Query(ge=1, le=12, description="1 a 12; sem ele, o mês de hoje na loja")
    ] = None,
) -> Pagina[ClienteBalcaoOut]:
    return await ClienteService(session).aniversariantes(p, mes)


@router.get("/{cliente_id}", response_model=ClienteOut, summary="Detalhe do cliente")
async def obter(session: SessionDep, _: ExigeCrediario, cliente_id: int) -> ClienteOut:
    return await ClienteService(session).obter(cliente_id)


@router.get(
    "/{cliente_id}/extrato",
    response_model=ExtratoClienteOut,
    summary="O que deve, o que já pagou",
)
async def extrato(
    session: SessionDep,
    _: ExigeCrediario,
    cliente_id: int,
    p: Annotated[Paginacao, Depends(paginacao)],
) -> ExtratoClienteOut:
    return await ClienteService(session).extrato(cliente_id, p)


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
    resposta: Response,
) -> PagamentoClienteOut:
    servico = ClienteService(session)
    pagamento = await servico.receber(cliente_id, dados, usuario)
    if servico.replay:
        # ADR-2: o reenvio responde 200 com o recebimento que já existia, não 201.
        resposta.status_code = status.HTTP_200_OK
    return pagamento
