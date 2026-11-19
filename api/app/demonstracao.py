"""A demonstração: semear, conferir e renovar a loja de mentira (ADR-42, ADR-46).

O MESMO preparo serve às duas formas de a demonstração existir:

- **Vercel** (ADR-42): o build de produção (`scripts/vercel_build.py`) migra o banco e chama
  `preparar_demonstracao(Origem.VERCEL)`. Lá nada mudou: os marcos saem assinados pelo
  "Build da Vercel", o nome da loja fica o que estiver e a senha do dono nunca é trocada.
- **Instalação** (ADR-46): a demonstração que sobe junto com a loja, em `<domínio>/demo` —
  outro contêiner, outro banco, outro segredo de login. O `docker/entrada.sh` roda
  `python -m app.cli preparar-demonstracao` a cada subida, e a renovação da madrugada roda
  `renovar-demonstracao` (zera e semeia de novo, com as datas de hoje).

**Duas chaves, nunca uma.** Semear e zerar um banco é o pior que este código faz, e o banco
de uma loja recém-instalada está VAZIO — exatamente o estado que a carga entende como "pode
semear". Por isso a origem instalação exige as duas: o contêiner se diz demonstração
(`LOJA_DEMONSTRACAO=1`, `settings.demonstracao`) E o banco se diz demonstração (`ALTER
DATABASE loja_demo SET loja.demonstracao = 'sim'`, que o banco da loja nunca tem). Uma
variável copiada por engano para o contêiner da loja não basta para tocar no banco dela.

**A carga é retomável, nunca duplicada.** As contas (DEMO_ADMIN_*, DEMO_VENDEDORA_SENHA) são
validadas pela régua da API ANTES de qualquer escrita. O começo e o fim da carga ficam no
diário de auditoria (`DEMONSTRACAO_INICIADA`, `DEMONSTRACAO_SEMEADA`, pela porta pública
`AuditoriaService`): com o fim lá, nada a semear; com só o começo, a carga caiu no meio e a
próxima rodada a RETOMA — cada passo do seed é idempotente (`client_uuid` fixo por passo,
busca antes de criar). Loja com produto ou venda que a carga não pôs é loja em uso: não é
semeada.

**Nunca imprime senha nem a URL do banco**: erro sai pelo `sem_segredos`, que deixa só a
frase de cada erro de config e a primeira linha das outras exceções.

Nada de `app.*` no topo deste arquivo: importá-lo não pode ler a config. O build da Vercel o
importa antes de saber se a config é válida, e config inválida tem de cair onde o
`sem_segredos` filtra a mensagem.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import secrets
import sys
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from enum import StrEnum

from pydantic import ValidationError

#: A conta de vendedora da demonstração. A senha vem de DEMO_VENDEDORA_SENHA; sem ela, é
#: sorteada e não aparece em lugar nenhum — o dono define outra na tela Usuários. Senha
#: conhecida numa URL pública seria um balcão aberto para qualquer um.
VENDEDORA_EMAIL = "ana@loja.com"

#: Os marcos da carga no diário de auditoria. O dono lê ali quando a demonstração foi posta —
#: e o preparo lê ali se já pôs, se parou no meio ou se nunca começou.
MARCO_INICIO = "DEMONSTRACAO_INICIADA"
MARCO_FIM = "DEMONSTRACAO_SEMEADA"

#: A identidade da demo que sobe com a loja. O catálogo do seed é de roupa (camiseta, calça,
#: vestido): com o ramo neutro da migration as telas diriam "Variação/Tipo" no lugar de
#: "Tamanho/Cor", e o nome padrão ("Minha Loja") confundiria com uma loja de verdade.
NOME_DA_LOJA = "Loja de Demonstração"
RAMO_DA_LOJA = "ROUPAS"

#: O marco do banco: um parâmetro que só o banco da demonstração tem (`ALTER DATABASE ...
#: SET`), lido por toda sessão que abre nele. `current_setting(..., true)` devolve NULL
#: quando não existe, em vez de erro — o banco da loja simplesmente não é.
SQL_DO_MARCO = "SELECT coalesce(current_setting('loja.demonstracao', true), '') = 'sim'"

#: A trava consultiva que põe preparo e renovação em fila (o número lembra o ADR-46). De
#: SESSÃO, presa numa conexão própria do começo ao fim: o preparo abre e fecha várias
#: conexões (e um event loop por passo), e uma trava de transação soltaria no meio.
_ESPACO_TRAVA = 46
_CHAVE_TRAVA = 1


def _passo(texto: str) -> None:
    print(f"==> {texto}", flush=True)


@dataclass(frozen=True)
class _Jeito:
    """O que muda de uma origem para a outra: quem assina e o que dizer a quem lê o log."""

    #: Quem assina os marcos no diário (a Auditoria mostra este nome).
    autor: str
    #: Quem carrega, na frase dos marcos.
    quem: str
    adr: str
    #: Como corrigir uma variável de conta inválida.
    corrigir_conta: str
    #: O que fazer quando a carga cai no meio.
    parou_no_meio: str
    #: A carga anterior parou no meio, e esta retoma.
    retomando: str


class Origem(StrEnum):
    """De onde vem o preparo: o build da Vercel ou a demonstração que sobe com a loja."""

    VERCEL = "vercel"
    INSTALACAO = "instalacao"

    @property
    def jeito(self) -> _Jeito:
        return _JEITOS[self]


_JEITOS = {
    Origem.VERCEL: _Jeito(
        autor="Build da Vercel",
        quem="o build da Vercel",
        adr="ADR-42",
        corrigir_conta="Corrija a variável em Settings → Environment Variables e faça Redeploy",
        parou_no_meio=(
            "A carga da demonstração parou no meio. Faça Redeploy: o próximo build retoma de "
            "onde parou, sem duplicar nada."
        ),
        retomando="a carga da demonstração parou no meio num build anterior: retomando",
    ),
    Origem.INSTALACAO: _Jeito(
        autor="Demonstração (instalação)",
        quem="a instalação",
        adr="ADR-46",
        corrigir_conta="Corrija a variável no .env da loja e rode ./demo.sh --ligar",
        parou_no_meio=(
            "A carga da demonstração parou no meio. A próxima subida da demonstração (ou "
            "./demo.sh --renovar) retoma de onde parou, sem duplicar nada."
        ),
        retomando="a carga da demonstração parou no meio numa subida anterior: retomando",
    ),
}


class Estado(StrEnum):
    #: Sem produto nem venda e sem marco: a carga pode começar.
    VAZIA = "vazia"
    #: Começou e não terminou (o preparo caiu no meio): o próximo retoma.
    PELA_METADE = "pela_metade"
    SEMEADA = "semeada"
    #: Tem produto ou venda e não foi a carga que pôs: é de alguém, não se mexe.
    EM_USO = "em_uso"


def decidir_estado(*, inicio: bool, fim: bool, tem_movimento: bool) -> Estado:
    if fim:
        return Estado.SEMEADA
    if inicio:
        return Estado.PELA_METADE
    return Estado.EM_USO if tem_movimento else Estado.VAZIA


def sem_segredos(exc: BaseException) -> str:
    """O que caiu, sem o que não pode ir para o log.

    A config inválida (pydantic) repetia os valores lidos no `input_value` — a URL do banco
    com a senha junto —, então dela sai só a frase de cada erro. Das outras, a primeira
    linha: as seguintes do SQLAlchemy são `[SQL: ...]` e `[parameters: ...]`.
    """
    erros = getattr(exc, "errors", None)
    if callable(erros):
        try:
            return "Configuração inválida: " + "; ".join(e["msg"] for e in erros())
        except Exception:  # noqa: BLE001 — `errors` que não é o do pydantic
            pass
    primeira = (str(exc).strip().splitlines() or [""])[0]
    return f"{type(exc).__name__}: {primeira}"


def _erros_sem_valor(erro: ValidationError, nomes: dict[str, str]) -> str:
    """As regras que a conta não cumpre, com o nome da variável — nunca o valor digitado."""
    from app.modules.usuarios.schemas import SENHA_MIN

    regras = {
        "nome": "de 2 a 120 letras",
        "email": "um e-mail válido",
        "senha": f"de {SENHA_MIN} a 72 caracteres",
    }
    campos = dict.fromkeys(str(e["loc"][0]) for e in erro.errors() if e["loc"])
    return "; ".join(
        f"{nomes.get(c, c)} precisa ter {regras.get(c, 'um valor válido')}" for c in campos
    )


def contas_da_demonstracao(
    ambiente: Mapping[str, str], origem: Origem | str
) -> tuple[dict[str, str], dict[str, str]] | None:
    """O dono e a vendedora, VALIDADOS pela régua da própria API, antes de tocar no banco.

    `None` sem DEMO_ADMIN_EMAIL/DEMO_ADMIN_SENHA. Conta inválida para aqui, com o nome da
    variável e o jeito de corrigir de cada origem: criar o dono e cair na vendedora deixava a
    carga pela metade.
    """
    from app.modules.usuarios.models import Papel
    from app.modules.usuarios.schemas import UsuarioCreate

    jeito = Origem(origem).jeito
    email = ambiente.get("DEMO_ADMIN_EMAIL", "").strip()
    senha = ambiente.get("DEMO_ADMIN_SENHA", "")
    if not (email and senha):
        return None
    admin = {
        "nome": ambiente.get("DEMO_ADMIN_NOME", "").strip() or "Dona Maria",
        "email": email,
        "senha": senha,
    }
    vendedora = {
        "nome": "Ana Vendedora",
        "email": VENDEDORA_EMAIL,
        "senha": ambiente.get("DEMO_VENDEDORA_SENHA", "") or secrets.token_urlsafe(18),
        "papel": "VENDEDOR",
    }
    for conta, papel, nomes in (
        (admin, Papel.ADMIN, {
            "nome": "DEMO_ADMIN_NOME", "email": "DEMO_ADMIN_EMAIL", "senha": "DEMO_ADMIN_SENHA"
        }),
        (vendedora, Papel.VENDEDOR, {"senha": "DEMO_VENDEDORA_SENHA"}),
    ):
        try:
            UsuarioCreate(
                nome=conta["nome"], email=conta["email"], senha=conta["senha"], papel=papel
            )
        except ValidationError as erro:
            raise SystemExit(
                f"Conta da demonstração inválida: {_erros_sem_valor(erro, nomes)}. "
                f"{jeito.corrigir_conta} (nada foi gravado)."
            ) from None
    return admin, vendedora


# ------------------------------------------------------------------ as duas chaves


async def _ler_marco_do_banco() -> bool:
    from sqlalchemy import text

    from app.core.db import engine

    try:
        async with engine.connect() as conn:
            return bool(await conn.scalar(text(SQL_DO_MARCO)))
    finally:
        await engine.dispose()


def banco_e_de_demonstracao() -> bool:
    """O banco desta API tem o marco da demonstração? (o da loja nunca tem)."""
    return asyncio.run(_ler_marco_do_banco())


def motivo_para_recusar() -> str | None:
    """Por que esta API NÃO pode semear nem zerar o banco dela — ou None, se pode.

    As duas chaves da origem instalação: o contêiner (LOJA_DEMONSTRACAO=1) e o banco (o
    marco). A frase diz qual faltou e garante que nada foi tocado; nunca leva a URL.
    """
    from app.core.config import settings

    if not settings.demonstracao:
        return (
            "Esta API não é a da demonstração (falta LOJA_DEMONSTRACAO=1 neste contêiner): "
            "nada foi feito. A demonstração roda no serviço api-demo; ligue-a com "
            "./demo.sh --ligar."
        )
    if not banco_e_de_demonstracao():
        return (
            "O banco desta API não tem o marco da demonstração (loja.demonstracao = 'sim'): "
            "nada foi feito. Só o banco da demonstração tem o marco — quem o põe é o serviço "
            "demo-banco, a cada subida —, e só ele se semeia e se zera; o da loja, nunca."
        )
    return None


@contextlib.contextmanager
def _uma_de_cada_vez() -> Iterator[None]:
    """Preparo e renovação em fila, por uma trava de sessão (`pg_advisory_lock`).

    Quem dispara são dois: a subida do contêiner (`entrada.sh`) e a renovação (o timer da
    madrugada ou `./demo.sh --renovar`). Juntos, um zeraria as tabelas no meio da carga do
    outro, e o "busca antes de criar" do seed não é atômico. A trava fica numa conexão só
    dela, num event loop só dela, do começo ao fim; fechar a conexão a solta — também
    quando o processo morre no meio.
    """
    import asyncpg

    from app.core.config import settings
    from app.core.url_do_banco import argumentos_asyncpg

    laco = asyncio.new_event_loop()
    try:
        conexao = laco.run_until_complete(
            asyncpg.connect(
                settings.database_url.replace("postgresql+asyncpg://", "postgresql://"),
                **argumentos_asyncpg(ssl=settings.db_ssl, pooler=settings.db_pooler),
            )
        )
        try:
            livre = laco.run_until_complete(
                conexao.fetchval("SELECT pg_try_advisory_lock($1, $2)", _ESPACO_TRAVA, _CHAVE_TRAVA)
            )
            if not livre:
                _passo("outro preparo ou renovação da demonstração está rodando: esperando")
                laco.run_until_complete(
                    conexao.execute("SELECT pg_advisory_lock($1, $2)", _ESPACO_TRAVA, _CHAVE_TRAVA)
                )
            yield
        finally:
            try:
                laco.run_until_complete(conexao.close(timeout=10))
            except Exception:  # noqa: BLE001 — conexão que já caiu levou a trava junto
                conexao.terminate()
    finally:
        laco.close()


# ------------------------------------------------------------------ o banco


async def _ler_estado() -> Estado:
    from sqlalchemy import text

    from app.core.db import engine

    try:
        async with engine.connect() as conn:
            linha = (
                await conn.execute(
                    text(
                        "SELECT EXISTS (SELECT 1 FROM audit_log WHERE acao = :inicio), "
                        "EXISTS (SELECT 1 FROM audit_log WHERE acao = :fim), "
                        "EXISTS (SELECT 1 FROM products) OR EXISTS (SELECT 1 FROM sales)"
                    ),
                    {"inicio": MARCO_INICIO, "fim": MARCO_FIM},
                )
            ).one()
        return decidir_estado(inicio=linha[0], fim=linha[1], tem_movimento=linha[2])
    finally:
        # A próxima etapa usa o mesmo engine noutro event loop (o do TestClient): conexão
        # presa a ESTE loop não pode ficar no pool.
        await engine.dispose()


async def _marcar(origem: Origem, acao: str) -> None:
    from app.core.db import SessionLocal, engine
    from app.modules.auditoria.service import AuditoriaService

    jeito = origem.jeito
    verbo = "começou" if acao == MARCO_INICIO else "terminou"
    try:
        async with SessionLocal() as session:
            AuditoriaService(session).registrar(
                user_id=None,
                user_nome=jeito.autor,
                user_papel=None,
                acao=acao,
                descricao=f"Demonstração: {jeito.quem} {verbo} a carga ({jeito.adr})",
            )
            await session.commit()
    finally:
        await engine.dispose()


async def _criar_dono(nome: str, email: str, senha: str) -> int:
    from app.cli import _create_admin
    from app.core.db import engine

    try:
        return await _create_admin(nome, email, senha)
    finally:
        await engine.dispose()


async def _convergir_dono(admin: Mapping[str, str]) -> None:
    """A conta das notas da Apple como o revisor precisa dela: existe, é dona, está ativa e
    entra com DEMO_ADMIN_SENHA. A cada preparo da instalação (ADR-46).

    A API não deixa ninguém mexer nela (ADR-45), mas o banco pode ter vindo de antes da
    proteção, e a senha do .env pode ter mudado. Sem isto, o revisor só entraria de novo
    depois de alguém consertar o banco à mão. Senha refeita derruba as sessões abertas, como
    toda troca de senha.
    """
    from sqlalchemy import func, select, update

    from app.cli import _create_admin
    from app.core.db import SessionLocal, engine
    from app.core.security import hash_senha_async, verificar_senha_async
    from app.modules.auth.models import RefreshToken
    from app.modules.usuarios.models import Papel, User

    try:
        async with SessionLocal() as session:
            conta = (
                await session.execute(
                    select(User).where(
                        func.lower(User.email) == admin["email"].strip().lower(),
                        User.deleted_at.is_(None),
                    )
                )
            ).scalar_one_or_none()
            if conta is None:
                if await _create_admin(admin["nome"], admin["email"], admin["senha"]) != 0:
                    raise SystemExit(
                        "Não deu para criar a conta das notas da revisão (veja a mensagem "
                        "acima)."
                    )
                return
            acertos: list[str] = []
            if conta.role != Papel.ADMIN:
                conta.role = Papel.ADMIN
                acertos.append("papel de dono")
            if not conta.is_active:
                conta.is_active = True
                acertos.append("ativa")
            if not await verificar_senha_async(admin["senha"], conta.password_hash):
                conta.password_hash = await hash_senha_async(admin["senha"])
                await session.execute(
                    update(RefreshToken)
                    .where(RefreshToken.user_id == conta.id, RefreshToken.revoked.is_(False))
                    .values(revoked=True)
                )
                acertos.append("senha a de DEMO_ADMIN_SENHA")
            if acertos:
                await session.commit()
                _passo(f"conta das notas da revisão acertada ({', '.join(acertos)}): {conta.email}")
            else:
                _passo(f"conta das notas da revisão conferida: {conta.email}")
    finally:
        await engine.dispose()


async def _dar_nome_a_loja() -> None:
    """O nome (NOME_DA_LOJA) e o ramo roupas — a cada preparo, que a renovação zera tudo."""
    from app.core.db import SessionLocal, engine
    from app.core.segmentos import Segmento
    from app.modules.configuracao.schemas import ConfiguracaoUpdate
    from app.modules.configuracao.service import ConfiguracaoService

    try:
        async with SessionLocal() as session:
            servico = ConfiguracaoService(session)
            config = await servico.obter()
            if config.nome != NOME_DA_LOJA or config.segmento != RAMO_DA_LOJA:
                await servico.atualizar(
                    ConfiguracaoUpdate(nome=NOME_DA_LOJA, segmento=Segmento(RAMO_DA_LOJA))
                )
                _passo(f"loja chamada \"{NOME_DA_LOJA}\", ramo roupas")
    finally:
        await engine.dispose()


async def _zerar() -> int:
    """TRUNCATE de todas as tabelas do schema public menos `alembic_version`.

    Confere o marco do banco NA MESMA transação do TRUNCATE: entre a conferência da CLI e
    aqui não há janela em que outro banco passe por demonstração. As sequências voltam ao
    começo (as das colunas pelo RESTART IDENTITY; as soltas, como a do código interno de
    barras, uma a uma): a demo renovada é igual à primeira.
    """
    from sqlalchemy import text

    from app.core.db import engine

    try:
        async with engine.begin() as conn:
            if not await conn.scalar(text(SQL_DO_MARCO)):
                raise SystemExit(
                    "O banco desta API não tem o marco da demonstração: nada foi zerado."
                )
            tabelas = (
                await conn.execute(
                    text(
                        "SELECT quote_ident(tablename) FROM pg_tables "
                        "WHERE schemaname = 'public' AND tablename <> 'alembic_version' "
                        "ORDER BY tablename"
                    )
                )
            ).scalars().all()
            if tabelas:
                lista = ", ".join(f"public.{t}" for t in tabelas)
                await conn.execute(text(f"TRUNCATE {lista} RESTART IDENTITY CASCADE"))
            sequencias = (
                await conn.execute(
                    text(
                        "SELECT quote_ident(sequence_name) FROM information_schema.sequences "
                        "WHERE sequence_schema = 'public'"
                    )
                )
            ).scalars().all()
            for sequencia in sequencias:
                await conn.execute(text(f"ALTER SEQUENCE public.{sequencia} RESTART"))
        return len(tabelas)
    finally:
        await engine.dispose()


# ------------------------------------------------------------------ a carga


def semear(admin: dict[str, str], vendedora: dict[str, str]) -> None:
    """A demonstração inteira pela API, com a API dentro deste processo.

    A API, não o envoltório do prefixo: a carga fala com as rotas de sempre (`/api/v1`),
    com prefixo ou sem (ADR-46). O seed mora em `scripts/` (a imagem e o build da Vercel o
    levam; a função da Vercel, não — e ela nunca semeia).
    """
    from app.core.config import PASTA_API

    pasta_scripts = str(PASTA_API / "scripts")
    if pasta_scripts not in sys.path:
        sys.path.insert(0, pasta_scripts)
    import seed_demo
    from fastapi.testclient import TestClient

    from app.core.db import engine
    from app.main import api

    with TestClient(api, base_url="http://demonstracao/api/v1") as cliente:
        try:
            if seed_demo.popular(cliente, admin, vendedora) != 0:
                raise SystemExit(
                    "O seed da demonstração não conseguiu entrar como o dono: DEMO_ADMIN_SENHA "
                    "não é a senha da conta DEMO_ADMIN_EMAIL que já existe."
                )
        finally:
            # As conexões do pool são do event loop do TestClient; o marco final roda noutro.
            cliente.portal.call(engine.dispose)


def _semear_e_marcar(origem: Origem, admin: dict[str, str], vendedora: dict[str, str]) -> None:
    try:
        semear(admin, vendedora)
    except BaseException:
        print(f"\n{origem.jeito.parou_no_meio}", file=sys.stderr)
        raise
    asyncio.run(_marcar(origem, MARCO_FIM))
    senha = (
        "a de DEMO_VENDEDORA_SENHA"
        if os.environ.get("DEMO_VENDEDORA_SENHA")
        else "sorteada; defina outra em Usuários"
    )
    _passo(
        f"demonstração semeada; dono: {admin['email']}; vendedora: {VENDEDORA_EMAIL} "
        f"(senha {senha})"
    )


def _garantir_dono_da_demonstracao() -> None:
    """Demonstração já semeada na Vercel: o dono das notas da revisão continua lá?

    Lá a conta DEMO_ADMIN_EMAIL não se exclui (ADR-45), mas uma demo de antes da trava pode
    tê-la perdido — e aí o revisor não entra. O e-mail de quem saiu fica livre, e o
    `create-admin` é idempotente: cria se falta, não mexe se existe. Nunca derruba o build:
    o resto da demonstração continua servindo.
    """
    try:
        contas = contas_da_demonstracao(os.environ, Origem.VERCEL)
    except SystemExit as erro:
        _passo(f"aviso: dono da demonstração não conferido ({erro})")
        return
    if contas is None:
        return
    admin, _ = contas
    if asyncio.run(_criar_dono(admin["nome"], admin["email"], admin["senha"])) != 0:
        _passo(
            "aviso: o e-mail DEMO_ADMIN_EMAIL está numa conta que não é de dono ativo; "
            "a conta das notas da revisão não entra como dono (veja Usuários na demo)"
        )


def _preparar_na_vercel() -> None:
    """O build de produção da Vercel, como sempre foi (ADR-42)."""
    estado = asyncio.run(_ler_estado())
    if estado is Estado.SEMEADA:
        _passo("demonstração já semeada (Auditoria mostra quando): nada a semear")
        _garantir_dono_da_demonstracao()
        return
    if estado is Estado.EM_USO:
        _passo("a loja já tem produtos ou vendas que não vieram da carga: nada a semear")
        return

    contas = contas_da_demonstracao(os.environ, Origem.VERCEL)
    if contas is None:
        _passo(
            "sem DEMO_ADMIN_EMAIL/DEMO_ADMIN_SENHA: nada semeado (defina as duas e faça "
            "Redeploy, ou crie o dono pela CLI)"
        )
        return
    admin, vendedora = contas

    if estado is Estado.PELA_METADE:
        _passo(Origem.VERCEL.jeito.retomando)
    else:
        asyncio.run(_marcar(Origem.VERCEL, MARCO_INICIO))
    if asyncio.run(_criar_dono(admin["nome"], admin["email"], admin["senha"])) != 0:
        raise SystemExit("Não deu para criar o dono da demonstração (veja a mensagem acima).")
    _semear_e_marcar(Origem.VERCEL, admin, vendedora)


def _contas_da_instalacao() -> tuple[dict[str, str], dict[str, str]]:
    """O dono e a vendedora da demo que sobe com a loja, validados — ou a parada, com a frase.

    Preparo e renovação chamam isto logo depois das duas chaves, ANTES da trava e de qualquer
    escrita. A renovação já zerou as tabelas para só então descobrir a DEMO_ADMIN_SENHA
    faltando (ou curta) no .env: a demo ficava vazia, sem a conta do revisor, e a frase ainda
    dizia "nada foi feito".
    """
    contas = contas_da_demonstracao(os.environ, Origem.INSTALACAO)
    if contas is None:
        raise SystemExit(
            "Faltam DEMO_ADMIN_EMAIL e DEMO_ADMIN_SENHA no ambiente da demonstração: nada foi "
            "feito. Elas moram no .env da loja; ./demo.sh --ligar gera as que faltam."
        )
    return contas


def _preparar_na_instalacao(admin: dict[str, str], vendedora: dict[str, str]) -> None:
    """A demo que sobe com a loja (ADR-46): a carga, mais a conta e o nome conferidos a cada
    subida — é o que deixa a demonstração "vir pronta", sem ninguém fazer nada à mão. As
    contas chegam validadas por `_contas_da_instalacao`."""
    estado = asyncio.run(_ler_estado())
    if estado is Estado.VAZIA:
        asyncio.run(_marcar(Origem.INSTALACAO, MARCO_INICIO))
    elif estado is Estado.PELA_METADE:
        _passo(Origem.INSTALACAO.jeito.retomando)
    asyncio.run(_convergir_dono(admin))
    asyncio.run(_dar_nome_a_loja())

    if estado is Estado.SEMEADA:
        _passo("demonstração já semeada (Auditoria mostra quando): nada a semear")
        return
    if estado is Estado.EM_USO:
        _passo(
            "o banco da demonstração já tem produtos ou vendas que não vieram da carga: nada "
            "a semear (./demo.sh --renovar zera e semeia de novo)"
        )
        return
    _semear_e_marcar(Origem.INSTALACAO, admin, vendedora)


def preparar_demonstracao(origem: Origem | str) -> None:
    """Semeia a demonstração, ou confere a que já está lá. Retomável e idempotente.

    Na origem instalação exige as duas chaves (`motivo_para_recusar`) e roda em fila com a
    renovação. Na Vercel, o de sempre: o build é um por deploy, e uma trava de sessão presa
    num banco serverless (o processo do build morto sem fechar a conexão) seguraria o
    próximo deploy sem prazo.
    """
    origem = Origem(origem)
    if origem is Origem.VERCEL:
        _preparar_na_vercel()
        return
    motivo = motivo_para_recusar()
    if motivo:
        raise SystemExit(motivo)
    admin, vendedora = _contas_da_instalacao()
    with _uma_de_cada_vez():
        _preparar_na_instalacao(admin, vendedora)


def renovar_demonstracao() -> None:
    """Zera o banco da demonstração e semeia de novo — as vendas voltam a ser "de hoje".

    O seed conta as datas a partir do dia da carga: sem renovar, em uma semana os relatórios
    de hoje e da semana ficam vazios e quem testa vê uma loja parada. Só a origem instalação
    renova (na Vercel, zerar é DROP SCHEMA + Redeploy, à mão). As contas são conferidas antes
    do TRUNCATE: com elas inválidas no .env, a renovação para sem tocar em nada e a demo de
    ontem segue no ar, com a conta do revisor.
    """
    motivo = motivo_para_recusar()
    if motivo:
        raise SystemExit(motivo)
    admin, vendedora = _contas_da_instalacao()
    with _uma_de_cada_vez():
        tabelas = asyncio.run(_zerar())
        _passo(f"demonstração zerada ({tabelas} tabelas); semeando de novo")
        _preparar_na_instalacao(admin, vendedora)
