"""Configuração do backup na nuvem.

A promessa: só o dono mexe, o token do Google NUNCA sai por rota nenhuma, e ligar sem
conta conectada é recusado — porque uma tela dizendo "ativo" sem backup acontecendo é
pior do que não ter tela.
"""

import pytest
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.permissoes import Pode, pode
from app.modules.usuarios.models import Papel

pytestmark = pytest.mark.anyio

TOKEN = '{"access_token":"aa","refresh_token":"bb","expiry":"2030-01-01T00:00:00Z"}'


async def test_so_o_dono_mexe_no_backup(
    client: AsyncClient, auth_gerente: dict, auth_supervisora: dict, auth_vendedor: dict
) -> None:
    """Quem tem a conta do Drive tem a loja inteira: vendas, custos, clientes e dívidas."""
    for headers in (auth_gerente, auth_supervisora, auth_vendedor):
        assert (await client.get("/backup", headers=headers)).status_code == 403
        resp = await client.put("/backup", json={"ativo": True}, headers=headers)
        assert resp.status_code == 403
    assert (await client.get("/backup")).status_code == 401


async def test_gerir_backup_e_capacidade_so_do_dono() -> None:
    assert pode(Papel.ADMIN, Pode.GERIR_BACKUP)
    for papel in (Papel.GERENTE, Papel.SUPERVISORA, Papel.VENDEDOR):
        assert not pode(papel, Pode.GERIR_BACKUP)


async def test_nasce_desligado_e_sem_conta(client: AsyncClient, auth_admin: dict) -> None:
    corpo = (await client.get("/backup", headers=auth_admin)).json()
    assert corpo["ativo"] is False
    assert corpo["configurado"] is False
    assert corpo["manter"] == 10
    assert corpo["intervalo_min"] == 30


async def test_o_token_do_google_nunca_sai(client: AsyncClient, auth_admin: dict) -> None:
    """O teste mais importante deste arquivo."""
    await client.put("/backup", json={"rclone_token": TOKEN}, headers=auth_admin)
    resp = await client.get("/backup", headers=auth_admin)
    assert resp.status_code == 200
    assert resp.json()["configurado"] is True
    # nem o campo, nem o valor, em lugar nenhum da resposta
    assert "rclone_token" not in resp.json()
    assert "refresh_token" not in resp.text
    assert "bb" not in resp.text


async def test_ligar_sem_conta_conectada_e_recusado(
    client: AsyncClient, auth_admin: dict
) -> None:
    """Senão a tela diria 'ativo' e nada aconteceria — o pior tipo de backup."""
    resp = await client.put("/backup", json={"ativo": True}, headers=auth_admin)
    assert resp.status_code == 409
    assert resp.json()["code"] == "OPERACAO_INVALIDA"


async def test_ligar_depois_de_conectar_funciona(
    client: AsyncClient, auth_admin: dict
) -> None:
    await client.put("/backup", json={"rclone_token": TOKEN}, headers=auth_admin)
    resp = await client.put("/backup", json={"ativo": True}, headers=auth_admin)
    assert resp.status_code == 200
    assert resp.json()["ativo"] is True


async def test_salvar_sem_mandar_token_nao_apaga_o_que_existe(
    client: AsyncClient, auth_admin: dict, session: AsyncSession
) -> None:
    """Desligar e religar não pode exigir reconectar a conta do Google."""
    await client.put("/backup", json={"rclone_token": TOKEN, "ativo": True}, headers=auth_admin)
    await client.put("/backup", json={"ativo": False}, headers=auth_admin)
    guardado = await session.scalar(
        text("SELECT rclone_token FROM backup_config WHERE id = 1")
    )
    assert guardado == TOKEN
    assert (await client.get("/backup", headers=auth_admin)).json()["configurado"] is True


async def test_texto_que_nao_e_token_e_recusado(
    client: AsyncClient, auth_admin: dict
) -> None:
    """Colar o texto errado e a tela dizer 'configurado' faria a loja passar semanas
    achando que tem backup."""
    for lixo in ["meu token", "https://drive.google.com/...", '{"foo":"bar"}']:
        resp = await client.put("/backup", json={"rclone_token": lixo}, headers=auth_admin)
        assert resp.status_code == 422, lixo


async def test_teto_de_copias_tem_minimo(client: AsyncClient, auth_admin: dict) -> None:
    """Guardar 1 cópia é não ter backup: a próxima apaga a única boa."""
    assert (await client.put("/backup", json={"manter": 1}, headers=auth_admin)).status_code == 422
    assert (await client.put("/backup", json={"manter": 10}, headers=auth_admin)).status_code == 200


async def test_intervalo_tem_minimo(client: AsyncClient, auth_admin: dict) -> None:
    assert (
        await client.put("/backup", json={"intervalo_min": 1}, headers=auth_admin)
    ).status_code == 422
    assert (
        await client.put("/backup", json={"intervalo_min": 30}, headers=auth_admin)
    ).status_code == 200


async def test_o_estado_da_ultima_copia_chega_na_tela(
    client: AsyncClient, auth_admin: dict, session: AsyncSession
) -> None:
    """É o `backup.sh` quem escreve isto, na máquina. A tela só lê — e é o que faz o dono
    confiar ou desconfiar do backup."""
    await client.get("/backup", headers=auth_admin)  # garante a linha
    await session.execute(
        text(
            "UPDATE backup_config SET ultimo_em = now(), ultimo_ok = true, "
            "ultimo_bytes = 4200000, copias_na_nuvem = 10 WHERE id = 1"
        )
    )
    await session.commit()
    corpo = (await client.get("/backup", headers=auth_admin)).json()
    assert corpo["ultimo_ok"] is True
    assert corpo["ultimo_bytes"] == 4200000
    assert corpo["copias_na_nuvem"] == 10


async def test_mexer_no_backup_entra_no_diario(
    client: AsyncClient, auth_admin: dict
) -> None:
    await client.put("/backup", json={"rclone_token": TOKEN}, headers=auth_admin)
    diario = await client.get("/auditoria?acao=BACKUP_CONFIGURADO", headers=auth_admin)
    assert diario.json()["total"] == 1
