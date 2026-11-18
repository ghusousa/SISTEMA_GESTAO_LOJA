"""Build da Vercel (ADR-42): roda depois de instalar as dependências, antes de publicar.

    pyproject.toml → [tool.vercel.scripts] build = "python scripts/vercel_build.py"

Em ordem:

1. **Confere a trava.** O que está instalado tem de ser, versão por versão, o
   requirements.lock — o `vercel_instalar.py` instala dele, e se a Vercel não o tiver rodado
   (o uv teria resolvido o `>=` do pyproject), o deploy reprova AQUI, com o porquê.
2. **Copia o sistema web** (`web/`, fora do Root Directory `api/`) para dentro do projeto, onde
   a função o enxerga: a mesma pasta, as mesmas páginas legais, servidas pelo mesmo FastAPI.
3. **Só no deploy de PRODUÇÃO** (`VERCEL_ENV=production`), e só com o banco conectado (sem
   DATABASE_URL o build pararia num "Connect call failed" de localhost; para antes, dizendo o
   que ligar): `alembic upgrade head` e a demonstração — o dono (a mesma porta do
   `python -m app.cli create-admin`) e a loja cheia pelo `seed_demo.popular()`, com a API
   DENTRO deste processo, porque no build não há servidor de pé. Preview não toca no banco: o
   preview de um branch não migra o banco da demonstração por baixo do deploy que está no ar.

**A carga é retomável, nunca duplicada.** As contas (DEMO_ADMIN_*, DEMO_VENDEDORA_SENHA) são
validadas pela régua da API ANTES de qualquer escrita. O começo e o fim da carga ficam no diário
de auditoria (`DEMONSTRACAO_INICIADA`, `DEMONSTRACAO_SEMEADA`, pela porta pública
`AuditoriaService`): com o fim lá, nada a fazer; com só o começo, a carga caiu no meio (rede,
Neon) e o Redeploy a RETOMA — cada passo do seed é idempotente (`client_uuid` fixo por passo,
busca antes de criar). Loja com produto ou venda que não foi este build que pôs é loja em uso:
não é semeada. **Nunca imprime senha nem a URL do banco**: erro sai com o rastro do código e só a
primeira linha da mensagem (a do SQLAlchemy traz os parâmetros nas seguintes).
"""

from __future__ import annotations

import asyncio
import os
import secrets
import shutil
import sys
import traceback
from collections.abc import Mapping
from enum import StrEnum
from pathlib import Path

from pydantic import ValidationError

PASTA_API = Path(__file__).resolve().parent.parent
PASTA_SCRIPTS = Path(__file__).resolve().parent
# Rodando como script, o Python põe scripts/ no path — e não a raiz da API, onde `app` vive.
sys.path.insert(0, str(PASTA_API))
sys.path.insert(0, str(PASTA_SCRIPTS))

# Nada de `app` aqui em cima: importá-lo lê a config, e config inválida tem de cair DENTRO do
# `main()`, onde `_sem_segredos` tira a URL do banco da mensagem.
import vercel_instalar  # noqa: E402

#: A conta de vendedora da demonstração. A senha vem de DEMO_VENDEDORA_SENHA; sem ela, é
#: sorteada e não aparece em lugar nenhum — o dono define outra na tela Usuários. Senha
#: conhecida numa URL pública seria um balcão aberto para qualquer um.
VENDEDORA_EMAIL = "ana@loja.com"


def _passo(texto: str) -> None:
    print(f"==> {texto}", flush=True)


def conferir_trava() -> None:
    travadas = vercel_instalar.ler_trava()
    erradas = vercel_instalar.divergencias(travadas)
    if erradas:
        raise SystemExit(
            "As dependências instaladas não são as do requirements.lock:\n  "
            + "\n  ".join(erradas)
            + "\nA Vercel não rodou o installCommand do vercel.json. Em Settings → Build and "
            "Deployment, deixe o Install Command sem override (ou com "
            "`python scripts/vercel_instalar.py`) e faça Redeploy."
        )
    _passo(f"dependências conferidas: {len(travadas)} versões, todas as do requirements.lock")


def copiar_web(origem: Path, destino: Path) -> None:
    """Copia `web/` (com as páginas legais) para onde a função vai procurá-lo."""
    if not (origem / "index.html").is_file():
        raise SystemExit(
            f"Não achei o sistema web em {origem}. Ele mora fora do Root Directory (api/): em "
            "Settings → Build and Deployment → Root Directory, deixe LIGADO \"Include files "
            "outside the root directory in the Build Step\" e faça Redeploy."
        )
    if destino.resolve() == origem.resolve():
        return
    if destino.exists():
        shutil.rmtree(destino)
    shutil.copytree(origem, destino)
    arquivos = sum(1 for p in destino.rglob("*") if p.is_file())
    _passo(f"sistema web copiado para {destino} ({arquivos} arquivos)")


def migrar() -> None:
    from alembic.config import Config

    from alembic import command

    cfg = Config(str(PASTA_API / "alembic.ini"))
    cfg.set_main_option("script_location", str(PASTA_API / "alembic"))
    command.upgrade(cfg, "head")
    _passo("banco migrado (alembic upgrade head)")


#: Os marcos da carga no diário de auditoria. O dono lê ali quando a demonstração foi posta —
#: e o build lê ali se já pôs, se parou no meio ou se nunca começou.
MARCO_INICIO = "DEMONSTRACAO_INICIADA"
MARCO_FIM = "DEMONSTRACAO_SEMEADA"


class Estado(StrEnum):
    #: Sem produto nem venda e sem marco: a carga pode começar.
    VAZIA = "vazia"
    #: Começou e não terminou (o build caiu no meio): o próximo retoma.
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


def falta_o_banco(ambiente: Mapping[str, str]) -> str | None:
    """O motivo para não migrar, se o banco não foi conectado ao projeto.

    Sem DATABASE_URL a config cai no padrão da loja (localhost) e o build morreria num
    "Connect call failed" que não diz nada. No primeiro deploy é o normal: o Neon só se cria
    na aba Storage DEPOIS que o projeto existe.
    """
    if ambiente.get("DATABASE_URL") or ambiente.get("DATABASE_URL_UNPOOLED"):
        return None
    com_prefixo = sorted(
        nome for nome in ambiente if nome.endswith(("_DATABASE_URL", "_DATABASE_URL_UNPOOLED"))
    )
    dica = (
        f" Achei {', '.join(com_prefixo)}: o banco foi conectado COM prefixo. Desconecte e "
        "conecte de novo deixando o campo de prefixo vazio."
        if com_prefixo
        else ""
    )
    return (
        "Nenhum banco conectado (falta DATABASE_URL). Conecte o banco Neon: aba Storage → o "
        "banco → Connect Project, ambiente Production, sem prefixo; depois Deployments → "
        "Redeploy." + dica
    )


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
    ambiente: Mapping[str, str],
) -> tuple[dict[str, str], dict[str, str]] | None:
    """O dono e a vendedora, VALIDADOS pela régua da própria API, antes de tocar no banco.

    `None` sem DEMO_ADMIN_EMAIL/DEMO_ADMIN_SENHA. Conta inválida para o build aqui, com o nome
    da variável: criar o dono e cair na vendedora deixava a carga pela metade.
    """
    from app.modules.usuarios.models import Papel
    from app.modules.usuarios.schemas import UsuarioCreate

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
                f"Conta da demonstração inválida: {_erros_sem_valor(erro, nomes)}. Corrija a "
                "variável em Settings → Environment Variables e faça Redeploy (nada foi gravado)."
            ) from None
    return admin, vendedora


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


async def _marcar(acao: str, descricao: str) -> None:
    from app.core.db import SessionLocal, engine
    from app.modules.auditoria.service import AuditoriaService

    try:
        async with SessionLocal() as session:
            AuditoriaService(session).registrar(
                user_id=None,
                user_nome="Build da Vercel",
                user_papel=None,
                acao=acao,
                descricao=descricao,
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


def semear(admin: dict[str, str], vendedora: dict[str, str]) -> None:
    """A demonstração inteira pela API, com a API dentro deste processo."""
    import seed_demo
    from fastapi.testclient import TestClient

    from app.core.db import engine
    from app.main import app

    with TestClient(app, base_url="http://demonstracao/api/v1") as cliente:
        try:
            if seed_demo.popular(cliente, admin, vendedora) != 0:
                raise SystemExit(
                    "O seed da demonstração não conseguiu entrar como o dono: DEMO_ADMIN_SENHA "
                    "não é a senha da conta DEMO_ADMIN_EMAIL que já existe."
                )
        finally:
            # As conexões do pool são do event loop do TestClient; o marco final roda noutro.
            cliente.portal.call(engine.dispose)


def _garantir_dono_da_demonstracao() -> None:
    """Demonstração já semeada: o dono das notas da revisão continua lá?

    Na Vercel a conta DEMO_ADMIN_EMAIL não se exclui (ADR-45), mas uma demo de antes da
    trava pode tê-la perdido — e aí o revisor não entra. O e-mail de quem saiu fica livre, e o
    `create-admin` é idempotente: cria se falta, não mexe se existe. Nunca derruba o build:
    o resto da demonstração continua servindo.
    """
    try:
        contas = contas_da_demonstracao(os.environ)
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


def preparar_demonstracao() -> None:
    estado = asyncio.run(_ler_estado())
    if estado is Estado.SEMEADA:
        _passo("demonstração já semeada (Auditoria mostra quando): nada a semear")
        _garantir_dono_da_demonstracao()
        return
    if estado is Estado.EM_USO:
        _passo("a loja já tem produtos ou vendas que não vieram da carga: nada a semear")
        return

    contas = contas_da_demonstracao(os.environ)
    if contas is None:
        _passo(
            "sem DEMO_ADMIN_EMAIL/DEMO_ADMIN_SENHA: nada semeado (defina as duas e faça "
            "Redeploy, ou crie o dono pela CLI)"
        )
        return
    admin, vendedora = contas

    if estado is Estado.PELA_METADE:
        _passo("a carga da demonstração parou no meio num build anterior: retomando")
    else:
        asyncio.run(
            _marcar(MARCO_INICIO, "Demonstração: o build da Vercel começou a carga (ADR-42)")
        )
    if asyncio.run(_criar_dono(admin["nome"], admin["email"], admin["senha"])) != 0:
        raise SystemExit("Não deu para criar o dono da demonstração (veja a mensagem acima).")
    try:
        semear(admin, vendedora)
    except BaseException:
        print(
            "\nA carga da demonstração parou no meio. Faça Redeploy: o próximo build retoma de "
            "onde parou, sem duplicar nada.",
            file=sys.stderr,
        )
        raise
    asyncio.run(_marcar(MARCO_FIM, "Demonstração: o build da Vercel terminou a carga (ADR-42)"))
    origem = (
        "a de DEMO_VENDEDORA_SENHA"
        if os.environ.get("DEMO_VENDEDORA_SENHA")
        else "sorteada; defina outra em Usuários"
    )
    _passo(
        f"demonstração semeada; dono: {admin['email']}; vendedora: {VENDEDORA_EMAIL} "
        f"(senha {origem})"
    )


def main() -> int:
    from app.core.config import settings

    if not settings.vercel:
        print("Este build é o da Vercel (VERCEL=1). Na loja, quem sobe é o ./atualizar.sh.")
        return 1

    conferir_trava()
    copiar_web(PASTA_API.parent / "web", Path(settings.web_dir))

    ambiente = settings.vercel_env or "(sem VERCEL_ENV)"
    if settings.vercel_env != "production":
        _passo(f"deploy de {ambiente}: o banco não é tocado (só produção migra e semeia)")
        return 0
    motivo = falta_o_banco(os.environ)
    if motivo:
        raise SystemExit(motivo)
    migrar()
    preparar_demonstracao()
    return 0


def _sem_segredos(exc: BaseException) -> str:
    """O que caiu, sem o que não pode ir para o log do build.

    A config inválida (pydantic) repete TODOS os valores lidos no `input_value` — a URL do
    banco com a senha junto —, então dela sai só a frase de cada erro. Das outras, a primeira
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


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except BaseException as exc:  # noqa: BLE001 — o build tem de dizer o que caiu, sem segredo
        traceback.print_tb(exc.__traceback__)
        print(_sem_segredos(exc), file=sys.stderr)
        sys.exit(1)
