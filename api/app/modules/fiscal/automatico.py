"""Emissão automática da NFC-e logo depois da venda (FISCAL_EMITIR_AUTOMATICO=1).

**Fora da transação da venda, sempre.** A venda grava, faz commit e responde ao PDV; só
então, numa tarefa à parte com sessão própria, a nota é pedida ao emissor. Emissor fora
do ar, produto sem NCM, SEFAZ lenta — nada disso chega ao balcão: fica registrado na nota
(ou no log) e a venda já está feita. É a regra do ADR-41: falha fiscal nunca impede vender.

Quem avisa é o commit do SQLAlchemy, como em `core/eventos.py`: a venda nova aparece no
flush e a tarefa nasce no `after_commit`. Rollback não emite nada.
"""

import asyncio
import logging

from app.core.config import settings
from app.core.db import SessionLocal
from app.core.exceptions import AppError

log = logging.getLogger(__name__)

_CHAVE = "_vendas_para_nfce"
#: Referência forte às tarefas em voo: o asyncio só guarda referência fraca, e tarefa sem
#: dono pode ser coletada no meio. Também é o que o teste aguarda.
_em_voo: set[asyncio.Task] = set()


async def emitir_em_segundo_plano(venda_id: int, vendedor_id: int) -> None:
    from app.modules.fiscal.service import FiscalService

    async with SessionLocal() as sessao:
        try:
            nfce = await FiscalService(sessao).emitir_pelo_sistema(venda_id, vendedor_id)
            if nfce.nota is not None:
                log.info("NFC-e da venda #%s: %s", venda_id, nfce.nota.status)
        except AppError as exc:
            log.info("NFC-e da venda #%s não emitida: %s %s", venda_id, exc.message, exc.detail)
        except Exception:  # noqa: BLE001 — a tarefa é sozinha; ninguém mais veria o erro
            log.exception("Falha inesperada emitindo a NFC-e da venda #%s", venda_id)


async def aguardar_emissoes() -> None:
    """Para os testes (e um desligamento educado): espera as emissões em voo."""
    while _em_voo:
        pendentes = list(_em_voo)
        await asyncio.gather(*pendentes, return_exceptions=True)
        # Tira na mão: o `discard` do done_callback só roda na próxima volta do loop, e
        # esperar por ele aqui seria um laço sem fim sobre tarefas já terminadas.
        _em_voo.difference_update(pendentes)


def registrar_emissao_automatica() -> None:
    from sqlalchemy import event
    from sqlalchemy.orm import Session

    @event.listens_for(Session, "after_flush")
    def _anotar(sessao: Session, _contexto: object) -> None:
        if not settings.fiscal_emitir_automatico:
            return
        for obj in sessao.new:
            if getattr(obj, "__tablename__", None) == "sales":
                sessao.info.setdefault(_CHAVE, {})[obj.id] = obj.seller_id

    @event.listens_for(Session, "after_commit")
    def _disparar(sessao: Session) -> None:
        vendas: dict[int, int] = sessao.info.pop(_CHAVE, {})
        if not vendas:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:  # commit fora do servidor (CLI, script): sem emissão sozinha
            return
        for venda_id, vendedor_id in vendas.items():
            tarefa = loop.create_task(emitir_em_segundo_plano(venda_id, vendedor_id))
            _em_voo.add(tarefa)
            tarefa.add_done_callback(_em_voo.discard)

    @event.listens_for(Session, "after_rollback")
    def _esquecer(sessao: Session) -> None:
        sessao.info.pop(_CHAVE, None)
