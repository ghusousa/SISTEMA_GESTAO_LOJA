"""Regras da tabela de taxas — e a pergunta que a venda faz a ela.

O serviço público que os outros módulos usam é `aplicada(forma, parcelas)`: a venda
pergunta "quanto custa receber R$ X em crédito 3x?" e FOTOGRAFA a resposta no pagamento
(ADR-35). Ninguém de fora lê `card_fees` direto.
"""

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NaoEncontrado, Validacao
from app.core.pagination import Pagina, Paginacao
from app.modules.taxas.models import FORMAS_DE_CARTAO, CardFee
from app.modules.taxas.repository import TaxaRepository
from app.modules.taxas.schemas import TaxaIn, TaxaOut, TaxaUpdate, conferir_faixa

#: Quando a forma não tem taxa cadastrada para aquele número de parcelas, a venda segue
#: (a taxa é informação de gestão, nunca trava de balcão) com 0% e o prazo de mercado:
#: débito em D+1, crédito em D+30 por parcela. É exatamente o que o sistema assumia antes
#: desta tabela existir — o resultado não muda até o dono cadastrar o contrato dele.
PRAZO_PADRAO_DIAS: dict[str, int] = {"DEBITO": 1, "CREDITO": 30}

ZERO_PCT = Decimal("0.00")


def valor_da_taxa(valor: Decimal, percentual: Decimal) -> Decimal:
    """Quanto a maquininha fica de `valor`, em centavos — arredondado como no SQL.

    O relatório soma `round(amount * taxa_percentual / 100, 2)` por pagamento no banco; a
    venda mostra este número. Os dois têm de bater centavo a centavo, e por isso o
    arredondamento é o mesmo (meio para cima: o `round` do Postgres em numeric positivo).
    """
    return (valor * percentual / 100).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


@dataclass(frozen=True)
class TaxaAplicada:
    """O que vai congelado no pagamento."""

    percentual: Decimal
    prazo_dias: int


class TaxaService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.repo = TaxaRepository(session)

    # ------------------------------------------------------------ a pergunta da venda
    async def aplicada(self, forma: str, parcelas: int) -> TaxaAplicada | None:
        """A taxa e o prazo desta forma neste número de parcelas. `None` fora do cartão."""
        if forma not in FORMAS_DE_CARTAO:
            return None
        taxa = await self.repo.para(forma, parcelas)
        if taxa is None:
            return TaxaAplicada(percentual=ZERO_PCT, prazo_dias=PRAZO_PADRAO_DIAS[forma])
        return TaxaAplicada(percentual=taxa.percentual, prazo_dias=taxa.prazo_dias)

    # ------------------------------------------------------------ cadastro
    async def listar(self, p: Paginacao) -> Pagina[TaxaOut]:
        linhas, total = await self.repo.listar(p)
        return Pagina.montar([TaxaOut.model_validate(t) for t in linhas], total, p)

    async def _obter(self, taxa_id: int) -> CardFee:
        taxa = await self.repo.obter(taxa_id)
        if taxa is None:
            raise NaoEncontrado("Taxa não encontrada.")
        return taxa

    async def _recusar_sobreposta(
        self, forma: str, de: int, ate: int, exceto: int | None = None
    ) -> None:
        outra = await self.repo.sobreposta(forma, de, ate, exceto)
        if outra is not None:
            raise Validacao(
                f"Já existe taxa de {forma.lower()} para {outra.parcelas_de}x a "
                f"{outra.parcelas_ate}x. Ajuste aquela faixa ou escolha outra.",
                {"taxa_id": outra.id},
            )

    async def criar(self, dados: TaxaIn) -> TaxaOut:
        await self.repo.travar_forma(dados.forma)
        await self._recusar_sobreposta(dados.forma, dados.parcelas_de, dados.parcelas_ate)
        taxa = CardFee(
            forma=dados.forma,
            parcelas_de=dados.parcelas_de,
            parcelas_ate=dados.parcelas_ate,
            percentual=dados.percentual,
            prazo_dias=dados.prazo_dias,
        )
        self.session.add(taxa)
        await self.session.commit()
        await self.session.refresh(taxa)
        return TaxaOut.model_validate(taxa)

    async def atualizar(self, taxa_id: int, dados: TaxaUpdate) -> TaxaOut:
        """Muda a taxa daqui para frente. O que já foi vendido segue com a taxa do dia."""
        taxa = await self._obter(taxa_id)
        await self.repo.travar_forma(taxa.forma)
        campos = dados.model_dump(exclude_unset=True, exclude_none=True)
        de = campos.get("parcelas_de", taxa.parcelas_de)
        ate = campos.get("parcelas_ate", taxa.parcelas_ate)
        try:
            conferir_faixa(taxa.forma, de, ate)
        except ValueError as erro:
            raise Validacao(str(erro)) from erro
        await self._recusar_sobreposta(taxa.forma, de, ate, exceto=taxa.id)
        for campo, valor in campos.items():
            setattr(taxa, campo, valor)
        await self.session.commit()
        await self.session.refresh(taxa)
        return TaxaOut.model_validate(taxa)

    async def excluir(self, taxa_id: int) -> None:
        """Apaga de verdade: nenhuma venda aponta para cá (a taxa vai copiada no pagamento)."""
        taxa = await self._obter(taxa_id)
        await self.session.delete(taxa)
        await self.session.commit()
