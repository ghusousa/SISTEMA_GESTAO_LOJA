"""Excluir a conta (ADR-45) e mexer no leitor do MESMO login (ADR-43/47) ao mesmo tempo, sem impasse.

A exclusão trava a conta (`travar_viva`, FOR UPDATE) e DEPOIS apaga os pareamentos dela (pelo
CASCADE, sem histórico, ou por `esquecer_usuario`, com histórico). O leitor fazia o inverso:
travava um pareamento do login ("Chamar de novo" e "Gerar código novo" pelo `_substituir`; o
atender pelo `chamado_para_atender`) e só depois precisava da conta, na checagem da FK do que
grava (FOR KEY SHARE, que espera o FOR UPDATE da exclusão). Cada um segurava o que o outro
esperava, e o Postgres derrubava um dos dois com 40P01 — um 500 para a dona que excluía a conta
ou para quem chamava/atendia.

A correção é a mesma ordem de travas nos dois lados: o leitor trava a conta (FOR KEY SHARE)
ANTES de qualquer pareamento (`LeitorRepository.travar_conta`). A exclusão passa a esperar na
fila, sem ciclo; e quem perde a corrida recebe 404 (a conta já não existe), nunca 500.
"""

import asyncio
import uuid
from datetime import timedelta

import pytest
from sqlalchemy.exc import DBAPIError

from app.modules.leitor import service
from app.modules.usuarios.repository import UsuarioRepository
from tests.test_leitor import _alguem_esperando_trava, _cliente, _criar, _sql
from tests.test_leitor_chamado import _atender, _chamado, _chamar


@pytest.fixture(autouse=True)
def _sem_intervalo(monkeypatch: pytest.MonkeyPatch) -> None:
    """O teto de 2 s entre chamados não é o assunto (na vida real o "Chamar de novo" vem
    bem depois dos 2 s)."""
    monkeypatch.setattr(service, "INTERVALO_ENTRE_CHAMADOS", timedelta(0))


def _impasse(resultado: object) -> bool:
    if isinstance(resultado, DBAPIError):
        orig = getattr(resultado, "orig", None)
        for erro in (orig, getattr(orig, "__cause__", None)):
            if getattr(erro, "sqlstate", None) == "40P01":
                return True
    return False


def _status(resultado: object) -> object:
    return resultado if isinstance(resultado, BaseException) else resultado.status_code


async def _pausar_exclusao(monkeypatch: pytest.MonkeyPatch):
    """A exclusão para logo depois de travar a conta, até o outro pedido estar esperando."""
    travou, seguir = asyncio.Event(), asyncio.Event()
    travar_viva = UsuarioRepository.travar_viva

    async def travar_e_parar(self, user_id: int) -> bool:
        achou = await travar_viva(self, user_id)
        travou.set()
        await asyncio.wait_for(seguir.wait(), timeout=10)
        return achou

    monkeypatch.setattr(UsuarioRepository, "travar_viva", travar_e_parar)
    return travou, seguir


async def _com_historico(user_id: int) -> None:
    # Com histórico a linha da conta fica (FK RESTRICT) e os pareamentos saem por
    # `esquecer_usuario`; sem histórico, saem pelo CASCADE do DELETE da conta.
    await _sql(
        "INSERT INTO cash_closings (closing_date, user_id, total_expected, total_counted) "
        "VALUES (current_date, :u, 0, 0)",
        u=user_id,
    )


async def _correr(primeiro, segundo, travou: asyncio.Event, seguir: asyncio.Event):
    a = asyncio.create_task(primeiro())
    await asyncio.wait_for(travou.wait(), timeout=10)
    b = asyncio.create_task(segundo())
    await _alguem_esperando_trava()
    seguir.set()
    return await asyncio.wait_for(asyncio.gather(a, b, return_exceptions=True), timeout=30)


HISTORICO = pytest.mark.parametrize("historico", [True, False], ids=["com-historico", "sem-historico"])


@HISTORICO
async def test_chamar_de_novo_durante_a_exclusao_da_conta(
    client, vendedor, auth_admin, auth_vendedor, monkeypatch, historico
) -> None:
    antigo = await _chamado(client, auth_vendedor)
    if historico:
        await _com_historico(vendedor.id)
    travou, seguir = await _pausar_exclusao(monkeypatch)

    async def excluir():
        async with _cliente() as c:
            return await c.delete(f"/usuarios/{vendedor.id}", headers=auth_admin)

    async def chamar_de_novo():
        async with _cliente() as c:
            return await _chamar(c, auth_vendedor, substitui_id=antigo["id"])

    exclusao, chamado = await _correr(excluir, chamar_de_novo, travou, seguir)
    assert not _impasse(exclusao) and not _impasse(chamado), "40P01: um dos dois levou 500"
    assert _status(exclusao) == 204
    # O chamado esperou a conta e a achou excluída: 404 (ou 401, se o login já caiu antes).
    assert _status(chamado) in (401, 404), getattr(chamado, "text", chamado)


@HISTORICO
async def test_atender_durante_a_exclusao_da_conta(
    client, vendedor, auth_admin, auth_vendedor, monkeypatch, historico
) -> None:
    chamado = await _chamado(client, auth_vendedor)
    if historico:
        await _com_historico(vendedor.id)
    travou, seguir = await _pausar_exclusao(monkeypatch)

    async def excluir():
        async with _cliente() as c:
            return await c.delete(f"/usuarios/{vendedor.id}", headers=auth_admin)

    async def atender():
        async with _cliente() as c:
            return await _atender(c, auth_vendedor, chamado["id"], uuid.uuid4())

    exclusao, atendimento = await _correr(excluir, atender, travou, seguir)
    assert not _impasse(exclusao) and not _impasse(atendimento), "40P01: um dos dois levou 500"
    assert _status(exclusao) == 204
    assert _status(atendimento) in (401, 404), getattr(atendimento, "text", atendimento)


@HISTORICO
async def test_exclusao_que_chega_depois_do_atender_espera_e_conclui(
    client, vendedor, auth_admin, auth_vendedor, monkeypatch, historico
) -> None:
    """A outra ordem: o atender já passou da trava da conta quando a exclusão começa. A
    exclusão espera o atender terminar e então apaga tudo — nenhum dos dois leva 500."""
    chamado = await _chamado(client, auth_vendedor)
    if historico:
        await _com_historico(vendedor.id)

    travou, seguir = asyncio.Event(), asyncio.Event()
    ligar = service.LeitorService._ligar

    async def ligar_parado(self, *a, **k):
        travou.set()  # a conta e o chamado já estão travados
        await asyncio.wait_for(seguir.wait(), timeout=10)
        return await ligar(self, *a, **k)

    monkeypatch.setattr(service.LeitorService, "_ligar", ligar_parado)

    async def atender():
        async with _cliente() as c:
            return await _atender(c, auth_vendedor, chamado["id"], uuid.uuid4())

    async def excluir():
        async with _cliente() as c:
            return await c.delete(f"/usuarios/{vendedor.id}", headers=auth_admin)

    atendimento, exclusao = await _correr(atender, excluir, travou, seguir)
    assert not _impasse(exclusao), "a EXCLUSÃO caiu no impasse (40P01): 500 para a dona"
    assert not _impasse(atendimento)
    assert _status(atendimento) == 200
    assert _status(exclusao) == 204


@HISTORICO
async def test_qr_codigo_novo_durante_a_exclusao_da_conta(
    client, vendedor, auth_admin, auth_vendedor, monkeypatch, historico
) -> None:
    """O mesmo impasse já existia no "Gerar código novo" do QR (ADR-43): a mesma trava o fecha."""
    antigo = await _criar(client, auth_vendedor)
    if historico:
        await _com_historico(vendedor.id)
    travou, seguir = await _pausar_exclusao(monkeypatch)

    async def excluir():
        async with _cliente() as c:
            return await c.delete(f"/usuarios/{vendedor.id}", headers=auth_admin)

    async def codigo_novo():
        async with _cliente() as c:
            return await c.post(
                "/leitor/pareamentos", headers=auth_vendedor, json={"substitui_id": antigo["id"]}
            )

    exclusao, novo = await _correr(excluir, codigo_novo, travou, seguir)
    assert not _impasse(exclusao) and not _impasse(novo), "40P01: um dos dois levou 500"
    assert _status(exclusao) == 204
    assert _status(novo) in (401, 404), getattr(novo, "text", novo)
