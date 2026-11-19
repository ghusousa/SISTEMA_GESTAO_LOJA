"""Teto do corpo do pedido no proxy (ADR-25 e ADR-46): o Caddyfile e quem o confere.

As rotas de JSON leem o corpo inteiro ANTES de conferir o login; a da foto confere o login antes,
mas o arquivo de quem entrou vai inteiro a um temporário antes de a API medir. E o teto do Caddy
vale por pedido: N conexões abertas seguram N vezes ele. Por isso o teto é POR ROTA — 6 MB no
envio da foto, 2 MB em todo o resto, que é JSON. Sem proxy no ar, o pentest
(`api/scripts/pentest.py`) confere o `docker/caddy/Caddyfile`, e tem de lê-lo como o Caddy lê:
comentário não conta, `request_body` aninhado num `handle /demo/*` não cobre a loja, e o tamanho
vem nas unidades do go-humanize (decimal, k/ki, com ou sem "b"). Quem prova o Caddy de verdade é
`testes/pilha/pilha.sh`.
"""
import ast
import re

import pytest

from app.core.config import PASTA_API

CADDYFILE = (PASTA_API.parent / "docker" / "caddy" / "Caddyfile").read_text(encoding="utf-8")
PENTEST = PASTA_API / "scripts" / "pentest.py"

#: O conferidor do pentest: funções puras e as constantes de que elas precisam.
_DO_CONFERIDOR = {
    "TETO_DO_CORPO", "TETO_DA_FOTO", "_AMOSTRAS_DE_JSON", "_AMOSTRAS_DE_FOTO", "_UNIDADES",
    "_bytes_do_caddy", "_tokens_do_caddyfile", "_declaracoes", "_casa_caminho", "_casa",
    "_tetos_no_caddyfile", "_conferir_tetos_no_caddyfile",
}


def _nome(no: ast.stmt) -> str | None:
    if isinstance(no, ast.FunctionDef):
        return no.name
    if isinstance(no, ast.Assign) and len(no.targets) == 1 and isinstance(no.targets[0], ast.Name):
        return no.targets[0].id
    return None


@pytest.fixture(scope="module")
def pentest() -> dict:
    """Só as definições do conferidor, tiradas da árvore do pentest: importá-lo rodaria o
    ataque inteiro contra uma API no ar."""
    arvore = ast.parse(PENTEST.read_text(encoding="utf-8"))
    pedacos = [no for no in arvore.body if _nome(no) in _DO_CONFERIDOR]
    assert {_nome(no) for no in pedacos} == _DO_CONFERIDOR
    espaco: dict = {"re": re}
    exec(compile(ast.Module(body=pedacos, type_ignores=[]), str(PENTEST), "exec"), espaco)
    return espaco


def _tetos(pentest: dict, texto: str) -> dict:
    amostras = pentest["_AMOSTRAS_DE_JSON"] + pentest["_AMOSTRAS_DE_FOTO"]
    return pentest["_tetos_no_caddyfile"](texto, amostras)


def _seguros(pentest: dict, texto: str) -> list[bool]:
    """[todo pedido sem arquivo, envio da foto]: cada teto seguro?"""
    return [seguro for seguro, _, _ in pentest["_conferir_tetos_no_caddyfile"](texto)]


# ------------------------------------------------------------ o Caddyfile do repositório


def test_o_caddyfile_tem_teto_por_rota_na_loja_e_na_demo(pentest: dict) -> None:
    tetos = _tetos(pentest, CADDYFILE)
    for amostra in pentest["_AMOSTRAS_DE_JSON"]:
        assert tetos[amostra] == 2_000_000, amostra
    for amostra in pentest["_AMOSTRAS_DE_FOTO"]:
        assert tetos[amostra] == 6_000_000, amostra
    assert _seguros(pentest, CADDYFILE) == [True, True]


def test_o_corpo_grande_na_demo_nunca_vira_a_frase_de_fora_do_ar() -> None:
    """No Caddy 2.6, o corpo acima do teto (com Content-Length) sai 502 — e os matchers de
    502 a 504 da demo o diriam "desligada ou começando". Todo matcher que leva à frase exclui
    o erro de corpo grande pela mensagem, que é a mesma em todas as versões."""
    expressoes = re.findall(r"expression `([^`]*)`", CADDYFILE[CADDYFILE.index("handle_errors {"):])
    assert len(expressoes) == 2  # /demo/api/* (o JSON) e o resto de /demo (a página)
    for expressao in expressoes:
        assert '!{err.message}.contains("request body too large")' in expressao


# ------------------------------------------------------------ o conferidor do pentest

TETO_UNICO_DE_ANTES = """\
:80 {
	request_body {
		max_size 10MB
	}
	handle /demo/* {
		reverse_proxy api-demo:8000
	}
	handle {
		reverse_proxy api:8000
	}
}
"""

COMENTADO = """\
{$ENDERECO} {
	# request_body {
	#	max_size 1MB
	# }
	reverse_proxy api:8000
}
"""

SEM_MAX_SIZE_DE_VERDADE = """\
:80 {
	request_body {
		# max_size 1MB
	}
	reverse_proxy api:8000
}
"""

SO_NA_DEMO = """\
:80 {
	handle /demo/* {
		request_body {
			max_size 1MB
		}
		reverse_proxy api-demo:8000
	}
	handle {
		reverse_proxy api:8000
	}
}
"""

DEZ_MI = """\
:80 {
	request_body {
		max_size 10Mi
	}
	reverse_proxy api:8000
}
"""

SO_A_FOTO = """\
:80 {
	@foto {
		method PUT
		path_regexp ^(/demo)?/api/v1/produtos/[0-9]+/foto$
	}
	request_body @foto {
		max_size 6MB
	}
	reverse_proxy api:8000
}
"""

SO_A_API_DA_LOJA = """\
:80 {
	request_body /api/* {
		max_size 1MB
	}
	reverse_proxy api:8000
}
"""

MATCHER_QUE_NAO_DA_PARA_AVALIAR = """\
:80 {
	@com_cabecalho header X-Qualquer sim
	request_body @com_cabecalho {
		max_size 1MB
	}
	reverse_proxy api:8000
}
"""

ZERO_E_SEM_TETO = """\
:80 {
	request_body {
		max_size 0
	}
	reverse_proxy api:8000
}
"""


@pytest.mark.parametrize(
    ("caddyfile", "teto_do_login", "seguros"),
    [
        pytest.param(TETO_UNICO_DE_ANTES, 10_000_000, [False, False], id="10MB-em-tudo"),
        pytest.param(COMENTADO, None, [False, False], id="comentado"),
        pytest.param(SEM_MAX_SIZE_DE_VERDADE, None, [False, False], id="max_size-comentado"),
        pytest.param(SO_NA_DEMO, None, [False, False], id="aninhado-em-handle-demo"),
        pytest.param(DEZ_MI, 10_485_760, [False, False], id="10Mi"),
        pytest.param(SO_A_FOTO, None, [False, True], id="so-a-foto"),
        pytest.param(SO_A_API_DA_LOJA, 1_000_000, [False, False], id="matcher-so-da-loja"),
        pytest.param(MATCHER_QUE_NAO_DA_PARA_AVALIAR, None, [False, False], id="matcher-header"),
        pytest.param(ZERO_E_SEM_TETO, None, [False, False], id="max_size-0"),
    ],
)
def test_o_conferidor_acha_o_furo(
    pentest: dict, caddyfile: str, teto_do_login: int | None, seguros: list[bool]
) -> None:
    assert _tetos(pentest, caddyfile)[("POST", "/api/v1/auth/login")] == teto_do_login
    assert _seguros(pentest, caddyfile) == seguros


def test_teto_aninhado_so_na_demo_nao_cobre_nem_a_demo_pelo_primeiro_nivel(pentest: dict) -> None:
    """A regra é o primeiro nível do site: aninhado, nem a loja nem a demo contam como cobertas
    — o conferidor não adivinha o que um `handle` deixa passar."""
    tetos = _tetos(pentest, SO_NA_DEMO)
    assert tetos[("POST", "/demo/api/v1/auth/login")] is None
    assert tetos[("PUT", "/api/v1/produtos/1/foto")] is None


def test_a_foto_acima_do_teto_dela_e_achado_e_o_resto_nao(pentest: dict) -> None:
    caddyfile = CADDYFILE.replace("max_size 6MB", "max_size 50MB")
    assert _tetos(pentest, caddyfile)[("PUT", "/demo/api/v1/produtos/1/foto")] == 50_000_000
    assert _seguros(pentest, caddyfile) == [True, False]


DECIMAL = """\
{
	admin off
}

:80 {
	respond "# isto não é comentário" 200
	header X-Marca valor#tambem-nao
	request_body {
		max_size 1.5MB
	}
	reverse_proxy api:8000
}
"""

ENTRE_ASPAS = """\
:80 {
	request_body {
		max_size "2 MB"
	}
	reverse_proxy api:8000
}
"""

SEM_CHAVES = """\
:80
request_body {
	max_size 2MB
}
reverse_proxy api:8000
"""

EMPILHADOS = """\
:80 {
	@foto {
		method PUT
		path_regexp ^(/demo)?/api/v1/produtos/[0-9]+/foto$
	}
	request_body {
		max_size 2MB
	}
	request_body @foto {
		max_size 6MB
	}
	reverse_proxy api:8000
}
"""


@pytest.mark.parametrize(
    ("caddyfile", "teto_do_login", "teto_da_foto"),
    [
        pytest.param(DECIMAL, 1_500_000, 1_500_000, id="1.5MB-e-cerquilha-que-nao-comenta"),
        pytest.param(ENTRE_ASPAS, 2_000_000, 2_000_000, id="entre-aspas"),
        pytest.param(SEM_CHAVES, 2_000_000, 2_000_000, id="site-sem-chaves"),
        # Dois request_body no mesmo pedido se empilham: vale o MENOR (a foto fica com 2 MB).
        pytest.param(EMPILHADOS, 2_000_000, 2_000_000, id="empilhados-vale-o-menor"),
    ],
)
def test_o_conferidor_le_como_o_caddy(
    pentest: dict, caddyfile: str, teto_do_login: int, teto_da_foto: int
) -> None:
    tetos = _tetos(pentest, caddyfile)
    assert tetos[("POST", "/api/v1/auth/login")] == teto_do_login
    assert tetos[("PUT", "/demo/api/v1/produtos/1/foto")] == teto_da_foto
    assert _seguros(pentest, caddyfile) == [True, True]


@pytest.mark.parametrize(
    ("valor", "em_bytes"),
    [
        ("2MB", 2_000_000), ("2mb", 2_000_000), ("2M", 2_000_000), ("2 MB", 2_000_000),
        ("2Mi", 2_097_152), ("2MiB", 2_097_152), ("2mib", 2_097_152), ("512KiB", 524_288),
        ("1.5MB", 1_500_000), ("1,000kb", 1_000_000), ("6MB", 6_000_000), ("10Mi", 10_485_760),
        ("1GB", 1_000_000_000), ("1Gi", 1_073_741_824), ("10", 10), ("10B", 10), ("0", 0),
        ("dez", None), ("10XB", None), ("1.2.3MB", None), ("MB", None), ("", None),
    ],
)
def test_unidades_do_go_humanize(pentest: dict, valor: str, em_bytes: int | None) -> None:
    assert pentest["_bytes_do_caddy"](valor) == em_bytes
