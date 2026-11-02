"""O diário de auditoria e a trava de força bruta.

A promessa: o dono — e só o dono — vê tudo que cada pessoa fez no login dela; e ninguém
testa senha à vontade. Estes testes guardam essas duas frases.
"""

import re
import uuid

import bcrypt
from conftest import criar_produto
from sqlalchemy import text

from app.core.db import SessionLocal
from app.main import app
from app.modules.auditoria.classificar import classificar


async def _peca(client, auth, nome, preco="50.00"):
    cat = (await client.post("/categorias", headers=auth, json={"nome": f"Cat {nome}"})).json()
    prod = await criar_produto(client, auth, {
                "categoria_id": cat["id"],
                "nome": nome,
                "variantes": [
                    {"tamanho": "U", "cor": "Unica", "preco_custo": "20.00",
                     "preco_venda": preco, "estoque_inicial": 10}
                ],
            })
    return prod["variantes"][0]["id"]


# ───────────────────────────────────────────────── quem pode ler o diário
async def test_so_o_dono_le_a_auditoria(
    client, auth_admin, auth_vendedor, auth_gerente, auth_supervisora
):
    """Nem o gerente. A auditoria existe para o dono conferir a equipe — gerente incluído."""
    assert (await client.get("/auditoria", headers=auth_admin)).status_code == 200
    for quem in (auth_gerente, auth_supervisora, auth_vendedor):
        assert (await client.get("/auditoria", headers=quem)).status_code == 403

    # E sem token nenhum: nem chega perto.
    assert (await client.get("/auditoria")).status_code == 401


# ───────────────────────────────────────────────── o que entra no diário
async def test_o_dono_ve_o_que_a_vendedora_fez(client, auth_admin, auth_vendedor, vendedor):
    variante = await _peca(client, auth_admin, "Peca Auditada")

    venda = await client.post(
        "/vendas",
        headers=auth_vendedor,
        json={
            "client_uuid": str(uuid.uuid4()),
            "itens": [{"variante_id": variante, "quantidade": 1}],
            "pagamentos": [{"forma": "DINHEIRO", "valor": "50.00"}],
        },
    )
    assert venda.status_code == 201

    diario = (await client.get("/auditoria", headers=auth_admin)).json()
    venda_da_ana = next(
        (e for e in diario["items"]
         if e["acao"] == "VENDA_CRIADA" and e["usuario"] == vendedor.name),
        None,
    )
    assert venda_da_ana is not None, diario["items"]
    assert venda_da_ana["papel"] == "VENDEDOR"
    assert venda_da_ana["descricao"] == "Registrou uma venda"
    # A entrada do login dela também está lá.
    assert any(e["acao"] == "LOGIN" and e["usuario"] == vendedor.name for e in diario["items"])


async def test_cancelamento_registra_quem_e_qual_venda(client, auth_admin):
    variante = await _peca(client, auth_admin, "Peca Cancelada")
    venda = (
        await client.post(
            "/vendas",
            headers=auth_admin,
            json={
                "client_uuid": str(uuid.uuid4()),
                "itens": [{"variante_id": variante, "quantidade": 1}],
                "pagamentos": [{"forma": "DINHEIRO", "valor": "50.00"}],
            },
        )
    ).json()
    await client.post(
        f"/vendas/{venda['id']}/cancelamento", headers=auth_admin, json={"motivo": "erro"}
    )

    diario = (await client.get("/auditoria?acao=VENDA_CANCELADA", headers=auth_admin)).json()
    assert diario["total"] >= 1
    linha = diario["items"][0]
    assert linha["descricao"] == f"Cancelou a venda #{venda['id']}"
    assert linha["entidade"] == "venda"
    assert linha["entidade_id"] == venda["id"]


async def test_diario_congela_o_nome_de_quem_agiu(client, auth_admin, session):
    """Renomear a pessoa depois NÃO reescreve o que ela fez — senão não é auditoria."""
    from sqlalchemy import select

    from app.modules.usuarios.models import User

    variante = await _peca(client, auth_admin, "Peca Congelada")
    await client.post(
        "/vendas",
        headers=auth_admin,
        json={
            "client_uuid": str(uuid.uuid4()),
            "itens": [{"variante_id": variante, "quantidade": 1}],
            "pagamentos": [{"forma": "DINHEIRO", "valor": "50.00"}],
        },
    )
    # Renomeia o admin no banco.
    admin = (await session.execute(select(User).where(User.role == "ADMIN"))).scalars().first()
    nome_antigo = admin.name
    admin.name = "Outro Nome Depois"
    await session.commit()

    diario = (await client.get("/auditoria?acao=VENDA_CRIADA", headers=auth_admin)).json()
    # A linha antiga mantém o nome de quando aconteceu.
    assert any(e["usuario"] == nome_antigo for e in diario["items"]), diario["items"]


async def test_falha_de_login_aparece_no_diario(client, auth_admin):
    await client.post("/auth/login", json={"email": "ana@loja.com", "senha": "errada"})
    diario = (await client.get("/auditoria?acao=LOGIN_FALHOU", headers=auth_admin)).json()
    assert diario["total"] >= 1
    # Sem conta com esse e-mail: nem papel, nem o e-mail por extenso (ver abaixo).
    assert diario["items"][0]["papel"] is None
    assert diario["items"][0]["usuario_id"] is None


async def test_falha_de_login_de_conta_real_grava_quem_e_nao_o_email(
    client, auth_admin, vendedor
):
    """LGPD (ADR-23): o e-mail digitado ia por extenso no nome e na frase, para sempre. Com
    conta, a linha leva o id e o nome congelado, como qualquer ato — o e-mail mora na conta
    e some com ela."""
    resp = await client.post("/auth/login", json={"email": vendedor.email, "senha": "errada"})
    assert resp.status_code == 401
    diario = (await client.get("/auditoria?acao=LOGIN_FALHOU", headers=auth_admin)).json()
    linha = diario["items"][0]
    assert linha["usuario_id"] == vendedor.id
    assert linha["usuario"] == vendedor.name
    assert linha["papel"] == "VENDEDOR"
    assert "errou a senha" in linha["descricao"]
    assert vendedor.email not in linha["descricao"]


async def test_falha_de_login_sem_conta_guarda_o_email_mascarado(client, auth_admin):
    """E-mail sem conta pode ser o de qualquer pessoa, errado por uma letra. Fica a máscara:
    dá para ver que as 40 tentativas foram do mesmo endereço, não para ler o endereço."""
    await client.post(
        "/auth/login", json={"email": "Fulana.de.Tal@gmail.com", "senha": "errada"}
    )
    diario = (await client.get("/auditoria?acao=LOGIN_FALHOU", headers=auth_admin)).json()
    linha = diario["items"][0]
    assert linha["usuario"] == "Fu***@g***.com"
    assert "fulana.de.tal" not in (linha["usuario"] + linha["descricao"]).lower()
    assert "Fu***@g***.com" in linha["descricao"]


async def test_retencao_apaga_o_diario_velho_no_login(client, admin, session):
    """Nada no diário fica para sempre: passou de RETENCAO_AUDITORIA_DIAS (730 por padrão),
    a faxina do login apaga. O recente fica."""
    from app.core.config import settings

    dias = settings.retencao_auditoria_dias
    assert dias == 730
    for idade, acao in ((dias + 30, "VELHA"), (dias - 30, "RECENTE")):
        await session.execute(
            text(
                "INSERT INTO audit_log (user_nome, acao, descricao, created_at) "
                "VALUES ('Alguém', :a, 'linha de teste', now() - make_interval(days => :d))"
            ).bindparams(a=acao, d=idade)
        )
    await session.commit()

    entrou = await client.post("/auth/login", json={"email": admin.email, "senha": "senha1234"})
    assert entrou.status_code == 200, entrou.text

    restam = {
        linha.acao
        for linha in (
            await session.execute(
                text("SELECT acao FROM audit_log WHERE acao IN ('VELHA', 'RECENTE')")
            )
        ).all()
    }
    assert restam == {"RECENTE"}


async def test_retencao_zero_guarda_tudo(client, admin, session, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "retencao_auditoria_dias", 0)
    await session.execute(
        text(
            "INSERT INTO audit_log (user_nome, acao, descricao, created_at) "
            "VALUES ('Alguém', 'ANTIGA', 'linha de teste', now() - interval '20 years')"
        )
    )
    await session.commit()
    await client.post("/auth/login", json={"email": admin.email, "senha": "senha1234"})
    assert await session.scalar(
        text("SELECT count(*) FROM audit_log WHERE acao = 'ANTIGA'")
    ) == 1


async def test_filtro_por_usuario(client, auth_admin, auth_vendedor, admin, vendedor):
    variante = await _peca(client, auth_admin, "Peca Filtro")
    await client.post(
        "/vendas", headers=auth_vendedor,
        json={"client_uuid": str(uuid.uuid4()),
              "itens": [{"variante_id": variante, "quantidade": 1}],
              "pagamentos": [{"forma": "DINHEIRO", "valor": "50.00"}]},
    )
    so_ana = (await client.get(f"/auditoria?usuario_id={vendedor.id}", headers=auth_admin)).json()
    assert so_ana["total"] >= 1
    assert all(e["usuario_id"] == vendedor.id for e in so_ana["items"])


async def test_diario_congela_o_papel_do_banco_nao_o_do_token(client, gerente, auth_admin):
    """Rebaixada de gerente a vendedora, o ato seguinte dela não sai no diário como GERENTE.

    O token dela ainda diz GERENTE (foi emitido antes, vale até 30 min); a autorização já
    usa o papel do banco, e o diário tem de dizer o mesmo que a autorização decidiu.
    """
    r = await client.post("/auth/login", json={"email": gerente.email, "senha": "senha1234"})
    token_antigo = {"Authorization": f"Bearer {r.json()['access_token']}"}

    r = await client.patch(
        f"/usuarios/{gerente.id}", headers=auth_admin, json={"papel": "VENDEDOR"}
    )
    assert r.status_code == 200
    # A autorização já a trata como vendedora: categoria exige EDITAR_CATALOGO.
    r = await client.post("/categorias", headers=token_antigo, json={"nome": "Blusas"})
    assert r.status_code == 403

    r = await client.patch(
        "/usuarios/me/senha",
        headers=token_antigo,
        json={"senha_atual": "senha1234", "nova_senha": "outra12345"},
    )
    assert r.status_code == 204

    async with SessionLocal() as s:
        papel = (
            await s.execute(text("SELECT user_papel FROM audit_log WHERE acao = 'SENHA_PROPRIA'"))
        ).scalar_one()
    assert papel == "VENDEDOR", f"diário gravou papel={papel!r} para quem já era VENDEDOR"


def test_toda_rota_de_mutacao_tem_frase_no_diario():
    """Rota de mutação sem linha em `classificar.py` vira 'OUTRO PATCH /...', que o dono não lê.

    Percorre as rotas de verdade da aplicação (pelo esquema OpenAPI, que é o inventário
    público delas): rota nova que muda algo e não ganhou frase — nem foi dada como ruído em
    `_IGNORAR` — quebra aqui, e não no diário de uma loja.
    """
    sem_frase = []
    for caminho, operacoes in app.openapi()["paths"].items():
        if not caminho.startswith("/api/v1"):
            continue
        amostra = re.sub(r"\{[^}]+\}", "1", caminho.removeprefix("/api/v1"))
        for metodo in operacoes:
            if metodo.upper() not in {"POST", "PUT", "PATCH", "DELETE"}:
                continue
            ato = classificar(metodo, amostra)
            if ato is not None and ato.acao == "OUTRO":
                sem_frase.append(f"{metodo.upper()} {caminho}")
    assert not sem_frase, f"mutações sem frase em classificar.py: {sem_frase}"


async def test_403_nao_entra_no_diario(client, auth_admin, auth_vendedor):
    """O diário é o que foi FEITO. Uma tentativa barrada (403) não é um ato consumado."""
    antes = (await client.get("/auditoria", headers=auth_admin)).json()["total"]
    # Vendedora tenta cancelar uma venda — 403.
    r = await client.post("/vendas/99999/cancelamento", headers=auth_vendedor, json={"motivo": "xxx"})
    assert r.status_code in (403, 404)
    depois = (await client.get("/auditoria", headers=auth_admin)).json()["total"]
    assert depois == antes, "um 403 não pode virar linha de auditoria"


# ───────────────────────────────────────────────── trava de força bruta
async def test_forca_bruta_trava_apos_muitos_erros(client):
    email = f"brutus-{uuid.uuid4().hex[:6]}@x.com"
    # As primeiras tentativas erradas passam (401); em algum ponto vem o 429.
    codigos = []
    for i in range(14):
        r = await client.post("/auth/login", json={"email": email, "senha": f"errada{i}"})
        codigos.append(r.status_code)
        if r.status_code == 429:
            assert "Retry-After" in r.headers
            assert int(r.headers["Retry-After"]) > 0
            break
    assert 429 in codigos, f"nunca travou: {codigos}"
    assert codigos.count(401) >= 10, "travou cedo demais (dedo gordo no balcão travaria)"


async def test_trava_nao_revela_se_o_email_existe(client, admin):
    """A resposta de e-mail real e de e-mail falso é a mesma — antes e durante a trava."""
    real = await client.post("/auth/login", json={"email": admin.email, "senha": "xxx"})
    falso = await client.post("/auth/login", json={"email": "naoexiste@x.com", "senha": "xxx"})
    assert real.status_code == falso.status_code == 401
    assert real.json()["code"] == falso.json()["code"] == "CREDENCIAIS_INVALIDAS"


async def test_email_inventado_paga_o_mesmo_bcrypt_que_senha_errada(client, admin, monkeypatch):
    """A mensagem igual não basta: o TEMPO também não pode dizer se o e-mail existe (ADR-24).

    Antes, e-mail inventado respondia em 10 ms (nem chegava ao bcrypt) e senha errada em
    300 ms — cronometrar o login listava a equipe. Aqui, sem relógio: conta quantas
    conferências bcrypt cada caso faz, e com que custo.
    """
    conferidos: list[bytes] = []
    original = bcrypt.checkpw

    def espiao(senha: bytes, hash_: bytes) -> bool:
        conferidos.append(hash_)
        return original(senha, hash_)

    monkeypatch.setattr(bcrypt, "checkpw", espiao)

    falso = await client.post(
        "/auth/login", json={"email": "ninguem@loja.com", "senha": "errada123"}
    )
    real = await client.post("/auth/login", json={"email": admin.email, "senha": "errada123"})
    assert falso.status_code == real.status_code == 401

    assert len(conferidos) == 2, (
        f"{len(conferidos)} conferências para 2 logins: o e-mail inventado respondeu sem bcrypt"
    )

    def custo(h: bytes) -> bytes:
        return h.split(b"$")[2]  # $2b$<custo>$...

    assert custo(conferidos[0]) == custo(conferidos[1]), "custo diferente = tempo diferente"


async def test_login_certo_funciona_normalmente(client, admin):
    """A trava não pode atrapalhar quem acerta a senha na primeira."""
    r = await client.post("/auth/login", json={"email": admin.email, "senha": "senha1234"})
    assert r.status_code == 200
    assert "access_token" in r.json()
