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

O preparo em si mora em `app/demonstracao.py` (ADR-46): é o MESMO da demonstração que sobe com
a loja em `/demo`, chamado aqui com a origem Vercel — o autor dos marcos, as frases e o
comportamento de sempre. Este script fica com o que é só da Vercel: a trava, a cópia do web, a
recusa fora dela e a migração.
"""

from __future__ import annotations

import os
import shutil
import sys
import traceback
from collections.abc import Mapping
from pathlib import Path

PASTA_API = Path(__file__).resolve().parent.parent
PASTA_SCRIPTS = Path(__file__).resolve().parent
# Rodando como script, o Python põe scripts/ no path — e não a raiz da API, onde `app` vive.
sys.path.insert(0, str(PASTA_API))
sys.path.insert(0, str(PASTA_SCRIPTS))

# Nada da config aqui em cima: lê-la tem de cair DENTRO do `main()`, onde `_sem_segredos` tira
# a URL do banco da mensagem. `app.demonstracao` não a lê ao ser importado (os `app.*` dele são
# importados só quando cada passo roda).
import vercel_instalar  # noqa: E402

from app import demonstracao  # noqa: E402
from app.demonstracao import Estado, Origem, decidir_estado  # noqa: E402, F401 — os testes leem
from app.demonstracao import sem_segredos as _sem_segredos  # noqa: E402


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


def contas_da_demonstracao(
    ambiente: Mapping[str, str],
) -> tuple[dict[str, str], dict[str, str]] | None:
    """O dono e a vendedora, validados ANTES de tocar no banco (`app/demonstracao.py`), com as
    frases da Vercel: variável inválida se corrige no painel e com Redeploy."""
    return demonstracao.contas_da_demonstracao(ambiente, Origem.VERCEL)


def preparar_demonstracao() -> None:
    """A carga (ou a conferência do dono) da demonstração da Vercel — o preparo compartilhado
    com a demonstração que sobe com a loja, na origem Vercel."""
    demonstracao.preparar_demonstracao(Origem.VERCEL)


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


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except BaseException as exc:  # noqa: BLE001 — o build tem de dizer o que caiu, sem segredo
        traceback.print_tb(exc.__traceback__)
        print(_sem_segredos(exc), file=sys.stderr)
        sys.exit(1)
