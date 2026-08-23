import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.auth.models import LoginAttempt, RefreshToken

# Regras da trava de força bruta. Números escolhidos para não atrapalhar quem erra a senha
# no balcão (10 tentativas dão folga para o dedo gordo) mas sufocar quem automatiza.
JANELA = timedelta(minutes=15)
MAX_FALHAS_EMAIL = 10  #: erros no MESMO e-mail antes de travar
MAX_FALHAS_IP = 30  #: erros do MESMO IP (vários e-mails) antes de travar — anti-spray


class AuthRepository:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def por_jti(self, jti: uuid.UUID) -> RefreshToken | None:
        return await self.session.get(RefreshToken, jti)

    def registrar(
        self, jti: uuid.UUID, user_id: int, family_id: uuid.UUID, expires_at: datetime
    ) -> RefreshToken:
        token = RefreshToken(
            jti=jti, user_id=user_id, family_id=family_id, expires_at=expires_at
        )
        self.session.add(token)
        return token

    async def revogar(self, jti: uuid.UUID) -> None:
        await self.session.execute(
            update(RefreshToken).where(RefreshToken.jti == jti).values(revoked=True)
        )

    async def revogar_familia(self, family_id: uuid.UUID) -> None:
        """Reuso de token rotacionado = provável roubo: derruba a cadeia inteira."""
        await self.session.execute(
            update(RefreshToken)
            .where(RefreshToken.family_id == family_id, RefreshToken.revoked.is_(False))
            .values(revoked=True)
        )

    async def limpar_expirados(self, agora: datetime) -> int:
        from sqlalchemy import delete

        resultado = await self.session.execute(
            delete(RefreshToken).where(RefreshToken.expires_at < agora)
        )
        return resultado.rowcount or 0

    # ------------------------------------------------ trava de força bruta
    async def segundos_de_bloqueio(self, email: str, ip: str | None) -> int:
        """Quantos segundos faltam até o login liberar. Zero = pode tentar.

        Conta as FALHAS na janela, por e-mail e por IP. Se qualquer um dos dois passou do
        teto, devolve o tempo até a falha mais antiga da janela sair — é quando o contador
        cai abaixo do teto de novo.
        """
        agora = datetime.now(UTC)
        inicio = agora - JANELA

        async def falhas(coluna, valor, teto: int) -> int:
            if valor is None:
                return 0
            linhas = (
                await self.session.execute(
                    select(LoginAttempt.created_at)
                    .where(
                        coluna == valor,
                        LoginAttempt.sucesso.is_(False),
                        LoginAttempt.created_at >= inicio,
                    )
                    .order_by(LoginAttempt.created_at)
                )
            ).scalars().all()
            if len(linhas) < teto:
                return 0
            # A (len-teto+1)-ésima falha mais antiga é a que precisa sair da janela para o
            # contador voltar a ficar abaixo do teto.
            libera_em = linhas[len(linhas) - teto] + JANELA
            return max(0, int((libera_em - agora).total_seconds()) + 1)

        return max(
            await falhas(LoginAttempt.email, email.lower().strip(), MAX_FALHAS_EMAIL),
            await falhas(LoginAttempt.ip, ip, MAX_FALHAS_IP),
        )

    def registrar_tentativa(self, email: str, ip: str | None, sucesso: bool) -> None:
        self.session.add(
            LoginAttempt(email=email.lower().strip(), ip=ip, sucesso=sucesso)
        )

    async def limpar_tentativas_antigas(self, agora: datetime) -> int:
        """A tabela é só para a janela recente; o resto é lixo. O backup/rotina limpa."""
        from sqlalchemy import delete

        resultado = await self.session.execute(
            delete(LoginAttempt).where(LoginAttempt.created_at < agora - JANELA)
        )
        return resultado.rowcount or 0
