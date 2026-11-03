"""Build da Vercel (ADR-42): roda depois de instalar as dependências, antes de publicar.

    pyproject.toml → [tool.vercel.scripts] build = "python scripts/vercel_build.py"

Em ordem:

1. **Confere a trava.** O que está instalado tem de ser, versão por versão, o
   requirements.lock — o `vercel_instalar.py` instala dele, e se a Vercel não o tiver rodado
   (o uv teria resolvido o `>=` do pyproject), o deploy reprova AQUI, com o porquê.
2. **Copia o sistema web** (`web/`, fora do Root Directory `api/`) para dentro do projeto, onde
   a função o enxerga: a mesma pasta, as mesmas páginas legais, servidas pelo mesmo FastAPI.
3. **Só no deploy de PRODUÇÃO** (`VERCEL_ENV=production`): `alembic upgrade head`; e, se a loja
   não tem usuário nenhum e `DEMO_ADMIN_EMAIL`/`DEMO_ADMIN_SENHA` existem, cria o dono (a mesma
   porta do `python -m app.cli create-admin`) e enche a demonstração pelo `seed_demo.popular()`
   — com a API DENTRO deste processo, porque no build não há servidor de pé. Preview não toca
   no banco: o preview de um branch não migra o banco da demonstração por baixo do deploy que
   está no ar.

Idempotente: com alguém cadastrado, não cria nem semeia de novo — build repetido não duplica
nada. **Nunca imprime senha nem a URL do banco**: erro sai com o rastro do código e só a
primeira linha da mensagem (a do SQLAlchemy traz os parâmetros nas seguintes).
"""

from __future__ import annotations

import asyncio
import os
import secrets
import shutil
import sys
import traceback
from pathlib import Path

PASTA_API = Path(__file__).resolve().parent.parent
PASTA_SCRIPTS = Path(__file__).resolve().parent
# Rodando como script, o Python põe scripts/ no path — e não a raiz da API, onde `app` vive.
sys.path.insert(0, str(PASTA_API))
sys.path.insert(0, str(PASTA_SCRIPTS))

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


async def _ha_usuario() -> bool:
    from sqlalchemy import text

    from app.core.db import engine

    try:
        async with engine.connect() as conn:
            return bool((await conn.execute(text("SELECT EXISTS (SELECT 1 FROM users)"))).scalar())
    finally:
        # A próxima etapa usa o mesmo engine noutro event loop (o do TestClient): conexão
        # presa a ESTE loop não pode ficar no pool.
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

    from app.main import app

    with TestClient(app, base_url="http://demonstracao/api/v1") as cliente:
        if seed_demo.popular(cliente, admin, vendedora) != 0:
            raise SystemExit("O seed da demonstração não conseguiu entrar como o dono.")


def preparar_demonstracao() -> None:
    email = os.environ.get("DEMO_ADMIN_EMAIL", "").strip()
    senha = os.environ.get("DEMO_ADMIN_SENHA", "")
    if asyncio.run(_ha_usuario()):
        _passo("a loja já tem usuário: nada a criar nem a semear")
        return
    if not (email and senha):
        _passo(
            "loja sem usuário e sem DEMO_ADMIN_EMAIL/DEMO_ADMIN_SENHA: ninguém criado "
            "(defina as duas e faça Redeploy, ou crie o dono pela CLI)"
        )
        return

    nome = os.environ.get("DEMO_ADMIN_NOME", "").strip() or "Dona Maria"
    if asyncio.run(_criar_dono(nome, email, senha)) != 0:
        raise SystemExit("Não deu para criar o dono da demonstração (veja a mensagem acima).")

    senha_vendedora = os.environ.get("DEMO_VENDEDORA_SENHA", "")
    vendedora = {
        "nome": "Ana Vendedora",
        "email": VENDEDORA_EMAIL,
        "senha": senha_vendedora or secrets.token_urlsafe(18),
        "papel": "VENDEDOR",
    }
    try:
        semear({"nome": nome, "email": email, "senha": senha}, vendedora)
    except BaseException:
        print(
            "\nA demonstração ficou pela METADE: o dono já existe, e o próximo build não semeia "
            "de novo. Para recomeçar, zere o banco (no painel do Neon, SQL Editor: "
            "DROP SCHEMA public CASCADE; CREATE SCHEMA public;) e faça Redeploy.",
            file=sys.stderr,
        )
        raise
    origem = (
        "a de DEMO_VENDEDORA_SENHA" if senha_vendedora else "sorteada; defina outra em Usuários"
    )
    _passo(f"demonstração semeada; dono: {email}; vendedora: {VENDEDORA_EMAIL} (senha {origem})")


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
