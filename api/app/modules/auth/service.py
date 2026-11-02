import uuid
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.exceptions import CredenciaisInvalidas, MuitasTentativas, TokenInvalido
from app.core.security import (
    criar_access_token,
    criar_refresh_token,
    decodificar_token,
    validade_refresh,
)
from app.modules.auditoria.service import AuditoriaService, mascarar_email
from app.modules.auth.repository import AuthRepository
from app.modules.auth.schemas import TokenOut
from app.modules.usuarios.models import User
from app.modules.usuarios.schemas import UsuarioOut
from app.modules.usuarios.service import UsuarioService


class AuthService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.repo = AuthRepository(session)
        self.usuarios = UsuarioService(session)  # módulo usa o service público de outro módulo

    async def _emitir(self, user: User, family_id: uuid.UUID) -> TokenOut:
        jti = uuid.uuid4()
        self.repo.registrar(jti, user.id, family_id, validade_refresh())
        return TokenOut(
            access_token=criar_access_token(user.id, user.role),
            refresh_token=criar_refresh_token(user.id, jti, family_id),
            expires_in=settings.access_token_expire_minutes * 60,
            usuario=UsuarioOut.model_validate(user),
        )

    async def login(self, email: str, senha: str, ip: str | None = None) -> TokenOut:
        # Uma tentativa por vez para o mesmo e-mail, até o commit: contar, conferir e gravar
        # viram um passo só. Sem a fila, uma rajada simultânea passava inteira pela contagem
        # antes de a primeira falha ser gravada, e o teto de 10 virava 30 (ADR-24).
        await self.repo.travar_email(email)
        # Antes de conferir a senha, checa a trava: erros demais recentes → 429 sem nem
        # olhar a senha, que é o que torna a força bruta inviável.
        bloqueio = await self.repo.segundos_de_bloqueio(email, ip)
        if bloqueio > 0:
            raise MuitasTentativas(bloqueio)

        try:
            user = await self.usuarios.autenticar(email, senha)
        except CredenciaisInvalidas:
            # Registra a falha (alimenta a trava e o diário) e devolve o mesmo erro de
            # sempre — a resposta não muda, para não revelar se o e-mail existe. No diário,
            # uma senha errada seguida da mesma pessoa é justamente o que o dono quer ver.
            self.repo.registrar_tentativa(email, ip, sucesso=False)
            await self._anotar_falha(email, ip)
            await self.session.commit()
            raise

        self.repo.registrar_tentativa(email, ip, sucesso=True)
        AuditoriaService(self.session).registrar(
            user_id=user.id,
            user_nome=user.name,
            user_papel=user.role,
            acao="LOGIN",
            descricao="Entrou no sistema",
            metodo="POST",
            caminho="/auth/login",
            ip=ip,
            status_http=200,
        )
        # Faxina oportunista: login certo é raro (alguns por dia) e já está escrevendo, então
        # sai barato aproveitar. Sem ela, tentativas e refresh tokens viravam linha para sempre.
        agora = datetime.now(UTC)
        await self.repo.limpar_tentativas_antigas(agora)
        await self.repo.limpar_expirados(agora)
        await AuditoriaService(self.session).aplicar_retencao(agora)
        tokens = await self._emitir(user, family_id=uuid.uuid4())
        await self.session.commit()
        return tokens

    async def _anotar_falha(self, email: str, ip: str | None) -> None:
        """A linha do diário de um login que falhou, sem guardar e-mail à toa (ADR-23).

        Conta que existe: vai o id e o nome dela, congelados como em qualquer ato, e o
        e-mail fica de fora (ele já está na conta; se ela for excluída, some com ela). Conta
        que não existe: o e-mail digitado vai MASCARADO — pode ser o de uma pessoa qualquer,
        errado por uma letra, e não há conta a que ele pertença para um dia ser apagado.
        A consulta é a mesma nos dois casos, então o tempo da resposta não muda.
        """
        conta = await self.usuarios.por_email(email)
        if conta is None:
            mascara = mascarar_email(email)
            quem: dict = {"user_id": None, "user_nome": mascara, "user_papel": None}
            frase = f"Tentou entrar com um e-mail sem conta ({mascara})"
        else:
            quem = {"user_id": conta.id, "user_nome": conta.name, "user_papel": conta.role}
            frase = (
                "Tentou entrar e errou a senha"
                if conta.is_active
                else "Tentou entrar com o acesso desativado"
            )
        AuditoriaService(self.session).registrar(
            **quem,
            acao="LOGIN_FALHOU",
            descricao=frase,
            metodo="POST",
            caminho="/auth/login",
            ip=ip,
            status_http=401,
        )

    async def refresh(self, refresh_token: str) -> TokenOut:
        payload = decodificar_token(refresh_token, "refresh")
        jti = uuid.UUID(payload["jti"])
        family_id = uuid.UUID(payload["fam"])

        # Trava a linha até o commit: duas renovações com o mesmo token entram em fila, e a
        # segunda vê o token já revogado pela primeira — é reuso, e a família cai (ADR-12).
        armazenado = await self.repo.por_jti_travado(jti)
        if armazenado is None:
            raise TokenInvalido()

        if armazenado.revoked:
            # Token já rotacionado reaparecendo: alguém está usando uma cópia. Derruba tudo.
            await self.repo.revogar_familia(family_id)
            await self.session.commit()
            raise TokenInvalido("Sessão encerrada por segurança. Faça login novamente.")

        if armazenado.expires_at <= datetime.now(UTC):
            raise TokenInvalido()

        user = await self.usuarios.obter(armazenado.user_id)
        if not user.is_active:
            raise TokenInvalido("Usuário desativado.")

        await self.repo.revogar(jti)  # rotação: o token usado morre aqui
        tokens = await self._emitir(user, family_id=family_id)
        await self.session.commit()
        return tokens

    async def logout(self, refresh_token: str) -> None:
        """Logout tolerante: token já inválido não é erro, o objetivo é a sessão terminar."""
        try:
            payload = decodificar_token(refresh_token, "refresh")
        except TokenInvalido:
            return
        await self.repo.revogar_familia(uuid.UUID(payload["fam"]))
        await self.session.commit()
