"""Serviço da auditoria: escrever o diário (usado pela borda) e lê-lo (usado pelo dono).

É também a porta pública para os outros módulos — o login grava aqui a tentativa e a
exclusão de usuário pede aqui o esquecimento do e-mail —, porque um módulo nunca importa o
repository de outro.

**LGPD x auditoria (ADR-23).** O diário prova quem fez o quê; para isso, nome e papel de
quem AGIU ficam congelados na linha, e isso não muda. O que muda é o que não prova nada:
o e-mail que alguém digitou e errou fica mascarado quando a conta não existe (pode ser o
e-mail de uma pessoa qualquer, digitado errado), e a tentativa numa conta real vira o id e
o nome dela, sem e-mail. Ao excluir a conta, as linhas antigas que ainda traziam o e-mail
dela passam a trazer a máscara. E nada fica para sempre: a faxina apaga o que passou de
`RETENCAO_AUDITORIA_DIAS`.
"""

import re
from datetime import datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.pagination import Pagina, Paginacao
from app.modules.auditoria.models import AuditLog
from app.modules.auditoria.repository import AuditoriaRepository
from app.modules.auditoria.schemas import AuditoriaOut


def _mascarar_parte(parte: str, visiveis: int) -> str:
    return f"{parte[:visiveis]}***" if parte else "***"


def mascarar_email(email: str) -> str:
    """`maria.silva@gmail.com` → `ma***@g***.com`.

    Sobra o bastante para o dono ver que as 40 tentativas da madrugada foram do mesmo
    endereço, e pouco demais para alguém tirar dali o e-mail de uma pessoa.
    """
    texto = email.strip()
    if "@" not in texto:
        return _mascarar_parte(texto, 2)[:160]
    local, _, dominio = texto.rpartition("@")
    nome_dominio, ponto, fim = dominio.rpartition(".")
    if not ponto:  # "fulano@localhost": sem ponto, o domínio inteiro vira máscara
        nome_dominio, fim = dominio, ""
    sufixo = f".{fim}" if fim else ""
    return f"{_mascarar_parte(local, 2)}@{_mascarar_parte(nome_dominio, 1)}{sufixo}"[:160]


class AuditoriaService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.repo = AuditoriaRepository(session)

    def registrar(self, **campos) -> AuditLog:  # noqa: ANN003
        """Uma linha nova no diário. Quem chama faz o commit, junto com o próprio ato."""
        return self.repo.registrar(**campos)

    async def aplicar_retencao(self, agora: datetime) -> int:
        """Faxina oportunista: apaga um lote do que passou do prazo. 0 dias = guarda tudo."""
        dias = settings.retencao_auditoria_dias
        if dias <= 0:
            return 0
        return await self.repo.apagar_anteriores(agora - timedelta(days=dias))

    async def esquecer_email(self, email: str) -> int:
        """A conta foi excluída: onde o e-mail dela aparece no diário, passa a aparecer a
        máscara. O nome congelado de quem agiu não é tocado — só o e-mail, que identificava
        a pessoa sem provar ato nenhum."""
        mascara = mascarar_email(email)
        # O e-mail INTEIRO, com limites: casar como substring mascarava o meio de outros
        # e-mails (excluir `a@b.co` corrompia a frase de `maria@b.com`).
        alvo = re.compile(
            r"(?<![\w.+-])" + re.escape(email.strip()) + r"(?![\w.-])", re.IGNORECASE
        )
        linhas = await self.repo.linhas_com_email(email)
        for linha in linhas:
            if linha.user_nome.strip().lower() == email.strip().lower():
                linha.user_nome = mascara
            linha.descricao = alvo.sub(mascara, linha.descricao)[:300]
        return len(linhas)

    async def listar(
        self,
        p: Paginacao,
        *,
        usuario_id: int | None = None,
        acao: str | None = None,
        inicio: datetime | None = None,
        fim: datetime | None = None,
    ) -> Pagina[AuditoriaOut]:
        linhas, total = await self.repo.listar(
            usuario_id=usuario_id,
            acao=acao,
            inicio=inicio,
            fim=fim,
            offset=p.offset,
            limit=p.limit,
        )
        return Pagina.montar(
            [AuditoriaOut.model_validate(l) for l in linhas], total, p
        )
