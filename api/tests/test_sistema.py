"""A versão instalada, e a pergunta que interessa: está atrasada?

Mostrar `5c31d04` numa tela não ajuda ninguém — o hash não é maior nem menor que o
anterior. O que resolve a dúvida de quem cuida da loja é a frase pronta, e é ela que estes
testes prendem.
"""

import json
from datetime import UTC, datetime, timedelta

import pytest

pytestmark = pytest.mark.anyio


def _escrever(tmp_path, monkeypatch, **campos) -> None:
    from app.core.config import settings

    (tmp_path / "versao.json").write_text(json.dumps(campos), encoding="utf-8")
    monkeypatch.setattr(settings, "estado_dir", str(tmp_path))


def _agora(delta: timedelta = timedelta()) -> str:
    return (datetime.now(UTC) + delta).isoformat()


async def test_conferido_agora_e_em_dia(client, auth_vendedor, tmp_path, monkeypatch) -> None:
    _escrever(
        tmp_path,
        monkeypatch,
        commit="5c31d04",
        data=_agora(-timedelta(hours=2)),
        conferido_em=_agora(-timedelta(minutes=4)),
        atualizada=True,
    )
    corpo = (await client.get("/versao", headers=auth_vendedor)).json()
    assert corpo["commit"] == "5c31d04"
    assert corpo["atualizada"] is True
    assert corpo["conferido_recente"] is True
    assert corpo["resumo"] == "Está na versão mais nova."


async def test_existe_versao_nova_esperando(client, auth_admin, tmp_path, monkeypatch) -> None:
    """O caso do rollback: a instalada voltou a ser a velha e a nova ficou no GitHub."""
    _escrever(
        tmp_path,
        monkeypatch,
        commit="414c046",
        conferido_em=_agora(-timedelta(minutes=10)),
        atualizada=False,
    )
    corpo = (await client.get("/versao", headers=auth_admin)).json()
    assert corpo["atualizada"] is False
    assert "mais nova esperando" in corpo["resumo"]


async def test_conferida_velha_nao_tranquiliza(client, auth_admin, tmp_path, monkeypatch) -> None:
    """"Atualizada" de três dias atrás não é resposta: o timer pode ter morrido ontem."""
    _escrever(
        tmp_path,
        monkeypatch,
        commit="414c046",
        conferido_em=_agora(-timedelta(days=3)),
        atualizada=True,
    )
    corpo = (await client.get("/versao", headers=auth_admin)).json()
    assert corpo["conferido_recente"] is False
    assert "Não confere" in corpo["resumo"]


async def test_sem_arquivo_nao_quebra(client, auth_admin, tmp_path, monkeypatch) -> None:
    """Rodar fora do Docker não tem arquivo nenhum, e isso é desenvolvimento, não erro."""
    from app.core.config import settings

    monkeypatch.setattr(settings, "estado_dir", str(tmp_path / "nao-existe"))
    resposta = await client.get("/versao", headers=auth_admin)
    assert resposta.status_code == 200
    assert resposta.json()["commit"] is None
    assert "sem conferir" in resposta.json()["resumo"].lower()


async def test_versao_exige_login(client) -> None:
    assert (await client.get("/versao")).status_code == 401
