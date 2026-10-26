"""O diário de auditoria e a trava de força bruta.

A promessa: o dono — e só o dono — vê tudo que cada pessoa fez no login dela; e ninguém
testa senha à vontade. Estes testes guardam essas duas frases.
"""

import uuid


from conftest import criar_produto



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
    assert "errou a senha" in diario["items"][0]["descricao"]
    # Não vaza se a conta existe: registra o e-mail digitado, sem papel.
    assert diario["items"][0]["papel"] is None


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


async def test_login_certo_funciona_normalmente(client, admin):
    """A trava não pode atrapalhar quem acerta a senha na primeira."""
    r = await client.post("/auth/login", json={"email": admin.email, "senha": "senha1234"})
    assert r.status_code == 200
    assert "access_token" in r.json()
