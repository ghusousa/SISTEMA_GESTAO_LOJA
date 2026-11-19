"""Leitura e escrita de `leitor_pareamentos` e `leitor_bipes`. Só o módulo leitor mexe aqui.

Uma regra que não aparece em nenhuma assinatura: **o que o `retirar` escreve passa por SQL
Core, nunca por objeto ORM.** O aviso de tempo real sai do commit do ORM (`core/eventos.py`),
e o computador refaz a retirada quando ouve "leitor". Se retirar gerasse aviso, cada tela
pareada retiraria de novo por causa da própria retirada — eco sem fim, de 2 em 2 s.
"""

import uuid
from datetime import datetime, timedelta

from sqlalchemy import delete, func, or_, select, text, update
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
#: O id da instalação (ADR-47) sai do pareamento que terminou há mais que isto. A folga
#: garante que nenhuma transação viva ainda o vê ligado (um aceite, um atender ou um bipe que
#: começou antes do fim; cada comando tem 30 s de teto): ninguém lê como ligado, sem a
#: instalação, o que acabou de terminar, e ninguém disputa a linha com quem a tira.
FOLGA_PARA_ESQUECER_A_INSTALACAO = timedelta(minutes=5)


def _terminou():
    """Quando o pareamento terminou: no primeiro destes — encerrado, ou o prazo que valia
    para ele (o do código, se ninguém aceitou; as 12 h, se aceitou). `LEAST` ignora o NULL."""
    return func.least(
        LeitorPareamento.encerrado_em,
        func.coalesce(LeitorPareamento.expira_em, LeitorPareamento.codigo_expira_em),
    )


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
            # Desligar (ou trocar o código) contra aceitar ao mesmo tempo: quem chega depois
            # lê a linha como o outro a deixou, e não por cima de uma versão velha.
            stmt = stmt.with_for_update()
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def nomes(self, *user_ids: int | None) -> dict[int, str]:
        ids = {i for i in user_ids if i is not None}
        if not ids:
            return {}
        linhas = await self.session.execute(select(User.id, User.name).where(User.id.in_(ids)))
        return {uid: nome for uid, nome in linhas.all()}

    async def inserir(self, pareamento: LeitorPareamento) -> bool:
        """Grava o pareamento novo. False se o código sorteado já está AGUARDANDO em outro
        (ou, no chamado, se a chave acabou de ser gravada por outro login).

        Num savepoint: a colisão (32^6 códigos — rara, mas o UNIQUE parcial é quem decide)
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
        velho — de QR e chamados juntos."""
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
        segundo não acha nada. Só um ganha, sem checagem em memória. O código de um CHAMADO
        nunca abre nada (ADR-47): ele só existe porque a coluna pede.
        """
        stmt = (
            select(LeitorPareamento)
            .where(
                LeitorPareamento.codigo == codigo,
                LeitorPareamento.chamado.is_(False),
                LeitorPareamento.aceito_em.is_(None),
                LeitorPareamento.encerrado_em.is_(None),
                LeitorPareamento.codigo_expira_em > agora,
            )
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def aceito_pelo_aparelho(
        self, codigo: str, user_id: int, agora: datetime, *, instalacao: uuid.UUID | None
    ) -> LeitorPareamento | None:
        """O pareamento que ESTE celular já ligou com este código, para o reenvio do aceite.

        Só ainda ATIVO e dentro dos 5 min do código: o reenvio é de uma resposta que se
        perdeu agora há pouco, não um jeito de reabrir leitor antigo. O app novo diz qual
        instalação é (ADR-47): aí só ela recebe o reenvio — o segundo aparelho do mesmo login
        recebe o 404 de sempre.
        """
        stmt = (
            select(LeitorPareamento)
            .where(
                LeitorPareamento.codigo == codigo,
                LeitorPareamento.chamado.is_(False),
                LeitorPareamento.aparelho_user_id == user_id,
                LeitorPareamento.encerrado_em.is_(None),
                LeitorPareamento.expira_em > agora,
                LeitorPareamento.codigo_expira_em > agora,
            )
            .order_by(LeitorPareamento.id.desc())
            .limit(1)
        )
        if instalacao is not None:
            stmt = stmt.where(LeitorPareamento.aparelho_instalacao == instalacao)
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def travar_aparelho(self, user_id: int) -> None:
        """Um aceite (ou chamado, ou atender) por vez do MESMO login, até o commit.

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
        self,
        user_id: int,
        agora: datetime,
        *,
        exceto_id: int,
        instalacao: uuid.UUID | None = None,
    ) -> list[LeitorPareamento]:
        """Os ATIVOS em que este login é o celular, para o TROCOU.

        Com a instalação (app novo, ADR-47), só os da MESMA instalação e os sem instalação
        (ligados por app antigo, que não dá para separar): o outro aparelho do mesmo login
        continua no computador dele. Sem ela (app antigo), todos do login, como antes.
        """
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
        if instalacao is not None:
            stmt = stmt.where(
                or_(
                    LeitorPareamento.aparelho_instalacao == instalacao,
                    LeitorPareamento.aparelho_instalacao.is_(None),
                )
            )
        return list((await self.session.execute(stmt)).scalars())

    async def do_usuario(self, user_id: int) -> list[LeitorPareamento]:
        """Todo pareamento em que a pessoa é o computador ou o celular, de qualquer status
        (os chamados inclusive: neles ela é o computador)."""
        stmt = select(LeitorPareamento).where(
            or_(
                LeitorPareamento.computador_user_id == user_id,
                LeitorPareamento.aparelho_user_id == user_id,
            )
        )
        return list((await self.session.execute(stmt)).scalars())

    async def faxina(self, agora: datetime) -> None:
        """Apaga o que já não serve a ninguém. Barata: roda a cada código ou chamado.

        Pareamento "terminou" no primeiro destes: encerrado, ou o prazo que valia para ele
        (o do código, se ninguém aceitou; as 12 h, se aceitou). `LEAST` ignora o NULL.
        Os bipes dele vão junto (`ON DELETE CASCADE`).
        """
        await self.session.execute(
            delete(LeitorBipe)
            .where(LeitorBipe.criado_em < agora - VIDA_DO_BIPE)
            .execution_options(synchronize_session=False)
        )
        await self.session.execute(
            delete(LeitorPareamento)
            .where(_terminou() < agora - VIDA_DO_PAREAMENTO_TERMINADO)
            .execution_options(synchronize_session=False)
        )

    async def esquecer_instalacoes(self, agora: datetime) -> None:
        """Tira o id da instalação do celular (ADR-47) do pareamento que terminou: ele só
        serve ao leitor ligado. O `_encerrar` já o tira na hora; aqui sai o do leitor que só
        VENCEU (o relógio não grava nada), o que um aceite gravou junto de um encerramento (a
        corrida de `vivos_do_computador`) e o que ficou de antes desta regra.

        Roda no fim do código e do chamado, logo antes do commit, e não espera ninguém
        (`SKIP LOCKED`; a linha travada sai na próxima). Depois dela a transação só faz
        commit: quem esperar pela linha que ela pegou — a exclusão da conta, que apaga os
        pareamentos dela — espera o commit, sem fechar ciclo com a FK do pareamento novo,
        que é onde o código e o chamado esperam pela conta travada.
        """
        com_instalacao = (
            select(LeitorPareamento.id)
            .where(
                LeitorPareamento.aparelho_instalacao.is_not(None),
                _terminou() < agora - FOLGA_PARA_ESQUECER_A_INSTALACAO,
            )
            .with_for_update(skip_locked=True)
        )
        # SQL Core, como o retirar: nada que uma tela mostre muda, e não sai aviso.
        await self.session.execute(
            update(LeitorPareamento)
            .where(LeitorPareamento.id.in_(com_instalacao.scalar_subquery()))
            .values(aparelho_instalacao=None)
            .execution_options(synchronize_session=False)
        )

    # ------------------------------------------------------------------ chamado (ADR-47)

    async def chamado_por_client_uuid(self, client_uuid: uuid.UUID) -> LeitorPareamento | None:
        stmt = (
            select(LeitorPareamento)
            .where(LeitorPareamento.client_uuid == client_uuid)
            .execution_options(populate_existing=True)
        )
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def ultimo_chamado_em(self, user_id: int) -> datetime | None:
        """Quando este login chamou pela última vez (de qualquer aba, com qualquer fim)."""
        return await self.session.scalar(
            select(func.max(LeitorPareamento.criado_em)).where(
                LeitorPareamento.computador_user_id == user_id,
                LeitorPareamento.chamado.is_(True),
            )
        )

    def _abertos(self, user_id: int, agora: datetime) -> tuple:
        return (
            LeitorPareamento.computador_user_id == user_id,
            LeitorPareamento.chamado.is_(True),
            LeitorPareamento.aceito_em.is_(None),
            LeitorPareamento.encerrado_em.is_(None),
            LeitorPareamento.codigo_expira_em > agora,
        )

    async def chamados_abertos(
        self, user_id: int, agora: datetime, *, offset: int, limite: int
    ) -> tuple[list[LeitorPareamento], int]:
        """Os chamados que o celular deste login pode atender agora, do mais novo ao mais
        velho, e quantos são. Sem índice próprio (ADR-31): são no máximo 10 vivos por login,
        e o terminado sai na faxina."""
        filtro = self._abertos(user_id, agora)
        total = await self.session.scalar(
            select(func.count()).select_from(LeitorPareamento).where(*filtro)
        )
        linhas = await self.session.execute(
            select(LeitorPareamento)
            .where(*filtro)
            .order_by(LeitorPareamento.id.desc())
            .offset(offset)
            .limit(limite)
            .execution_options(populate_existing=True)
        )
        return list(linhas.scalars()), int(total or 0)

    async def chamado_para_atender(
        self, pareamento_id: int, user_id: int, agora: datetime
    ) -> LeitorPareamento | None:
        """O chamado que este login ainda pode atender — travado até o commit.

        Dois aparelhos do mesmo login no mesmo chamado: o segundo lê a linha como o primeiro
        a deixou (aceita) e não acha nada, como no aceite por código.
        """
        stmt = (
            select(LeitorPareamento)
            .where(LeitorPareamento.id == pareamento_id, *self._abertos(user_id, agora))
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def atendido_pela_instalacao(
        self, pareamento_id: int, user_id: int, instalacao: uuid.UUID, agora: datetime
    ) -> LeitorPareamento | None:
        """O chamado que ESTA instalação já atendeu, para o reenvio do atender: ainda ATIVO e
        dentro dos 5 min do chamado, como o reenvio do aceite."""
        stmt = (
            select(LeitorPareamento)
            .where(
                LeitorPareamento.id == pareamento_id,
                LeitorPareamento.chamado.is_(True),
                LeitorPareamento.aparelho_user_id == user_id,
                LeitorPareamento.aparelho_instalacao == instalacao,
                LeitorPareamento.encerrado_em.is_(None),
                LeitorPareamento.expira_em > agora,
                LeitorPareamento.codigo_expira_em > agora,
            )
            .execution_options(populate_existing=True)
        )
        return (await self.session.execute(stmt)).scalar_one_or_none()

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
