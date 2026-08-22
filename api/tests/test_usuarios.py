from httpx import AsyncClient

from app.modules.usuarios.models import User


async def test_vendedor_nao_pode_listar_usuarios(
    client: AsyncClient, auth_vendedor: dict[str, str]
) -> None:
    resp = await client.get("/usuarios", headers=auth_vendedor)
    assert resp.status_code == 403
    assert resp.json()["code"] == "SEM_PERMISSAO"


async def test_admin_cria_vendedor(client: AsyncClient, auth_admin: dict[str, str]) -> None:
    resp = await client.post(
        "/usuarios",
        headers=auth_admin,
        json={
            "nome": "Ana Vendedora",
            "email": "ana@loja.com",
            "senha": "segredo123",
            "papel": "VENDEDOR",
        },
    )
    assert resp.status_code == 201
    corpo = resp.json()
    assert corpo["papel"] == "VENDEDOR"
    assert corpo["ativo"] is True

    login = await client.post("/auth/login", json={"email": "ana@loja.com", "senha": "segredo123"})
    assert login.status_code == 200


async def test_email_duplicado_retorna_409(
    client: AsyncClient, auth_admin: dict[str, str], admin: User
) -> None:
    resp = await client.post(
        "/usuarios",
        headers=auth_admin,
        json={"nome": "Outra", "email": admin.email, "senha": "segredo123"},
    )
    assert resp.status_code == 409
    assert resp.json()["code"] == "DUPLICADO"


async def test_senha_curta_e_recusada(client: AsyncClient, auth_admin: dict[str, str]) -> None:
    resp = await client.post(
        "/usuarios",
        headers=auth_admin,
        json={"nome": "Curta", "email": "curta@loja.com", "senha": "1234"},
    )
    assert resp.status_code == 422
    assert resp.json()["code"] == "VALIDACAO"


async def test_nao_permite_desativar_o_ultimo_admin(
    client: AsyncClient, auth_admin: dict[str, str], admin: User
) -> None:
    resp = await client.patch(
        f"/usuarios/{admin.id}", headers=auth_admin, json={"ativo": False}
    )
    assert resp.status_code == 409
    assert resp.json()["code"] == "OPERACAO_INVALIDA"


async def test_permite_desativar_admin_quando_ha_outro(
    client: AsyncClient, auth_admin: dict[str, str], admin: User
) -> None:
    await client.post(
        "/usuarios",
        headers=auth_admin,
        json={
            "nome": "Segundo Admin",
            "email": "admin2@loja.com",
            "senha": "segredo123",
            "papel": "ADMIN",
        },
    )
    resp = await client.patch(
        f"/usuarios/{admin.id}", headers=auth_admin, json={"ativo": False}
    )
    assert resp.status_code == 200
    assert resp.json()["ativo"] is False


async def test_troca_da_propria_senha_exige_senha_atual(
    client: AsyncClient, auth_vendedor: dict[str, str], vendedor: User
) -> None:
    errada = await client.patch(
        "/usuarios/me/senha",
        headers=auth_vendedor,
        json={"senha_atual": "naoehessa", "nova_senha": "novasenha123"},
    )
    assert errada.status_code == 422

    certa = await client.patch(
        "/usuarios/me/senha",
        headers=auth_vendedor,
        json={"senha_atual": "senha1234", "nova_senha": "novasenha123"},
    )
    assert certa.status_code == 204

    login = await client.post(
        "/auth/login", json={"email": vendedor.email, "senha": "novasenha123"}
    )
    assert login.status_code == 200


async def test_admin_redefine_senha_de_outro_usuario(
    client: AsyncClient, auth_admin: dict[str, str], vendedor: User
) -> None:
    resp = await client.patch(
        f"/usuarios/{vendedor.id}/senha",
        headers=auth_admin,
        json={"nova_senha": "resetada123"},
    )
    assert resp.status_code == 204
    login = await client.post(
        "/auth/login", json={"email": vendedor.email, "senha": "resetada123"}
    )
    assert login.status_code == 200


async def test_listagem_pagina_e_filtra(
    client: AsyncClient, auth_admin: dict[str, str], vendedor: User
) -> None:
    resp = await client.get("/usuarios", headers=auth_admin, params={"papel": "VENDEDOR"})
    assert resp.status_code == 200
    corpo = resp.json()
    assert corpo["total"] == 1
    assert corpo["page"] == 1
    assert corpo["items"][0]["email"] == vendedor.email
