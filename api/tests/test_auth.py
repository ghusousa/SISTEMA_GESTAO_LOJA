from httpx import AsyncClient

from app.modules.usuarios.models import User


async def test_login_com_credenciais_validas_devolve_par_de_tokens(
    client: AsyncClient, admin: User
) -> None:
    resp = await client.post(
        "/auth/login", json={"email": admin.email, "senha": "senha1234"}
    )
    assert resp.status_code == 200
    corpo = resp.json()
    assert corpo["access_token"] and corpo["refresh_token"]
    assert corpo["usuario"]["papel"] == "ADMIN"
    assert corpo["usuario"]["email"] == admin.email
    assert "password_hash" not in corpo["usuario"]


async def test_login_com_senha_errada_retorna_401(client: AsyncClient, admin: User) -> None:
    resp = await client.post("/auth/login", json={"email": admin.email, "senha": "errada12"})
    assert resp.status_code == 401
    assert resp.json()["code"] == "CREDENCIAIS_INVALIDAS"


async def test_login_de_usuario_desativado_e_recusado(
    client: AsyncClient, session, admin: User
) -> None:
    admin.is_active = False
    await session.commit()
    resp = await client.post("/auth/login", json={"email": admin.email, "senha": "senha1234"})
    assert resp.status_code == 401


async def test_refresh_rotaciona_e_invalida_o_token_anterior(
    client: AsyncClient, admin: User
) -> None:
    login = (
        await client.post("/auth/login", json={"email": admin.email, "senha": "senha1234"})
    ).json()
    primeiro_refresh = login["refresh_token"]

    novo = await client.post("/auth/refresh", json={"refresh_token": primeiro_refresh})
    assert novo.status_code == 200
    assert novo.json()["refresh_token"] != primeiro_refresh

    reuso = await client.post("/auth/refresh", json={"refresh_token": primeiro_refresh})
    assert reuso.status_code == 401
    assert reuso.json()["code"] == "TOKEN_INVALIDO"


async def test_reuso_de_refresh_derruba_a_familia_inteira(
    client: AsyncClient, admin: User
) -> None:
    """Token rotacionado reaparecendo é assinatura de cópia roubada: tudo cai."""
    login = (
        await client.post("/auth/login", json={"email": admin.email, "senha": "senha1234"})
    ).json()
    antigo = login["refresh_token"]
    atual = (
        await client.post("/auth/refresh", json={"refresh_token": antigo})
    ).json()["refresh_token"]

    await client.post("/auth/refresh", json={"refresh_token": antigo})  # dispara o alarme

    resp = await client.post("/auth/refresh", json={"refresh_token": atual})
    assert resp.status_code == 401


async def test_access_token_nao_serve_como_refresh(client: AsyncClient, admin: User) -> None:
    login = (
        await client.post("/auth/login", json={"email": admin.email, "senha": "senha1234"})
    ).json()
    resp = await client.post("/auth/refresh", json={"refresh_token": login["access_token"]})
    assert resp.status_code == 401


async def test_logout_revoga_a_sessao(client: AsyncClient, admin: User) -> None:
    login = (
        await client.post("/auth/login", json={"email": admin.email, "senha": "senha1234"})
    ).json()
    headers = {"Authorization": f"Bearer {login['access_token']}"}

    saida = await client.post(
        "/auth/logout", json={"refresh_token": login["refresh_token"]}, headers=headers
    )
    assert saida.status_code == 204

    resp = await client.post("/auth/refresh", json={"refresh_token": login["refresh_token"]})
    assert resp.status_code == 401


async def test_me_exige_token(client: AsyncClient) -> None:
    assert (await client.get("/auth/me")).status_code == 401


async def test_me_devolve_usuario_da_sessao(
    client: AsyncClient, auth_admin: dict[str, str], admin: User
) -> None:
    resp = await client.get("/auth/me", headers=auth_admin)
    assert resp.status_code == 200
    assert resp.json()["id"] == admin.id


async def test_login_devolve_o_refresh_em_cookie_httponly(
    client: AsyncClient, admin: User
) -> None:
    """No navegador não há cofre: o refresh precisa ficar fora do alcance do JavaScript."""
    resp = await client.post(
        "/auth/login", json={"email": admin.email, "senha": "senha1234"}
    )
    assert resp.status_code == 200
    bruto = resp.headers.get("set-cookie", "")
    assert "loja_refresh=" in bruto
    assert "HttpOnly" in bruto
    assert "SameSite=strict" in bruto


async def test_navegador_renova_a_sessao_so_com_o_cookie(
    client: AsyncClient, admin: User
) -> None:
    await client.post("/auth/login", json={"email": admin.email, "senha": "senha1234"})
    # Sem corpo nenhum: é assim que a página web renova, com o cookie indo sozinho.
    resp = await client.post("/auth/refresh")
    assert resp.status_code == 200, resp.text
    assert resp.json()["access_token"]


async def test_refresh_sem_corpo_e_sem_cookie_e_recusado(client: AsyncClient) -> None:
    resp = await client.post("/auth/refresh")
    assert resp.status_code == 401
    assert resp.json()["code"] == "TOKEN_INVALIDO"


async def test_logout_pelo_navegador_apaga_o_cookie(
    client: AsyncClient, admin: User
) -> None:
    login = (
        await client.post("/auth/login", json={"email": admin.email, "senha": "senha1234"})
    ).json()
    headers = {"Authorization": f"Bearer {login['access_token']}"}

    saida = await client.post("/auth/logout", headers=headers)
    assert saida.status_code == 204

    # Cookie apagado e família revogada: nem o navegador nem uma cópia do token renovam.
    assert (await client.post("/auth/refresh")).status_code == 401
