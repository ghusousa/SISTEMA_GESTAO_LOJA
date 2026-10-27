import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.auth.models import LoginAttempt, RefreshToken

# Regras da trava de força bruta. Números escolhidos para não atrapalhar quem erra a senha
# no balcão (10 tentativas dão folga para o dedo gordo) mas sufocar quem automatiza.
JANELA = timedelta(minutes=15)
MAX_FALHAS_EMAIL = 10  #: erros no MESMO e-mail antes de travar
MAX_FALHAS_IP = 30  #: erros do MESMO IP (vários e-mails) antes de travar — anti-spray

#: Faxina (feita a cada login certo, ver `AuthService.login`). A trava só olha os últimos
#: 15 min; guardar um dia inteiro dá folga de sobra e deixa a manhã para quem for investigar
#: uma varredura. Sem faxina, cada chute vindo da internet virava linha para sempre — e ia
#: junto em cada dump enviado ao Drive.
RETENCAO_TENTATIVAS = timedelta(days=1)
#: Refresh vencido há mais que isto é apagado. A folga cobre relógio adiantado; antes dela a
#: linha fica, mesmo revogada (ver `limpar_expirados`).
FOLGA_REFRESH_VENCIDO = timedelta(days=1)
#: Espaço da trava consultiva de login: separa estas chaves de qualquer outra trava
#: `pg_advisory_*` que um dia apareça (o número lembra o ADR-24).
_ESPACO_TRAVA_LOGIN = 24


class AuthRepository:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def por_jti_travado(self, jti: uuid.UUID) -> RefreshToken | None:
        """Lê o refresh token TRAVANDO a linha até o commit (`SELECT ... FOR UPDATE`).

        Cinco renovações simultâneas com o mesmo token liam todas `revoked=False` e todas
        rotacionavam: cinco tokens vivos na família, e uma cópia roubada que ganhasse a
        corrida do dono escapava da detecção de reuso (ADR-12). Com a linha travada, a
        segunda espera a primeira confirmar e enxerga o token já revogado — cai no reuso.
        """
        return (
            await self.session.execute(
                select(RefreshToken)
                .where(RefreshToken.jti == jti)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        ).scalar_one_or_none()

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
        """Apaga o refresh token VENCIDO (há mais de `FOLGA_REFRESH_VENCIDO`).

        Só o vencido, nunca o revogado dentro da validade: é a linha dele que denuncia o
        reuso — uma cópia roubada reaparecendo precisa achá-la para derrubar a família
        (ADR-12). Vencido, o próprio JWT já é recusado ao decodificar (`exp`), antes de
        qualquer consulta, e a linha não guarda mais nada.
        """
        resultado = await self.session.execute(
            delete(RefreshToken).where(RefreshToken.expires_at < agora - FOLGA_REFRESH_VENCIDO)
        )
        return resultado.rowcount or 0

    # ------------------------------------------------ trava de força bruta
    async def travar_email(self, email: str) -> None:
        """Põe o login deste e-mail na fila: um por vez conta, confere a senha e grava.

        Sem a fila, 30 tentativas simultâneas passavam TODAS pela contagem antes de a
        primeira falha ser gravada — 30 senhas conferidas contra um teto de 10 (ADR-24).
        Com ela, a próxima só conta depois que a anterior gravou a falha dela. A trava é
        `pg_advisory_xact_lock`: some sozinha no commit ou no rollback, então não existe
        trava esquecida, nem com o processo caindo no meio.
        """
        await self.session.execute(
            text("SELECT pg_advisory_xact_lock(:espaco, hashtext(:email))"),
            {"espaco": _ESPACO_TRAVA_LOGIN, "email": email.lower().strip()},
        )

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
        """A tabela é só para a janela recente; o que passou de `RETENCAO_TENTATIVAS` é lixo."""
        resultado = await self.session.execute(
            delete(LoginAttempt).where(LoginAttempt.created_at < agora - RETENCAO_TENTATIVAS)
        )
        return resultado.rowcount or 0
