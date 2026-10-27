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
    SemPermissao,
    Validacao,
)
from app.core.pagination import Pagina, Paginacao
from app.core.security import HASH_DE_MENTIRA, hash_senha_async, verificar_senha_async
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
        if user is None:
            # E-mail que não existe paga o mesmo bcrypt de uma senha errada. A mensagem já
            # era a mesma; sem isto o TEMPO entregava quem existe (10 ms contra 300 ms) e
            # cronometrar o login listava a equipe (ADR-24). Conta desativada não precisa:
            # a senha é conferida contra o hash dela antes de olhar `is_active`.
            await verificar_senha_async(senha, HASH_DE_MENTIRA)
            raise CredenciaisInvalidas()
        if not await verificar_senha_async(senha, user.password_hash):
            raise CredenciaisInvalidas()
        if not user.is_active:
            raise CredenciaisInvalidas("Usuário desativado. Fale com o administrador.")
        return user

    async def listar(
        self, p: Paginacao, q: str | None, papel: str | None, ativo: bool | None
    ) -> Pagina[UsuarioOut]:
        items, total = await self.repo.listar(p, q=q, papel=papel, ativo=ativo)
        return Pagina.montar([UsuarioOut.model_validate(u) for u in items], total, p)

    @staticmethod
    def _barrar_escalada(ator: User, papel_alvo: Papel | None, alvo: User | None = None) -> None:
        """Só o dono mexe em dono. Sem isto, GERIR_USUARIOS viraria "virar dono".

        Um gerente tem a permissão de administrar a equipe, e a permissão sozinha não
        distingue "criar uma vendedora" de "promover a si mesmo a dono". Bastava um PATCH
        no próprio id com papel=ADMIN para o gerente passar a enxergar custo, lucro e
        despesas — exatamente o que a loja decidiu que ele não veria. A trava é aqui, no
        domínio, e não na tela.
        """
        if ator.role == Papel.ADMIN:
            return
        if papel_alvo == Papel.ADMIN:
            raise SemPermissao("Só o dono pode criar ou promover outro dono.")
        if alvo is not None and alvo.role == Papel.ADMIN:
            raise SemPermissao("A conta do dono só é alterada pelo próprio dono.")

    async def criar(self, dados: UsuarioCreate, ator: User) -> User:
        self._barrar_escalada(ator, dados.papel)
        if await self.repo.por_email(dados.email) is not None:
            raise Duplicado("Já existe um usuário com esse e-mail.")
        user = User(
            name=dados.nome,
            email=dados.email.strip().lower(),
            password_hash=await hash_senha_async(dados.senha),
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

    async def atualizar(self, user_id: int, dados: UsuarioUpdate, ator: User) -> User:
        user = await self.obter(user_id)
        self._barrar_escalada(ator, dados.papel, alvo=user)
        if dados.nome is not None:
            user.name = dados.nome.strip()
        # A loja não pode ficar sem dono ativo — nem por rebaixamento, nem por desativação.
        vai_perder_dono = (dados.papel is not None and dados.papel != Papel.ADMIN) or (
            dados.ativo is False
        )
        if user.role == Papel.ADMIN and user.is_active and vai_perder_dono:
            if await self.repo.contar_admins_ativos(excluindo_id=user.id) == 0:
                raise OperacaoInvalida("A loja precisa de pelo menos um dono ativo.")
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

    async def excluir(self, user_id: int, ator: User) -> None:
        """Apaga a conta de verdade — não é desativar.

        As lojas de app exigem um caminho de exclusão para quem tem conta, e "desativar" não
        é excluir: o nome e o e-mail continuariam guardados. Aqui a linha some da tabela.

        **O histórico da loja NÃO some junto, e isso é de propósito.** A venda que a pessoa
        registrou é documento contábil da loja, não dado dela para levar embora; a linha de
        auditoria é a prestação de contas que o dono precisa guardar. O modelo já foi feito
        para isso: `audit_log.user_id` é `ON DELETE SET NULL` e o nome/papel de quem agiu
        ficam CONGELADOS na linha (ADR-23), então apagar a conta remove o vínculo sem
        reescrever o passado nem furar a contabilidade.

        Duas travas: ninguém apaga a própria conta (seria perder o acesso no meio do
        expediente, sem quem desfizesse), e a loja nunca fica sem um dono ativo.
        """
        user = await self.obter(user_id)
        # Mexer em dono é só do dono — a mesma regra de editar e redefinir senha.
        self._barrar_escalada(ator, None, alvo=user)

        if user.id == ator.id:
            raise OperacaoInvalida(
                "Você não pode excluir a sua própria conta. Peça a outro administrador."
            )
        if user.role == Papel.ADMIN and user.is_active:
            if await self.repo.contar_admins_ativos(excluindo_id=user.id) == 0:
                raise OperacaoInvalida("A loja precisa de pelo menos um dono ativo.")

        # Sessão aberta com refresh token válido sobreviveria à exclusão da linha se os
        # tokens não caíssem antes: o FK deles é para o usuário que está indo embora.
        await self._derrubar_sessoes(user.id)
        await self.session.delete(user)
        await self.session.commit()

    async def redefinir_senha(self, user_id: int, nova_senha: str, ator: User) -> None:
        user = await self.obter(user_id)
        # Redefinir a senha do dono daria a chave da casa: é entrar como ele.
        self._barrar_escalada(ator, None, alvo=user)
        user.password_hash = await hash_senha_async(nova_senha)
        await self._derrubar_sessoes(user_id)
        await self.session.commit()

    async def trocar_propria_senha(self, user: User, senha_atual: str, nova_senha: str) -> None:
        if not await verificar_senha_async(senha_atual, user.password_hash):
            raise Validacao("Senha atual incorreta.")
        if senha_atual == nova_senha:
            raise Validacao("A nova senha deve ser diferente da atual.")
        user.password_hash = await hash_senha_async(nova_senha)
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
