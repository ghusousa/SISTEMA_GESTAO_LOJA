"""Exclusão de conta — exigência das lojas de app, e o histórico que NÃO vai junto.

A promessa: a linha do usuário some de verdade (não é desativar), mas a venda que ele
registrou e a linha de auditoria continuam de pé, porque são a contabilidade da loja.
"""

from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession



async def test_dono_exclui_e_a_linha_some_de_verdade(
    client: AsyncClient, auth_admin: dict, vendedor, session: AsyncSession
) -> None:
    resp = await client.delete(f"/usuarios/{vendedor.id}", headers=auth_admin)
    assert resp.status_code == 204, resp.text

    restante = await session.scalar(
        text("SELECT count(*) FROM users WHERE id = :i").bindparams(i=vendedor.id)
    )
    assert restante == 0  # some, não vira ativo=false


async def test_excluir_nao_apaga_a_auditoria_nem_reescreve_o_passado(
    client: AsyncClient, auth_admin: dict, auth_vendedor: dict, vendedor, session: AsyncSession
) -> None:
    """O nome de quem agiu fica congelado na linha (ADR-23): apagar a conta remove o
    vínculo, não a história."""
    await client.post("/categorias", headers=auth_vendedor, json={"nome": "Feita pela Ana"})
    antes = await session.scalar(
        text("SELECT count(*) FROM audit_log WHERE user_id = :i").bindparams(i=vendedor.id)
    )
    assert antes >= 1

    assert (await client.delete(f"/usuarios/{vendedor.id}", headers=auth_admin)).status_code == 204

    linha = (
        await session.execute(
            text(
                "SELECT user_id, user_nome FROM audit_log "
                "WHERE user_nome = :n ORDER BY id DESC LIMIT 1"
            ).bindparams(n=vendedor.name)
        )
    ).first()
    assert linha is not None
    assert linha.user_id is None          # vínculo cortado
    assert linha.user_nome == vendedor.name  # história intacta


async def test_excluir_tira_o_email_do_diario_mas_nao_o_nome_de_quem_agiu(
    client: AsyncClient, auth_admin: dict, auth_vendedor: dict, vendedor, session: AsyncSession
) -> None:
    """A página de exclusão promete que o e-mail deixa de existir. O diário o guardava por
    extenso em cada login que falhou (formato antigo do LOGIN_FALHOU) — ao excluir a conta,
    ele vira máscara. O nome congelado dos atos fica (ADR-23)."""
    await client.post("/categorias", headers=auth_vendedor, json={"nome": "Ato da Ana"})
    # Linha no formato antigo: e-mail no lugar do nome e dentro da frase, com maiúscula.
    await session.execute(
        text(
            "INSERT INTO audit_log (user_nome, acao, descricao) "
            "VALUES (:e, 'LOGIN_FALHOU', :d)"
        ).bindparams(
            e=vendedor.email.upper(),
            d=f"Tentou entrar e errou a senha ({vendedor.email.upper()})",
        )
    )
    # O e-mail de OUTRA pessoa contém o dela ("mariana@…" contém "ana@…"): a máscara não
    # pode comer o meio dele — a frase da Mariana tem de sair intacta.
    outra = "Tentou entrar e errou a senha (mari" + vendedor.email + ")"
    await session.execute(
        text(
            "INSERT INTO audit_log (user_nome, acao, descricao) VALUES ('x', 'LOGIN_FALHOU', :d)"
        ).bindparams(d=outra)
    )
    await session.commit()

    assert (await client.delete(f"/usuarios/{vendedor.id}", headers=auth_admin)).status_code == 204

    com_email = await session.scalar(
        text(
            "SELECT count(*) FROM audit_log "
            "WHERE user_nome ILIKE :p OR descricao ILIKE :p"
        ).bindparams(p=f"%{vendedor.email}%")
    )
    assert com_email == 1  # só a frase da Mariana, intacta
    assert await session.scalar(
        text("SELECT count(*) FROM audit_log WHERE descricao = :d").bindparams(d=outra)
    ) == 1
    mascarada = await session.scalar(
        text("SELECT count(*) FROM audit_log WHERE user_nome = 'an***@l***.com'")
    )
    assert mascarada == 1
    # os atos dela continuam com o nome de quando aconteceram
    assert await session.scalar(
        text("SELECT count(*) FROM audit_log WHERE user_nome = :n").bindparams(n=vendedor.name)
    ) >= 1


async def test_ninguem_exclui_a_propria_conta(
    client: AsyncClient, auth_admin: dict, admin
) -> None:
    resp = await client.delete(f"/usuarios/{admin.id}", headers=auth_admin)
    assert resp.status_code == 409
    assert resp.json()["code"] == "OPERACAO_INVALIDA"


async def test_a_loja_nunca_fica_sem_dono(
    client: AsyncClient, auth_gerente: dict, admin
) -> None:
    """Gerente não mexe em dono — e mesmo que mexesse, o último dono não sai."""
    resp = await client.delete(f"/usuarios/{admin.id}", headers=auth_gerente)
    assert resp.status_code == 403


async def test_vendedora_nao_exclui_ninguem(
    client: AsyncClient, auth_vendedor: dict, gerente
) -> None:
    resp = await client.delete(f"/usuarios/{gerente.id}", headers=auth_vendedor)
    assert resp.status_code == 403


async def test_exclusao_derruba_a_sessao_de_quem_saiu(
    client: AsyncClient, auth_admin: dict, auth_vendedor: dict, vendedor
) -> None:
    """Refresh token sobrevivente daria acesso a uma conta que não existe mais."""
    assert (await client.get("/auth/me", headers=auth_vendedor)).status_code == 200
    await client.delete(f"/usuarios/{vendedor.id}", headers=auth_admin)
    assert (await client.post("/auth/refresh")).status_code == 401


async def test_exclusao_entra_no_diario(
    client: AsyncClient, auth_admin: dict, vendedor
) -> None:
    await client.delete(f"/usuarios/{vendedor.id}", headers=auth_admin)
    diario = await client.get("/auditoria?acao=USUARIO_EXCLUIDO", headers=auth_admin)
    assert diario.json()["total"] == 1
