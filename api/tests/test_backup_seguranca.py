"""Backup: trocar o destino pede a senha, e a tela sabe quando a cópia parou.

Duas promessas (itens 18 e 9 do plano de melhorias):

- Com uma sessão do dono esquecida aberta no balcão, colar o próprio token do rclone
  mandava o banco inteiro para o Drive de outra pessoa a cada 30 min — e continuava depois
  de o dono trocar a senha. Trocar o token ou a pasta agora pede a senha de quem salva.
- O selo dizia "Funcionando" olhando só SE a última cópia deu certo, nunca QUANDO. Um timer
  parado não grava nada, e a tela mentia por dias. `atrasado` diz quando passou da hora.
"""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.backup.schemas import esta_atrasado

TOKEN = '{"access_token":"aa","refresh_token":"bb","expiry":"2030-01-01T00:00:00Z"}'
OUTRO = '{"access_token":"xx","refresh_token":"do-intruso","expiry":"2030-01-01T00:00:00Z"}'
SENHA = "senha1234"  # a das fixtures do conftest


async def _token_gravado(session: AsyncSession) -> str | None:
    return await session.scalar(text("SELECT rclone_token FROM backup_config WHERE id = 1"))


async def _conectar(client: AsyncClient, auth: dict) -> None:
    resp = await client.put(
        "/backup", json={"rclone_token": TOKEN, "ativo": True}, headers=auth
    )
    assert resp.status_code == 200, resp.text


# ------------------------------------------------------------- senha para trocar o destino


async def test_trocar_o_token_sem_senha_e_recusado(
    client: AsyncClient, auth_admin: dict, session: AsyncSession
) -> None:
    await _conectar(client, auth_admin)

    resp = await client.put("/backup", json={"rclone_token": OUTRO}, headers=auth_admin)
    # 422, nunca 401: um 401 faria a tela achar que a sessão caiu e deslogar o dono.
    assert resp.status_code == 422, resp.text
    assert resp.json()["code"] == "VALIDACAO"
    assert resp.json()["detail"]["campo"] == "senha_atual"
    assert await _token_gravado(session) == TOKEN


async def test_trocar_o_token_com_senha_errada_e_recusado(
    client: AsyncClient, auth_admin: dict, session: AsyncSession
) -> None:
    await _conectar(client, auth_admin)

    resp = await client.put(
        "/backup",
        json={"rclone_token": OUTRO, "senha_atual": "chute-errado"},
        headers=auth_admin,
    )
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["motivo"] == "errada"
    assert await _token_gravado(session) == TOKEN


async def test_trocar_o_token_com_a_senha_certa_funciona(
    client: AsyncClient, auth_admin: dict, session: AsyncSession
) -> None:
    await _conectar(client, auth_admin)

    resp = await client.put(
        "/backup", json={"rclone_token": OUTRO, "senha_atual": SENHA}, headers=auth_admin
    )
    assert resp.status_code == 200, resp.text
    assert await _token_gravado(session) == OUTRO
    # a senha não vira campo de resposta nem coluna
    assert "senha_atual" not in resp.json()


async def test_trocar_a_pasta_pede_senha_mas_ligar_e_desligar_nao(
    client: AsyncClient, auth_admin: dict, session: AsyncSession
) -> None:
    await _conectar(client, auth_admin)

    sem_senha = await client.put("/backup", json={"pasta": "pasta-do-intruso"}, headers=auth_admin)
    assert sem_senha.status_code == 422, sem_senha.text
    pasta = await session.scalar(text("SELECT pasta FROM backup_config WHERE id = 1"))
    assert pasta != "pasta-do-intruso"

    # Reenviar a MESMA pasta (a tela manda o formulário inteiro) não é trocar destino.
    mesma = await client.put(
        "/backup", json={"pasta": pasta, "intervalo_min": 60, "manter": 5}, headers=auth_admin
    )
    assert mesma.status_code == 200, mesma.text
    for ligado in (False, True):
        resp = await client.put("/backup", json={"ativo": ligado}, headers=auth_admin)
        assert resp.status_code == 200, resp.text

    com_senha = await client.put(
        "/backup", json={"pasta": "pasta-nova", "senha_atual": SENHA}, headers=auth_admin
    )
    assert com_senha.status_code == 200, com_senha.text
    assert com_senha.json()["pasta"] == "pasta-nova"


# --------------------------------------------------------------------------- atrasado


async def test_copia_velha_demais_aparece_como_atrasada(
    client: AsyncClient, auth_admin: dict, session: AsyncSession
) -> None:
    """Ligado, de 30 em 30 min, e a última cópia (que DEU CERTO) foi há 3 horas: o selo
    antigo dizia "Funcionando"."""
    await _conectar(client, auth_admin)
    await session.execute(
        text(
            "UPDATE backup_config SET ultimo_ok = true, intervalo_min = 30, "
            "ultimo_em = now() - interval '3 hours' WHERE id = 1"
        )
    )
    await session.commit()
    assert (await client.get("/backup", headers=auth_admin)).json()["atrasado"] is True

    await session.execute(
        text("UPDATE backup_config SET ultimo_em = now() - interval '20 minutes' WHERE id = 1")
    )
    await session.commit()
    assert (await client.get("/backup", headers=auth_admin)).json()["atrasado"] is False


async def test_ligado_e_nunca_copiou_atrasa_tambem(
    client: AsyncClient, auth_admin: dict, session: AsyncSession
) -> None:
    """"Ligado, primeira cópia ainda não rodou" ficava assim para sempre, em tom calmo."""
    await _conectar(client, auth_admin)
    assert (await client.get("/backup", headers=auth_admin)).json()["atrasado"] is False

    await session.execute(
        text("UPDATE backup_config SET updated_at = now() - interval '2 hours' WHERE id = 1")
    )
    await session.commit()
    corpo = (await client.get("/backup", headers=auth_admin)).json()
    assert corpo["ultimo_em"] is None
    assert corpo["atrasado"] is True


async def test_desligado_nunca_esta_atrasado(
    client: AsyncClient, auth_admin: dict, session: AsyncSession
) -> None:
    await _conectar(client, auth_admin)
    await client.put("/backup", json={"ativo": False}, headers=auth_admin)
    await session.execute(
        text("UPDATE backup_config SET ultimo_em = now() - interval '30 days' WHERE id = 1")
    )
    await session.commit()
    assert (await client.get("/backup", headers=auth_admin)).json()["atrasado"] is False


def test_a_regra_do_atraso_e_duas_vezes_o_intervalo() -> None:
    agora = datetime(2026, 11, 2, 12, 0, tzinfo=UTC)
    base = {"ativo": True, "rclone_token": TOKEN, "intervalo_min": 30, "updated_at": agora}

    def c(**k):
        return SimpleNamespace(**{**base, **k})

    assert not esta_atrasado(c(ultimo_em=agora - timedelta(minutes=60)), agora)
    assert esta_atrasado(c(ultimo_em=agora - timedelta(minutes=61)), agora)
    assert not esta_atrasado(c(ultimo_em=None, updated_at=agora - timedelta(minutes=59)), agora)
    assert esta_atrasado(c(ultimo_em=None, updated_at=agora - timedelta(minutes=61)), agora)
    assert not esta_atrasado(c(rclone_token=None, ultimo_em=None), agora)
