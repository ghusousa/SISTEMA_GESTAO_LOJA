"""A conta do dono da demonstração fica de pé durante a revisão da App Store (ADR-45).

As notas da revisão dão ao revisor a conta DEMO_ADMIN_EMAIL do servidor de demonstração (a
Vercel). Sem trava, bastava criar outro dono em Usuários e voltar em "Excluir minha conta":
a conta das notas sumia no meio da revisão e o revisor seguinte não entrava (recusa 2.1).
Na Vercel ela não se exclui, não perde o papel de dono, não é desativada e não troca de
senha — e a recusa vem antes da senha, que é como o publicador confere a trava sem risco.
Fora da Vercel, nada muda.
"""

import pytest
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.security import hash_senha
from app.modules.usuarios.models import Papel, User

SENHA = "senha1234"


@pytest.fixture
def na_vercel(monkeypatch, admin: User) -> User:
    monkeypatch.setattr(settings, "vercel", True)
    # O e-mail da variável pode vir com maiúsculas e espaço: a conta é a mesma.
    monkeypatch.setattr(settings, "demo_admin_email", f"  {admin.email.upper()} ")
    return admin


async def _entrar(client: AsyncClient, email: str) -> dict[str, str]:
    resp = await client.post("/auth/login", json={"email": email, "senha": SENHA})
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


async def _outro_dono(session: AsyncSession) -> User:
    dono = User(
        name="Dono Criado Pelo Revisor",
        email="revisor@teste.com",
        password_hash=hash_senha(SENHA),
        role=Papel.ADMIN,
        is_active=True,
    )
    session.add(dono)
    await session.commit()
    await session.refresh(dono)
    return dono


def _recusa_da_demo(resp) -> None:
    assert resp.status_code == 409, resp.text
    assert resp.json()["code"] == "CONTA_DE_DEMONSTRACAO"
    assert "conta de funcionário" in resp.json()["message"]


async def _existe_e_entra(client: AsyncClient, session: AsyncSession, demo: User) -> None:
    linha = (
        await session.execute(
            text("SELECT role, is_active, deleted_at FROM users WHERE id = :i").bindparams(
                i=demo.id
            )
        )
    ).one()
    assert linha.role == "ADMIN" and linha.is_active and linha.deleted_at is None
    await _entrar(client, demo.email)


async def test_a_conta_da_demo_nao_se_exclui_mesmo_com_outro_dono(
    client: AsyncClient, session: AsyncSession, na_vercel: User
) -> None:
    """O roteiro que derrubava a demo: outro dono criado, e a conta das notas se excluindo."""
    await _outro_dono(session)
    auth = await _entrar(client, na_vercel.email)

    certa = await client.request("DELETE", "/usuarios/me", headers=auth, json={"senha": SENHA})
    _recusa_da_demo(certa)
    # Antes da senha: a errada recebe a mesma recusa (é assim que o publicador confere).
    errada = await client.request(
        "DELETE", "/usuarios/me", headers=auth, json={"senha": "nao-e-a-senha-0123456789"}
    )
    _recusa_da_demo(errada)
    await _existe_e_entra(client, session, na_vercel)


async def test_outro_dono_nao_exclui_rebaixa_desativa_nem_troca_a_senha_da_demo(
    client: AsyncClient, session: AsyncSession, na_vercel: User
) -> None:
    outro = await _outro_dono(session)
    auth = await _entrar(client, outro.email)
    alvo = f"/usuarios/{na_vercel.id}"

    _recusa_da_demo(await client.delete(alvo, headers=auth))
    _recusa_da_demo(await client.patch(alvo, headers=auth, json={"papel": "VENDEDOR"}))
    _recusa_da_demo(await client.patch(alvo, headers=auth, json={"ativo": False}))
    _recusa_da_demo(
        await client.patch(f"{alvo}/senha", headers=auth, json={"nova_senha": "outra-senha-1"})
    )
    # O que não tira o acesso continua: nome e "papel" igual ao de hoje.
    renomear = await client.patch(
        alvo, headers=auth, json={"nome": "Dona da Demo", "papel": "ADMIN"}
    )
    assert renomear.status_code == 200, renomear.text
    await _existe_e_entra(client, session, na_vercel)


async def test_a_propria_demo_nao_troca_a_senha(
    client: AsyncClient, session: AsyncSession, na_vercel: User
) -> None:
    auth = await _entrar(client, na_vercel.email)
    resp = await client.patch(
        "/usuarios/me/senha", headers=auth, json={"senha_atual": SENHA, "nova_senha": "nova-1234"}
    )
    _recusa_da_demo(resp)
    await _existe_e_entra(client, session, na_vercel)


async def test_as_outras_contas_da_demo_se_excluem_normalmente(
    client: AsyncClient, session: AsyncSession, na_vercel: User, vendedor: User
) -> None:
    """O revisor testa a exclusão numa conta de funcionário: pelo dono e pela própria."""
    auth_demo = await _entrar(client, na_vercel.email)
    assert (await client.delete(f"/usuarios/{vendedor.id}", headers=auth_demo)).status_code == 204

    criada = await client.post("/usuarios", headers=auth_demo, json={
        "nome": "Funcionária do Revisor", "email": "func@teste.com", "senha": SENHA,
        "papel": "VENDEDOR",
    })
    assert criada.status_code == 201, criada.text
    auth_func = await _entrar(client, "func@teste.com")
    sai = await client.request("DELETE", "/usuarios/me", headers=auth_func, json={"senha": SENHA})
    assert sai.status_code == 204, sai.text


async def test_fora_da_vercel_o_mesmo_email_nao_tem_trava(
    client: AsyncClient, session: AsyncSession, monkeypatch, admin: User
) -> None:
    """Na loja (sem VERCEL) a variável não existe, e se existir não vale: o dono de uma loja
    de verdade sai como qualquer um (com outro dono ativo)."""
    monkeypatch.setattr(settings, "vercel", False)
    monkeypatch.setattr(settings, "demo_admin_email", admin.email)
    await _outro_dono(session)
    auth = await _entrar(client, admin.email)
    resp = await client.request("DELETE", "/usuarios/me", headers=auth, json={"senha": SENHA})
    assert resp.status_code == 204, resp.text
