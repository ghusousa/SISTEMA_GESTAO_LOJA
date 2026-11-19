"""O que o `docker-compose.yml` interpola nos serviços da demonstração (ADR-46).

A lista de ambiente da `api-demo` é escrita à mão (nada da loja vaza para ela): variável que
não está nela não chega, ponha-se o que for no .env. E nos serviços da demo só vale `${X:-}`
ou `${X:-padrão}`: `${X:?}` num serviço de profile desligado quebra a interpolação do arquivo
inteiro, e com ela todo `docker compose` da loja (backup, vigia, atualizar). Quem confere com
o Compose de verdade é `testes/pilha/pilha.sh`.
"""
import re

import yaml

from app.core.config import PASTA_API, Settings

COMPOSE = yaml.safe_load((PASTA_API.parent / "docker-compose.yml").read_text(encoding="utf-8"))


def _textos(valor: object):
    if isinstance(valor, dict):
        for chave, item in valor.items():
            yield str(chave)
            yield from _textos(item)
    elif isinstance(valor, list):
        for item in valor:
            yield from _textos(item)
    elif isinstance(valor, str):
        yield valor


def test_os_servicos_da_demo_so_interpolam_com_padrao() -> None:
    da_demo = sorted(nome for nome, servico in COMPOSE["services"].items()
                     if "demo" in servico.get("profiles", []))
    assert da_demo == ["api-demo", "demo-banco"]
    for nome in da_demo:
        for texto in _textos(COMPOSE["services"][nome]):
            for variavel in re.findall(r"(?<!\$)\$\{([^}]*)\}", texto):
                assert re.fullmatch(r"[A-Z][A-Z0-9_]*:-.*", variavel), (nome, variavel)


def test_a_api_demo_recebe_o_teto_das_fotos_com_o_padrao_do_codigo() -> None:
    """O teto da pasta de fotos da demo (`FotosDaDemonstracao`) se ajusta pelo .env — e, sem
    ele ou com ele vazio, fica o padrão do código: vazio direto derrubaria a api-demo, porque o
    campo é um inteiro maior que zero."""
    padrao = Settings.model_fields["demo_fotos_max_bytes"].default
    assert padrao == 200 * 1024 * 1024
    ambiente = COMPOSE["services"]["api-demo"]["environment"]
    assert ambiente["DEMO_FOTOS_MAX_BYTES"] == f"${{DEMO_FOTOS_MAX_BYTES:-{padrao}}}"


def test_o_push_do_leitor_nasce_desligado_na_loja_e_na_demo() -> None:
    """O push do chamado do leitor (ADR-47) só funciona depois do passo único de quem publica o
    app: nasce desligado nas duas APIs, e cada uma liga pela própria variável. Vazio no .env
    vira o padrão — sem ele, `${X:-}` derrubaria a API, que só aceita "expo" ou "desligado"."""
    assert Settings.model_fields["notificacoes_push"].default == "desligado"
    servicos = COMPOSE["services"]
    assert servicos["api"]["environment"]["NOTIFICACOES_PUSH"] == (
        "${NOTIFICACOES_PUSH:-desligado}"
    )
    assert servicos["api-demo"]["environment"]["NOTIFICACOES_PUSH"] == (
        "${DEMO_NOTIFICACOES_PUSH:-desligado}"
    )
