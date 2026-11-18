"""Instalação das dependências no build da Vercel: as MESMAS versões que a loja roda.

    vercel.json → "installCommand": "python scripts/vercel_instalar.py"

Sem isto a Vercel instalaria pelo `pyproject.toml` (ele ganha do requirements.txt, e o
uv resolve o `>=` de lá no DIA do build) — exatamente o que o requirements.lock existe para
impedir (ADR-34): a demonstração rodaria bibliotecas que nem o CI nem a loja testaram.
Aqui é o que o Dockerfile faz: `--no-deps` da trava, que já é o fecho inteiro.

Roda dentro do virtualenv que a Vercel cria para o build (o `python` do PATH é o dele), que
nasce sem pip: usa o `uv` se estiver no PATH; senão, o `ensurepip` da própria biblioteca
padrão. No fim confere versão por versão — o `vercel_build.py` confere de novo, e é ele que
reprova o deploy se a Vercel não tiver rodado este script.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
from collections.abc import Callable
from importlib import metadata
from pathlib import Path

PASTA_API = Path(__file__).resolve().parent.parent
TRAVA = PASTA_API / "requirements.lock"

_LINHA = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s;#]+)")


def ler_trava(caminho: Path = TRAVA) -> dict[str, str]:
    """`{nome: versão}` das linhas `pacote==versão` (comentários e `# via` ficam de fora)."""
    travadas: dict[str, str] = {}
    for linha in caminho.read_text(encoding="utf-8").splitlines():
        achou = _LINHA.match(linha)
        if achou:
            travadas[achou.group(1)] = achou.group(2)
    if not travadas:
        raise SystemExit(f"{caminho.name} sem nenhuma linha `pacote==versão`.")
    return travadas


def _instalada(nome: str) -> str | None:
    try:
        return metadata.version(nome)
    except metadata.PackageNotFoundError:
        return None


def divergencias(
    travadas: dict[str, str], instalada: Callable[[str], str | None] = _instalada
) -> list[str]:
    """O que está instalado diferente da trava (ou faltando), uma frase por pacote."""
    erradas = []
    for nome, versao in sorted(travadas.items()):
        achada = instalada(nome)
        if achada != versao:
            erradas.append(f"{nome}: trava {versao}, instalado {achada or 'nada'}")
    return erradas


def comando_de_instalacao(uv: str | None) -> list[list[str]]:
    """Os comandos, na ordem. Com `uv` no PATH ele instala no venv do build; sem ele, pip."""
    if uv:
        return [[uv, "pip", "install", "--python", sys.executable, "--no-deps", "-r", str(TRAVA)]]
    return [
        [sys.executable, "-m", "ensurepip", "--default-pip"],
        [
            sys.executable, "-m", "pip", "install", "--no-deps", "--no-input",
            "--disable-pip-version-check", "-r", str(TRAVA),
        ],
    ]


def main() -> int:
    travadas = ler_trava()
    print(f"Instalando {len(travadas)} pacotes do {TRAVA.name} (--no-deps)...", flush=True)
    for comando in comando_de_instalacao(shutil.which("uv")):
        subprocess.run(comando, check=True, cwd=PASTA_API)
    erradas = divergencias(travadas)
    if erradas:
        print("Instalado diferente da trava:\n  " + "\n  ".join(erradas), file=sys.stderr)
        return 1
    print(f"Conferido: as {len(travadas)} versões batem com o {TRAVA.name}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
