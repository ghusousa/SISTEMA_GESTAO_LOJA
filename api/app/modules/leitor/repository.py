"""Leitura e escrita de `leitor_pareamentos` e `leitor_bipes`. Só o módulo leitor mexe aqui.

Uma regra que não aparece em nenhuma assinatura: **o que o `retirar` escreve passa por SQL
Core, nunca por objeto ORM.** O aviso de tempo real sai do commit do ORM (`core/eventos.py`),
e o computador refaz a retirada quando ouve "leitor". Se retirar gerasse aviso, cada tela
pareada retiraria de novo por causa da própria retirada — eco sem fim, de 2 em 2 s.
"""

import uuid
from datetime import datetime, timedelta

from sqlalchemy import delete, func, select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.leitor.models import LeitorBipe, LeitorPareamento
from app.modules.usuarios.models import User

#: Espaço das travas `pg_advisory_*` do leitor (o número lembra o ADR-43).
_ESPACO_TRAVA_LEITOR = 43

#: Bipe guardado mais que isto já foi entregue ou descartado há muito: a faxina apaga.
VIDA_DO_BIPE = timedelta(days=1)
#: Pareamento terminado (encerrado ou vencido) há mais que isto some da tabela.
VIDA_DO_PAREAMENTO_TERMINADO = timedelta(days=30)


class LeitorRepository:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def agora(self) -> datetime:
        """O relógio do BANCO, e o mesmo instante a transação inteira (`now()`).

        Os prazos são gravados e comparados em SQL (`criado_em` nasce do `now()` do banco);
        o status calculado em Python precisa do mesmo relógio, senão um servidor com a hora
        adiantada (uma instância na Vercel, outra na loja) veria ATIVO o que o SQL já
        tratou como vencido.
        """
        return (await self.session.execute(text("SELECT now()"))).scalar_one()

    # ------------------------------------------------------------------ pareamento

    async def obter(
        self, pareamento_id: int, *, travar: bool = False
    ) -> LeitorPareamento | None:
        stmt = (
            select(LeitorPareamento)
            .where(LeitorPareamento.id == pareamento_id)
            .execution_options(populate_existing=True)
        )
        if travar:
            # Desligar contra aceitar ao mesmo tempo: quem chega depois lê a linha como o
            # outro a deixou, e não por cima de uma versão velha.
            stmt = stmt.with_for_update()
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def nomes(self, *user_ids: int | None) -> dict[int, str]:
        ids = {i for i in user_ids if i is not None}
        if not ids:
            return {}
        linhas = await self.session.execute(select(User.id, User.name).where(User.id.in_(ids)))
        return {uid: nome for uid, nome in linhas.all()}

    async def inserir(self, pareamento: LeitorPareamento) -> bool:
        """Grava o pareamento novo. False se o código sorteado já está AGUARDANDO em outro.

        Num savepoint: a colisão (31^6 códigos — rara, mas o UNIQUE parcial é quem decide)
        desfaz só esta tentativa, e o que a transação já fez antes (encerrar o substituído,
        a faxina) continua de pé para a próxima tentativa com outro código.
        """
        # O que a transação já mudou (o substituído encerrado) vai ANTES do savepoint: um
        # rollback dele desfaria também o que foi gravado dentro, e o encerramento sumiria.
        await self.session.flush()
        try:
            async with self.session.begin_nested():
                self.session.add(pareamento)
                await self.session.flush()
        except IntegrityError:
            return False
        return True

    async def vivos_do_computador(
        self, user_id: int, agora: datetime
    ) -> list[LeitorPareamento]:
        """Os que ainda servem para alguma coisa (AGUARDANDO ou ATIVO), do mais novo ao mais
        velho."""
        stmt = (
            select(LeitorPareamento)
            .where(
                LeitorPareamento.computador_user_id == user_id,
                LeitorPareamento.encerrado_em.is_(None),
                func.coalesce(LeitorPareamento.expira_em, LeitorPareamento.codigo_expira_em)
                > agora,
            )
            .order_by(LeitorPareamento.id.desc())
            # Sem FOR UPDATE de propósito: o aceite trava a linha dele e depois as do
            # celular, e travar aqui várias de uma vez abriria a porta para um deadlock entre
            # os dois. O encerramento grava só `encerrado_em`/`motivo`; o aceite que correr
            # junto continua inteiro e a linha fica aceita E encerrada, que é ENCERRADO.
            .execution_options(populate_existing=True)
        )
        return list((await self.session.execute(stmt)).scalars())

    async def aguardando_por_codigo(
        self, codigo: str, agora: datetime
    ) -> LeitorPareamento | None:
        """O pareamento que este código ainda abre — travado até o commit.

        Dois celulares no mesmo código: o segundo espera a trava da linha; quando o primeiro
        commita, o Postgres reavalia o WHERE na versão nova (`aceito_em` preenchido) e o
        segundo não acha nada. Só um ganha, sem checagem em memória.
        """
        stmt = (
            select(LeitorPareamento)
            .where(
                LeitorPareamento.codigo == codigo,
                LeitorPareamento.aceito_em.is_(None),
                LeitorPareamento.encerrado_em.is_(None),
                LeitorPareamento.codigo_expira_em > agora,
            )
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def aceito_pelo_aparelho(
        self, codigo: str, user_id: int, agora: datetime
    ) -> LeitorPareamento | None:
        """O pareamento que ESTE celular já ligou com este código, para o reenvio do aceite.

        Só ainda ATIVO e dentro dos 5 min do código: o reenvio é de uma resposta que se
        perdeu agora há pouco, não um jeito de reabrir leitor antigo.
        """
        stmt = (
            select(LeitorPareamento)
            .where(
                LeitorPareamento.codigo == codigo,
                LeitorPareamento.aparelho_user_id == user_id,
                LeitorPareamento.encerrado_em.is_(None),
                LeitorPareamento.expira_em > agora,
                LeitorPareamento.codigo_expira_em > agora,
            )
            .order_by(LeitorPareamento.id.desc())
            .limit(1)
        )
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def travar_aparelho(self, user_id: int) -> None:
        """Um aceite por vez do MESMO celular (usuário), até o commit.

        "Um celular, um computador" é ler-para-escrever: aceitar encerra os outros ATIVOS
        deste celular. Dois aceites simultâneos (dois códigos) não veriam um ao outro e o
        celular ficaria ligado em dois computadores. `pg_advisory_xact_lock` some sozinha
        no commit ou no rollback.
        """
        await self.session.execute(
            text("SELECT pg_advisory_xact_lock(:espaco, :usuario)"),
            {"espaco": _ESPACO_TRAVA_LEITOR, "usuario": user_id},
        )

    async def ativos_do_aparelho(
        self, user_id: int, agora: datetime, *, exceto_id: int
    ) -> list[LeitorPareamento]:
        stmt = (
            select(LeitorPareamento)
            .where(
                LeitorPareamento.aparelho_user_id == user_id,
                LeitorPareamento.id != exceto_id,
                LeitorPareamento.encerrado_em.is_(None),
                LeitorPareamento.expira_em > agora,
            )
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return list((await self.session.execute(stmt)).scalars())

    async def faxina(self, agora: datetime) -> None:
        """Apaga o que já não serve a ninguém. Barata: roda a cada código gerado.

        Pareamento "terminou" no primeiro destes: encerrado, ou o prazo que valia para ele
        (o do código, se ninguém aceitou; as 12 h, se aceitou). `LEAST` ignora o NULL.
        Os bipes dele vão junto (`ON DELETE CASCADE`).
        """
        await self.session.execute(
            delete(LeitorBipe)
            .where(LeitorBipe.criado_em < agora - VIDA_DO_BIPE)
            .execution_options(synchronize_session=False)
        )
        terminou = func.least(
            LeitorPareamento.encerrado_em,
            func.coalesce(LeitorPareamento.expira_em, LeitorPareamento.codigo_expira_em),
        )
        await self.session.execute(
            delete(LeitorPareamento)
            .where(terminou < agora - VIDA_DO_PAREAMENTO_TERMINADO)
            .execution_options(synchronize_session=False)
        )

    # ------------------------------------------------------------------ bipes

    async def bipe_por_client_uuid(self, client_uuid: uuid.UUID) -> LeitorBipe | None:
        stmt = (
            select(LeitorBipe)
            .where(LeitorBipe.client_uuid == client_uuid)
            .execution_options(populate_existing=True)
        )
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def aparelho_do_pareamento(self, pareamento_id: int) -> int | None:
        return await self.session.scalar(
            select(LeitorPareamento.aparelho_user_id).where(LeitorPareamento.id == pareamento_id)
        )

    async def pendentes(self, pareamento_id: int) -> int:
        return (
            await self.session.scalar(
                select(func.count())
                .select_from(LeitorBipe)
                .where(LeitorBipe.pareamento_id == pareamento_id, LeitorBipe.consumido_em.is_(None))
            )
        ) or 0

    async def consumir(
        self, pareamento_id: int, agora: datetime, *, limite: int | None
    ) -> list[tuple[int, str, datetime]]:
        """Marca como consumidos os pendentes mais antigos e devolve (id, código, criado_em).

        Atômico e uma vez só: o `SKIP LOCKED` faz duas retiradas simultâneas (duas abas do
        mesmo computador) pegarem lotes disjuntos — a segunda pula o que a primeira travou,
        em vez de esperar e entregar de novo. SQL Core de propósito (ver o topo do módulo).
        """
        alvo = (
            select(LeitorBipe.id)
            .where(LeitorBipe.pareamento_id == pareamento_id, LeitorBipe.consumido_em.is_(None))
            .order_by(LeitorBipe.id)
            .limit(limite)
            .with_for_update(skip_locked=True)
        )
        stmt = (
            update(LeitorBipe)
            .where(LeitorBipe.id.in_(alvo.scalar_subquery()))
            .values(consumido_em=agora)
            .returning(LeitorBipe.id, LeitorBipe.codigo, LeitorBipe.criado_em)
            .execution_options(synchronize_session=False)
        )
        linhas = (await self.session.execute(stmt)).all()
        return sorted(((i, c, em) for i, c, em in linhas), key=lambda linha: linha[0])
