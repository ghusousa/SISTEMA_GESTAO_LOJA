from sqlalchemy import update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

# Importa o MODELO de refresh token, não o service de auth: auth.service já depende de
# usuarios.service, e usar o service aqui fecharia um ciclo de import.
from app.modules.auth.models import RefreshToken

from app.core.exceptions import (
    CredenciaisInvalidas,
    Duplicado,
    NaoEncontrado,
    OperacaoInvalida,
    Validacao,
)
from app.core.pagination import Pagina, Paginacao
from app.core.security import hash_senha, verificar_senha
from app.modules.usuarios.models import Papel, User
from app.modules.usuarios.repository import UsuarioRepository
from app.modules.usuarios.schemas import UsuarioCreate, UsuarioOut, UsuarioUpdate


class UsuarioService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.repo = UsuarioRepository(session)

    async def obter(self, user_id: int) -> User:
        user = await self.repo.por_id(user_id)
        if user is None:
            raise NaoEncontrado("Usuário não encontrado.")
        return user

    async def autenticar(self, email: str, senha: str) -> User:
        user = await self.repo.por_email(email)
        # Verifica a senha mesmo com usuário inexistente seria ideal contra timing attack,
        # mas o custo do bcrypt aqui é aceitável: a mensagem de erro é sempre a mesma.
        if user is None or not verificar_senha(senha, user.password_hash):
            raise CredenciaisInvalidas()
        if not user.is_active:
            raise CredenciaisInvalidas("Usuário desativado. Fale com o administrador.")
        return user

    async def listar(
        self, p: Paginacao, q: str | None, papel: str | None, ativo: bool | None
    ) -> Pagina[UsuarioOut]:
        items, total = await self.repo.listar(p, q=q, papel=papel, ativo=ativo)
        return Pagina.montar([UsuarioOut.model_validate(u) for u in items], total, p)

    async def criar(self, dados: UsuarioCreate) -> User:
        if await self.repo.por_email(dados.email) is not None:
            raise Duplicado("Já existe um usuário com esse e-mail.")
        user = User(
            name=dados.nome,
            email=dados.email.strip().lower(),
            password_hash=hash_senha(dados.senha),
            role=dados.papel,
            is_active=True,
        )
        self.repo.adicionar(user)
        try:
            await self.session.commit()
        except IntegrityError as exc:  # corrida entre dois cadastros do mesmo e-mail
            await self.session.rollback()
            raise Duplicado("Já existe um usuário com esse e-mail.") from exc
        await self.session.refresh(user)
        return user

    async def atualizar(self, user_id: int, dados: UsuarioUpdate) -> User:
        user = await self.obter(user_id)
        if dados.nome is not None:
            user.name = dados.nome.strip()
        # A loja não pode ficar sem administrador ativo — nem por rebaixamento, nem por desativação.
        vai_perder_admin = (dados.papel is not None and dados.papel != Papel.ADMIN) or (
            dados.ativo is False
        )
        if user.role == Papel.ADMIN and user.is_active and vai_perder_admin:
            if await self.repo.contar_admins_ativos(excluindo_id=user.id) == 0:
                raise OperacaoInvalida("A loja precisa de pelo menos um administrador ativo.")
        if dados.papel is not None:
            user.role = dados.papel
        if dados.ativo is not None:
            user.is_active = dados.ativo
            if dados.ativo is False:
                # Desativar corta o acesso agora, sem esperar o access token expirar.
                await self._derrubar_sessoes(user.id)
        await self.session.commit()
        await self.session.refresh(user)
        return user

    async def redefinir_senha(self, user_id: int, nova_senha: str) -> None:
        user = await self.obter(user_id)
        user.password_hash = hash_senha(nova_senha)
        await self._derrubar_sessoes(user_id)
        await self.session.commit()

    async def trocar_propria_senha(self, user: User, senha_atual: str, nova_senha: str) -> None:
        if not verificar_senha(senha_atual, user.password_hash):
            raise Validacao("Senha atual incorreta.")
        if senha_atual == nova_senha:
            raise Validacao("A nova senha deve ser diferente da atual.")
        user.password_hash = hash_senha(nova_senha)
        await self._derrubar_sessoes(user.id)
        await self.session.commit()

    async def _derrubar_sessoes(self, user_id: int) -> None:
        """Trocar a senha encerra as sessões abertas.

        Quem trocou a senha quer justamente cortar o acesso de quem estava dentro — um
        refresh token vazado (celular roubado, funcionário desligado) continuaria válido por
        semanas se as sessões não caíssem junto.
        """
        await self.session.execute(
            update(RefreshToken)
            .where(RefreshToken.user_id == user_id, RefreshToken.revoked.is_(False))
            .values(revoked=True)
        )
