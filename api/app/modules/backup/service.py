"""Regras do backup. São poucas, e a mais importante é o que NÃO acontece aqui:
esta camada não faz backup nenhum. Ela guarda a configuração que o `backup.sh` vai ler.
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import OperacaoInvalida, Validacao
from app.core.security import verificar_senha_async
from app.modules.backup.models import BackupConfig
from app.modules.backup.schemas import BackupUpdate
from app.modules.usuarios.models import User


class BackupService:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def _obter_ou_criar(self) -> BackupConfig:
        c = await self.session.scalar(select(BackupConfig).where(BackupConfig.id == 1))
        if c is None:
            c = BackupConfig(id=1)
            self.session.add(c)
            await self.session.flush()
        return c

    async def obter(self) -> BackupConfig:
        c = await self._obter_ou_criar()
        await self.session.commit()
        return c

    async def atualizar(self, dados: BackupUpdate, usuario: User) -> BackupConfig:
        c = await self._obter_ou_criar()
        campos = dados.model_dump(exclude_unset=True)
        senha = campos.pop("senha_atual", None)

        # Token só é sobrescrito quando vem um NOVO. Mandar `null` (ou nada) não apaga o
        # que já está lá: a tela salva "ligar/desligar" sem reenviar credencial, e um
        # PATCH descuidado não deixa a loja sem backup sem ninguém perceber.
        if campos.get("rclone_token") is None:
            campos.pop("rclone_token", None)

        # TROCAR o destino que já existe pede a senha de novo (ADR-28): é o caminho de quem
        # pega uma sessão esquecida e desvia as cópias para o próprio Drive. Ligar,
        # desligar, intervalo e quantas cópias não levam o banco a lugar nenhum novo. A
        # primeira conexão (sem token gravado) ainda segue sem senha — ver o ADR.
        ja_tem_destino = bool(c.rclone_token)
        muda_destino = ja_tem_destino and (
            "rclone_token" in campos
            or (campos.get("pasta") is not None and campos["pasta"] != c.pasta)
        )
        if muda_destino:
            await self._conferir_senha(senha, usuario)

        for campo, valor in campos.items():
            setattr(c, campo, valor)

        # Ligar sem token seria mentira na tela: diria "ativo" e nada aconteceria.
        if c.ativo and not c.rclone_token:
            raise OperacaoInvalida(
                "Antes de ligar o backup, conecte a conta do Google Drive."
            )

        await self.session.commit()
        await self.session.refresh(c)
        return c

    @staticmethod
    async def _conferir_senha(senha: str | None, usuario: User) -> None:
        """422 e não 401: um 401 aqui faria a tela achar que a SESSÃO caiu e deslogar o
        dono por ter digitado a senha errada."""
        if not senha:
            raise Validacao(
                "Para trocar a conta do Google ou a pasta, confirme a sua senha.",
                {"campo": "senha_atual", "motivo": "faltou"},
            )
        # bcrypt numa thread: no loop, ele congelaria a loja inteira enquanto confere.
        if not await verificar_senha_async(senha, usuario.password_hash):
            raise Validacao(
                "Senha incorreta. O destino do backup não foi trocado.",
                {"campo": "senha_atual", "motivo": "errada"},
            )
