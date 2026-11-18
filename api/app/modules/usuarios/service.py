from decimal import Decimal

from sqlalchemy import func, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

# Importa o MODELO de refresh token, não o service de auth: auth.service já depende de
# usuarios.service, e usar o service aqui fecharia um ciclo de import.
from app.modules.auth.models import RefreshToken

from app.core.config import settings
from app.core.exceptions import (
    ContaDeDemonstracao,
    CredenciaisInvalidas,
    Duplicado,
    NaoEncontrado,
    OperacaoInvalida,
    SemPermissao,
    SenhaIncorreta,
    Validacao,
)
from app.core.pagination import Pagina, Paginacao
from app.core.permissoes import Pode, pode
from app.core.security import HASH_DE_MENTIRA, hash_senha_async, verificar_senha_async
from app.modules.auditoria.service import AuditoriaService
from app.modules.leitor.service import LeitorService
from app.modules.usuarios.models import Papel, User
from app.modules.usuarios.repository import UsuarioRepository
from app.modules.usuarios.schemas import (
    DOMINIO_DA_CONTA_EXCLUIDA,
    UsuarioCreate,
    UsuarioOut,
    UsuarioUpdate,
)

#: A recusa do "Excluir minha conta" ao único dono ativo. A loja não fica sem dono, e o
#: caminho é o mesmo do Slack e do Google Workspace: passar o papel antes de sair (ADR-45).
DONO_UNICO = (
    "Você é o único dono da loja. Passe o papel de dono a outra pessoa em Usuários antes "
    "de excluir a sua conta."
)

#: O que vai no lugar da senha de uma conta excluída cuja linha ficou: não é hash bcrypt,
#: então nenhuma senha confere (`verificar_senha` devolve False, não estoura).
SEM_SENHA = "!"


def email_da_conta_excluida(user_id: int) -> str:
    """O e-mail de verdade sai da linha que ficou e volta a ficar livre para uma conta nova.

    `.example` é reservado (RFC 2606): nunca será o endereço de alguém. E continua sendo um
    e-mail válido para o `EmailStr` — uma versão anterior lendo a linha não quebra. O
    cadastro recusa o domínio (`UsuarioCreate`): ocupado antes, o endereço da marca fazia a
    exclusão desta conta estourar a UNIQUE, e a pessoa nunca conseguia sair.
    """
    return f"conta-excluida-{user_id}@{DOMINIO_DA_CONTA_EXCLUIDA}"


class UsuarioService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.repo = UsuarioRepository(session)

    async def obter(self, user_id: int) -> User:
        user = await self.repo.por_id(user_id)
        # A conta excluída que ficou para segurar o histórico não se edita, não se reativa
        # e não ganha senha nova: para quem administra a equipe, ela não existe (ADR-45).
        if user is None or user.deleted_at is not None:
            raise NaoEncontrado("Usuário não encontrado.")
        return user

    async def por_email(self, email: str) -> User | None:
        """A conta deste e-mail, ou `None`. Público: o login precisa saber de quem foi a
        tentativa errada para anotar no diário o id em vez do e-mail digitado."""
        return await self.repo.por_email(email)

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
    def _proteger_conta_da_demonstracao(user: User) -> None:
        """Na Vercel, a conta do dono da demonstração fica como está (ADR-45).

        É a conta que as notas da revisão da App Store dão ao revisor. Excluída, rebaixada,
        desativada ou com a senha trocada, o próximo revisor (ou a próxima rodada) não entra
        e a resposta volta como "conta demo inválida" (2.1). Vale antes da senha: quem está
        com ela na mão não precisa de senha nenhuma para saber que é a conta da demo, e é
        assim que o publicador confere, sem risco, que a proteção está de pé.
        """
        demo = settings.demo_admin_email.strip().lower()
        if settings.vercel and demo and user.email.strip().lower() == demo:
            raise ContaDeDemonstracao()

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

    #: Os campos que mexem na folha: só quem tem DEFINIR_COMISSAO os manda (ADR-37).
    CAMPOS_DE_COMISSAO = ("comissao_percentual", "meta_diaria")

    @classmethod
    def _barrar_comissao(cls, ator: User, dados: UsuarioCreate | UsuarioUpdate) -> None:
        """Comissão e meta são do dono. O gerente administra a equipe, mas recebe comissão
        também: com GERIR_USUARIOS sozinho, um PATCH no próprio id aumentava o próprio
        salário. Mandar o campo já é a tentativa — mesmo com o valor de hoje — e a recusa é
        explícita (403), não um "ignorei" silencioso que faria a tela mentir que salvou.
        """
        if pode(ator.role, Pode.DEFINIR_COMISSAO):
            return
        if any(campo in dados.model_fields_set for campo in cls.CAMPOS_DE_COMISSAO):
            raise SemPermissao("Só o dono define comissão e meta.")

    async def criar(self, dados: UsuarioCreate, ator: User) -> User:
        self._barrar_escalada(ator, dados.papel)
        self._barrar_comissao(ator, dados)
        if await self.repo.por_email(dados.email) is not None:
            raise Duplicado("Já existe um usuário com esse e-mail.")
        user = User(
            name=dados.nome,
            email=dados.email.strip().lower(),
            password_hash=await hash_senha_async(dados.senha),
            role=dados.papel,
            is_active=True,
            comissao_percentual=dados.comissao_percentual or Decimal("0"),
            meta_diaria=dados.meta_diaria,
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
        self._barrar_comissao(ator, dados)
        if (dados.papel is not None and dados.papel != user.role) or dados.ativo is False:
            self._proteger_conta_da_demonstracao(user)
        if dados.nome is not None:
            user.name = dados.nome.strip()
        if "comissao_percentual" in dados.model_fields_set:
            # `null` não é "sem comissão" por acidente: zero é dito com zero.
            if dados.comissao_percentual is None:
                raise Validacao("Informe a comissão em %; para não pagar comissão, use 0.")
            user.comissao_percentual = dados.comissao_percentual
        if "meta_diaria" in dados.model_fields_set:
            user.meta_diaria = dados.meta_diaria
        # A loja não pode ficar sem dono ativo — nem por rebaixamento, nem por desativação.
        vai_perder_dono = (dados.papel is not None and dados.papel != Papel.ADMIN) or (
            dados.ativo is False
        )
        if user.role == Papel.ADMIN and user.is_active and vai_perder_dono:
            if await self.repo.outros_donos_ativos(user.id) == 0:
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
        """Quem administra a equipe exclui a conta de outra pessoa — não é desativar.

        As lojas de app exigem um caminho de exclusão para quem tem conta, e "desativar" não
        é excluir: o nome e o e-mail continuariam guardados. A limpeza é a de
        `_apagar_conta`, a mesma do "Excluir minha conta".

        Duas travas: a própria conta não se exclui por aqui (o caminho é o
        `excluir_propria_conta`, que pede a senha), e a loja nunca fica sem um dono ativo.
        """
        user = await self.obter(user_id)
        # Mexer em dono é só do dono — a mesma regra de editar e redefinir senha.
        self._barrar_escalada(ator, None, alvo=user)
        self._proteger_conta_da_demonstracao(user)

        if user.id == ator.id:
            raise OperacaoInvalida(
                "A sua própria conta não se exclui por aqui: use Minha conta > Excluir "
                "minha conta, que pede a sua senha."
            )
        if user.role == Papel.ADMIN and user.is_active:
            if await self.repo.outros_donos_ativos(user.id) == 0:
                raise OperacaoInvalida("A loja precisa de pelo menos um dono ativo.")
        await self._apagar_conta(user)

    async def excluir_propria_conta(self, user: User, senha: str) -> None:
        """A própria pessoa exclui a conta, de dentro do app (Apple 5.1.1(v), ADR-45).

        A senha confirma que é ela, e não um celular destravado na mão de outra pessoa; a
        errada é `SenhaIncorreta` (422), nunca 401 — o 401 derrubaria a sessão que a senha
        só devia confirmar. O único dono ativo não sai: a loja ficaria sem quem administra
        a equipe, o backup e o diário; ele passa o papel a outra pessoa antes. Na Vercel, a
        conta do dono da demonstração não sai nunca (`_proteger_conta_da_demonstracao`).
        """
        self._proteger_conta_da_demonstracao(user)
        if not await verificar_senha_async(senha, user.password_hash):
            raise SenhaIncorreta()
        if user.role == Papel.ADMIN and await self.repo.outros_donos_ativos(user.id) == 0:
            raise OperacaoInvalida(DONO_UNICO)
        await self._apagar_conta(user)

    async def _apagar_conta(self, user: User) -> None:
        """A limpeza de toda exclusão de conta, pelo dono ou pela própria pessoa.

        **O histórico da loja NÃO some junto, e isso é de propósito.** A venda que a pessoa
        registrou é documento contábil da loja, não dado dela para levar embora; a linha de
        auditoria é a prestação de contas que o dono precisa guardar (ADR-23).

        Sem histórico, a linha sai inteira: sessões e celular-leitor vão junto pelo
        CASCADE, e o diário perde o vínculo (`ON DELETE SET NULL`), com o nome congelado.
        Com histórico — vendeu, abriu caixa, deu entrada: FKs RESTRICT —, apagar a linha
        daria 500 e reescreveria a contabilidade; ela fica só com o nome e o papel de quem
        fez cada registro, e o que é da CONTA vai embora do mesmo jeito: e-mail (fica livre
        para uma conta nova), senha, sessões, leitor, comissão e meta (a remuneração da
        pessoa; a comissão de cada venda já está congelada nela, ADR-37), com `deleted_at`
        marcando que ela não existe mais (ADR-45). Nos dois casos o e-mail sai também do
        diário, onde vira máscara, e das tentativas de login; o nome congelado de quem agiu
        fica.
        """
        # Import aqui: auth.service importa este módulo (o login autentica por ele).
        from app.modules.auth.service import AuthService

        user_id, email = user.id, user.email
        # A outra exclusão desta conta (outro aparelho, o dono) que chegou antes já levou.
        if not await self.repo.travar_viva(user_id):
            raise NaoEncontrado("Usuário não encontrado.")
        # Nada pendente pode entrar no savepoint de `apagar`: desfeito, ele levaria junto.
        await self.session.flush()
        if not await self.repo.apagar(user):
            # Sessão aberta com refresh token válido sobreviveria: o FK dele é CASCADE, e a
            # linha não saiu.
            await self._derrubar_sessoes(user_id)
            await LeitorService(self.session).esquecer_usuario(user_id)
            user.email = email_da_conta_excluida(user_id)
            user.password_hash = SEM_SENHA
            user.is_active = False
            user.comissao_percentual = Decimal("0")
            user.meta_diaria = None
            user.deleted_at = func.now()
        # O e-mail sai também do diário (as tentativas de login antigas o traziam por
        # extenso) e da tabela da trava de força bruta, que o guarda a cada login. O nome
        # congelado de quem agiu fica: é o que a auditoria prova (ADR-23).
        await AuditoriaService(self.session).esquecer_email(email)
        await AuthService(self.session).esquecer_tentativas(email)
        await self.session.commit()

    async def redefinir_senha(self, user_id: int, nova_senha: str, ator: User) -> None:
        user = await self.obter(user_id)
        # Redefinir a senha do dono daria a chave da casa: é entrar como ele.
        self._barrar_escalada(ator, None, alvo=user)
        self._proteger_conta_da_demonstracao(user)
        user.password_hash = await hash_senha_async(nova_senha)
        await self._derrubar_sessoes(user_id)
        await self.session.commit()

    async def trocar_propria_senha(self, user: User, senha_atual: str, nova_senha: str) -> None:
        self._proteger_conta_da_demonstracao(user)
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
