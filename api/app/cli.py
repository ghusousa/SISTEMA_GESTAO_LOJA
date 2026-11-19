"""Comandos de manutenção.

O principal é `create-admin`: sem ele o sistema recém-instalado não tem por onde entrar,
já que criar usuário exige um admin autenticado.

    python -m app.cli create-admin --email dona@loja.com --senha "..." --nome "Dona Maria"

E os da demonstração que sobe com a loja (ADR-46), que só rodam no contêiner E no banco da
demonstração (`app/demonstracao.py`):

    python -m app.cli preparar-demonstracao   # semeia, ou confere a conta e o nome
    python -m app.cli renovar-demonstracao    # zera o banco da demo e semeia de novo

Saída: 0 feito; 2 recusado, sem tocar em nada (não é a demonstração); 1 falhou no meio.
"""

import argparse
import asyncio
import sys
import traceback

from app.core.db import SessionLocal
from app.core.exceptions import AppError
from app.core.segmentos import Segmento, vocabulario
from app.modules.configuracao.schemas import ConfiguracaoUpdate
from app.modules.configuracao.service import ConfiguracaoService
from app.modules.usuarios.models import Papel, User
from app.modules.usuarios.schemas import UsuarioCreate
from app.modules.usuarios.service import UsuarioService


async def _create_admin(nome: str, email: str, senha: str) -> int:
    async with SessionLocal() as session:
        service = UsuarioService(session)
        existente = await service.repo.por_email(email)
        if existente is not None:
            if existente.role == Papel.ADMIN and existente.is_active:
                print(f"Já existe um admin ativo com o e-mail {email}. Nada a fazer.")
                return 0
            print(f"Já existe um usuário com o e-mail {email} (papel {existente.role}).")
            return 1
        try:
            # O CLI é a porta de fora do sistema: roda no servidor, com acesso ao
            # banco, e é dele que sai o primeiro dono — quando ainda não existe ninguém
            # para ser o "ator". Por isso ele cria o próprio ator de mentira, com papel
            # de dono, em vez de afrouxar a regra em `_barrar_escalada`.
            fundador = User(name=nome, email=email, role=Papel.ADMIN)
            user = await service.criar(
                UsuarioCreate(nome=nome, email=email, senha=senha, papel=Papel.ADMIN),
                fundador,
            )
        except AppError as exc:
            print(f"Erro: {exc.message}")
            return 1
        print(f"Admin criado: #{user.id} {user.name} <{user.email}>")
        return 0


async def _configurar_loja(
    nome: str,
    segmento: str,
    documento: str | None,
    telefone: str | None,
    endereco: str | None,
) -> int:
    """Grava a identidade da loja. Chamado pelo instalador, e de novo por quem quiser
    corrigir pelo terminal — mas o caminho normal é a tela de Configuração."""
    try:
        ramo = Segmento(segmento.upper())
    except ValueError:
        conhecidos = ", ".join(s.value for s in Segmento)
        print(f"Segmento desconhecido: {segmento}. Use um destes: {conhecidos}")
        return 1

    async with SessionLocal() as session:
        config = await ConfiguracaoService(session).atualizar(
            ConfiguracaoUpdate(
                nome=nome,
                segmento=ramo,
                documento=documento,
                telefone=telefone,
                endereco=endereco,
            )
        )
    v = vocabulario(config.segmento)
    print(f"Loja configurada: {config.nome} ({v.rotulo})")
    print(f"  O que se vende chama-se '{v.item}'; varia por {v.eixo1} e {v.eixo2}.")
    return 0


#: Recusado sem tocar em nada: esta API ou este banco não são os da demonstração.
SAIDA_RECUSADO = 2


def _demonstracao(comando: str) -> int:
    """`preparar-demonstracao` e `renovar-demonstracao` (ADR-46).

    Roda no `docker/entrada.sh` a cada subida da demo e no timer da renovação: a saída vai
    para o log do Docker, que guarda 30 MB. Por isso nada de senha nem de URL do banco —
    as frases do preparo não levam nenhuma das duas, e o que cai sai pelo `sem_segredos`.
    """
    from app import demonstracao

    try:
        motivo = demonstracao.motivo_para_recusar()
        if motivo:
            print(motivo, file=sys.stderr)
            return SAIDA_RECUSADO
        if comando == "renovar-demonstracao":
            demonstracao.renovar_demonstracao()
        else:
            demonstracao.preparar_demonstracao(demonstracao.Origem.INSTALACAO)
    except SystemExit as parou:
        # As paradas do preparo já dizem o que houve e o que fazer, sem segredo.
        if parou.code in (None, 0):
            return 0
        if isinstance(parou.code, str):
            print(parou.code, file=sys.stderr)
        return 1
    except BaseException as exc:  # noqa: BLE001 — dizer o que caiu, sem segredo
        traceback.print_tb(exc.__traceback__)
        print(demonstracao.sem_segredos(exc), file=sys.stderr)
        return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="app.cli")
    sub = parser.add_subparsers(dest="comando", required=True)

    p_admin = sub.add_parser("create-admin", help="Cria o primeiro administrador")
    p_admin.add_argument("--nome", required=True)
    p_admin.add_argument("--email", required=True)
    p_admin.add_argument("--senha", required=True, help="Mínimo 8 caracteres")

    p_loja = sub.add_parser("configurar-loja", help="Define o nome e o ramo da loja")
    p_loja.add_argument("--nome", required=True, help='Ex.: "Boutique da Ana"')
    p_loja.add_argument(
        "--segmento",
        default=Segmento.OUTRO.value,
        choices=[s.value for s in Segmento],
        help="O ramo da loja: muda as palavras das telas (Tamanho/Cor, Aplicação/Posição...)",
    )
    p_loja.add_argument("--documento", default=None, help="CNPJ ou CPF, sai no recibo")
    p_loja.add_argument("--telefone", default=None)
    p_loja.add_argument("--endereco", default=None)

    sub.add_parser(
        "preparar-demonstracao",
        help="Semeia a demonstração (ou confere a conta das notas e o nome da loja); só no "
        "contêiner e no banco da demonstração (ADR-46)",
    )
    sub.add_parser(
        "renovar-demonstracao",
        help="Zera o banco da demonstração e semeia de novo, com as datas de hoje (ADR-46)",
    )

    args = parser.parse_args(argv)
    if args.comando in ("preparar-demonstracao", "renovar-demonstracao"):
        return _demonstracao(args.comando)
    if args.comando == "create-admin":
        return asyncio.run(_create_admin(args.nome, args.email, args.senha))
    if args.comando == "configurar-loja":
        return asyncio.run(
            _configurar_loja(
                args.nome, args.segmento, args.documento, args.telefone, args.endereco
            )
        )
    return 1


if __name__ == "__main__":
    sys.exit(main())
