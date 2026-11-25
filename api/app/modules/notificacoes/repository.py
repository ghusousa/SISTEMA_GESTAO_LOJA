"""Leitura e escrita de `notificacao_aparelhos`. Só o módulo notificacoes mexe aqui.

Tudo em SQL Core, de propósito: nenhuma tela acompanha esta tabela (ela fica fora de
`ASSUNTO_POR_TABELA`), e o token não deve virar objeto ORM pendurado na sessão, que acaba em
traceback quando algo dá errado.
"""

import uuid
from dataclasses import dataclass, field
from datetime import timedelta

from sqlalchemy import delete, func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.notificacoes.models import AparelhoDeNotificacao

_APARELHOS = AparelhoDeNotificacao.__table__

#: Aparelho que não se registra há mais que isto sai da tabela, com o token. O app registra a
#: cada sessão aberta e na volta ao app depois de 1 h: 30 dias calado é app que não abre mais.
VIDA_DO_APARELHO = timedelta(days=30)
#: Aparelhos por login: ficam os de registro mais recente. Na conta compartilhada da
#: demonstração é o que segura quantos celulares recebem cada chamado.
APARELHOS_POR_LOGIN = 10


@dataclass(frozen=True)
class Aparelho:
    plataforma: str
    token: str | None = field(repr=False)


class NotificacoesRepository:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def upsert(
        self,
        *,
        user_id: int,
        instalacao: uuid.UUID,
        plataforma: str,
        token: str | None,
        com_token: bool,
    ) -> None:
        """Grava esta instalação para o login. `com_token=False` mantém o token guardado."""
        if com_token and token is not None:
            # O mesmo aparelho com outro id de instalação (o app trocou de servidor e voltou)
            # não pode ficar com o token em duas linhas: o push sairia duas vezes, e a de
            # antes pode ser de outro login.
            await self.session.execute(
                delete(_APARELHOS).where(
                    _APARELHOS.c.token == token, _APARELHOS.c.instalacao != instalacao
                )
            )
        valores: dict[str, object] = {
            "user_id": user_id,
            "instalacao": instalacao,
            "plataforma": plataforma,
        }
        if com_token:
            valores["token"] = token
        inserir = pg_insert(_APARELHOS).values(**valores)
        novos: dict[str, object] = {
            # Um aparelho é de um login por vez: quem entrou por último fica com ele.
            "user_id": inserir.excluded.user_id,
            "plataforma": inserir.excluded.plataforma,
            "visto_em": func.now(),
        }
        if com_token:
            novos["token"] = inserir.excluded.token
        await self.session.execute(
            inserir.on_conflict_do_update(index_elements=[_APARELHOS.c.instalacao], set_=novos)
        )

    async def podar_do_usuario(self, user_id: int, manter: int = APARELHOS_POR_LOGIN) -> None:
        """Apaga do login os aparelhos além dos `manter` de registro mais recente."""
        ficam = (
            select(_APARELHOS.c.id)
            .where(_APARELHOS.c.user_id == user_id)
            .order_by(_APARELHOS.c.visto_em.desc(), _APARELHOS.c.id.desc())
            .limit(manter)
        )
        await self.session.execute(
            delete(_APARELHOS).where(
                _APARELHOS.c.user_id == user_id,
                _APARELHOS.c.id.not_in(ficam.scalar_subquery()),
            )
        )

    async def faxina(self, vida: timedelta = VIDA_DO_APARELHO) -> None:
        """Apaga da tabela inteira os aparelhos sem registro há mais que `vida`.

        `SKIP LOCKED`: a faxina nunca espera. Ela roda no login, que não pode parar atrás do
        registro de um aparelho calado que voltou agora (o upsert dele trava a linha, e o
        registro já a tira do prazo); e dois registros assim, cada um apagando a linha que o
        outro trava, não se abraçam. A linha travada sai na próxima faxina.
        """
        calados = (
            select(_APARELHOS.c.id)
            .where(_APARELHOS.c.visto_em < func.now() - vida)
            .with_for_update(skip_locked=True)
        )
        await self.session.execute(
            delete(_APARELHOS).where(_APARELHOS.c.id.in_(calados.scalar_subquery()))
        )

    async def do_usuario(self, user_id: int, limite: int = APARELHOS_POR_LOGIN) -> list[Aparelho]:
        """Os aparelhos do login, do registro mais recente ao mais velho.

        O que passou dos 30 dias fica de fora mesmo antes da faxina (que roda no registro e
        no login): aparelho calado há um mês não recebe chamado.
        """
        linhas = await self.session.execute(
            select(_APARELHOS.c.plataforma, _APARELHOS.c.token)
            .where(
                _APARELHOS.c.user_id == user_id,
                _APARELHOS.c.visto_em >= func.now() - VIDA_DO_APARELHO,
            )
            .order_by(_APARELHOS.c.visto_em.desc(), _APARELHOS.c.id.desc())
            .limit(limite)
        )
        return [Aparelho(plataforma=plataforma, token=token) for plataforma, token in linhas.all()]

    async def apagar_instalacao(self, instalacao: uuid.UUID) -> None:
        await self.session.execute(
            delete(_APARELHOS).where(_APARELHOS.c.instalacao == instalacao)
        )

    async def anular_tokens(self, tokens: list[str]) -> None:
        """A Expo disse que estes tokens morreram (app desinstalado, permissão tirada). A
        instalação fica: com o app aberto ela ainda vê o chamado."""
        if not tokens:
            return
        await self.session.execute(
            update(_APARELHOS).where(_APARELHOS.c.token.in_(tokens)).values(token=None)
        )

    async def apagar_do_usuario(self, user_id: int) -> None:
        await self.session.execute(delete(_APARELHOS).where(_APARELHOS.c.user_id == user_id))
