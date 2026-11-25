"""Comandos de manutenção.

O principal é `create-admin`: sem ele o sistema recém-instalado não tem por onde entrar,
já que criar usuário exige um admin autenticado.

    python -m app.cli create-admin --email dona@loja.com --senha "..." --nome "Dona Maria"

E os da demonstração que sobe com a loja (ADR-46), que só rodam no contêiner E no banco da
demonstração (`app/demonstracao.py`):

    python -m app.cli preparar-demonstracao   # semeia, ou confere a conta e o nome
    python -m app.cli renovar-demonstracao    # zera o banco da demo e semeia de novo

Saída: 0 feito; 2 recusado, sem tocar em nada (não é a demonstração); 1 falhou no meio.

E o diagnóstico do push do chamado do leitor (ADR-47) — "a notificação não chega no celular":

    python -m app.cli testar-push --email dona@loja.com   # 0: a Apple/o Google aceitaram
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

#: Como ligar o push quando ele está desligado — sem ele, o app nem pede a permissão.
_COMO_LIGAR = (
    "O app só pede a permissão de notificação (e manda o token) com NOTIFICACOES_PUSH=expo neste "
    "servidor: na instalação, no .env da raiz e recriando a api (./atualizar.sh, ou docker "
    "compose up -d api); na Vercel, a variável do projeto e um Redeploy. Depois, no iPhone, "
    'toque em "Abrir o leitor" (o sistema pergunta) e rode este teste de novo.'
)
#: O que fazer, pelo que a Expo, a Apple ou o Google responderam.
_O_QUE_FAZER = {
    "sem_credencial": (
        "Falta, ou foi revogada, a chave de push da Apple (APNs) do app na Expo. Quem publica o "
        "app cria a chave com `npx eas-cli credentials` (iOS > Push Notifications) e roda este "
        "teste de novo. Nada a mudar no servidor da loja."
    ),
    "token_morto": (
        "O celular não aceita mais avisos deste app (desinstalou, ou tirou a permissão em "
        'Ajustes). O token velho já saiu daqui: abra o app com este login e toque em "Abrir o '
        'leitor".'
    ),
    "erro": (
        "A Expo não entregou: o código acima diz por quê (lista em "
        "https://docs.expo.dev/push-notifications/sending-notifications/)."
    ),
    "sem_rede": (
        "O problema é a rede DESTE servidor, não a Expo nem a Apple: o aviso não chegou a "
        "https://exp.host, ou a resposta não veio em 4 s. Confira a internet da máquina (o DNS, "
        "um proxy, o firewall) e rode o teste de novo."
    ),
}


async def _testar_push(email: str, espera_s: float, intervalo_s: float = 5.0) -> int:
    """`testar-push` (ADR-47): manda um aviso de TESTE aos celulares de um login e espera o
    recibo da ENTREGA — o único lugar que diz se a Apple aceitou a chave de push de quem
    publica o app depois de a Expo ter aceitado o aviso (o chamado do leitor não espera por
    ele, e diria ENVIADA). Imprime o que fazer. Nunca imprime o token.

    Saída: 0 quando a Apple ou o Google aceitaram o aviso em algum celular; 1 nos outros casos.
    """
    from app.core.config import settings
    from app.modules.notificacoes.service import NotificacoesService

    ligado = settings.notificacoes_push == "expo"
    print(f"Push do chamado do leitor: NOTIFICACOES_PUSH={settings.notificacoes_push}.")
    if not ligado:
        print("  Desligado, o chamado chega só ao app ABERTO (a faixa). O teste manda mesmo assim.")
    async with SessionLocal() as session:
        usuario = await UsuarioService(session).repo.por_email(email)
        if usuario is None:
            print(f"Nenhum usuário com o e-mail {email}.")
            return 1
        servico = NotificacoesService(session)
        teste = await servico.mandar_teste(usuario.id)
        print(
            f"Login {email}: {teste.aparelhos} aparelho(s) com o app, "
            f"{len(teste.recibos)} com notificação."
        )
        if not teste.aparelhos:
            print(
                "Nenhum aparelho registrado: entre no app atualizado com este login, neste "
                "servidor, e rode o teste de novo."
            )
            return 1
        if not teste.recibos:
            print(
                _COMO_LIGAR
                if not ligado
                else "Nenhum celular deste login deu a permissão de notificação. No iPhone: "
                'toque em "Abrir o leitor" (o sistema pergunta); se já recusou, Ajustes > '
                "Notificações > o app. O Android ainda não recebe push nesta versão."
            )
            return 1

        aceitos = [r for r in teste.recibos if r.situacao == "ok" and r.id_na_expo]
        entregas: dict = {}
        if aceitos:
            print(f"A Expo aceitou. Esperando a Apple e o Google (até {espera_s:g} s)...")
            relogio = asyncio.get_running_loop()
            prazo = relogio.time() + espera_s
            while True:
                entregas.update(await servico.conferir_entregas(aceitos) or {})
                if all(r.id_na_expo in entregas for r in aceitos) or relogio.time() >= prazo:
                    break
                await asyncio.sleep(intervalo_s)

    situacoes: list[str] = []
    for n, r in enumerate(teste.recibos, start=1):
        rotulo = f"  aparelho {n} ({r.plataforma})"
        ios = r.plataforma == "ios"
        quem, a_quem = ("a Apple", "à Apple") if ios else ("o Google", "ao Google")
        if r.sem_resposta:
            # Rede caída, DNS, proxy, o teto de 4 s: nada veio da Expo. Dizer "a Expo recusou"
            # mandaria o dono atrás da chave da Apple quando o defeito é a rede da máquina.
            situacoes.append("sem_rede")
            print(f"{rotulo}: este servidor não conseguiu falar com a Expo ({r.motivo})")
        elif r.situacao != "ok":
            situacoes.append(r.situacao)
            print(f"{rotulo}: a Expo recusou o aviso ({r.motivo})")
        elif r.id_na_expo not in entregas:
            situacoes.append("sem_recibo")
            print(f"{rotulo}: a Expo aceitou; {quem} ainda não respondeu")
        elif entregas[r.id_na_expo].situacao == "ok":
            situacoes.append("ok")
            print(f"{rotulo}: entregue {a_quem}")
        else:
            entrega = entregas[r.id_na_expo]
            situacoes.append(entrega.situacao)
            print(f"{rotulo}: {quem} recusou ({entrega.motivo})")

    if "ok" in situacoes:
        print(
            "A notificação saiu deste servidor e foi aceita. Se não apareceu no celular: "
            "Ajustes > Notificações > o app (Permitir), e o Foco/Não Perturbe desligado."
        )
        return 0
    for situacao in ("sem_credencial", "token_morto", "erro", "sem_rede"):
        if situacao in situacoes:
            print(_O_QUE_FAZER[situacao])
            return 1
    print(
        "A Apple ainda não respondeu (sob carga, o recibo leva até 15 min). Se o aviso não "
        "aparecer no celular, rode o teste de novo daqui a pouco."
    )
    return 1


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

    p_push = sub.add_parser(
        "testar-push",
        help="Manda um aviso de teste aos celulares de um login e diz se a Apple ou o Google "
        "aceitaram — e, se não, o que fazer (ADR-47)",
    )
    p_push.add_argument("--email", required=True, help="O login dos celulares que recebem o teste")
    p_push.add_argument(
        "--espera",
        type=float,
        default=60.0,
        help="Segundos esperando a resposta da Apple/do Google (padrão: 60)",
    )

    args = parser.parse_args(argv)
    if args.comando in ("preparar-demonstracao", "renovar-demonstracao"):
        return _demonstracao(args.comando)
    if args.comando == "create-admin":
        return asyncio.run(_create_admin(args.nome, args.email, args.senha))
    if args.comando == "testar-push":
        return asyncio.run(_testar_push(args.email, args.espera))
    if args.comando == "configurar-loja":
        return asyncio.run(
            _configurar_loja(
                args.nome, args.segmento, args.documento, args.telefone, args.endereco
            )
        )
    return 1


if __name__ == "__main__":
    sys.exit(main())
