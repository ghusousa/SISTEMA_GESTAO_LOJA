"""Taxa da maquininha: quanto a credenciadora fica de cada venda no cartão, e quando paga.

Débito e crédito custam de 2 a 5% (mais no parcelado) sobre a maior parte do faturamento.
Sem esta tabela, o "Resultado" do mês sai inflado todo mês — a não ser que o dono lance a
taxa à mão como despesa, o que ninguém faz direito.

**A taxa é FOTOGRAFADA no pagamento** (`sale_payments.taxa_percentual` e `prazo_dias`), no
instante da venda. Esta tabela diz quanto custa vender HOJE; mudar a taxa amanhã (o
contrato com a credenciadora foi renegociado) não reescreve o resultado de ontem — o mesmo
princípio do custo congelado em `sale_items` (ADR-35).
"""

from decimal import Decimal

from sqlalchemy import CheckConstraint, Index, Numeric, SmallInteger, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, TimestampMixin

#: As formas que pagam taxa. PIX e dinheiro não passam pela maquininha.
FORMAS_DE_CARTAO: tuple[str, ...] = ("DEBITO", "CREDITO")

#: O balcão parcela de 1x a 12x — o teto que a tela oferece e o servidor aceita.
MAX_PARCELAS = 12

#: Maior prazo aceito para o dinheiro cair na conta. Um ano cobre qualquer contrato real; o
#: teto existe para o erro de digitação (3000 dias) não empurrar o recebível para 2034.
MAX_PRAZO_DIAS = 366


class CardFee(Base, TimestampMixin):
    """Uma linha do contrato: "crédito de 2x a 6x custa 4,99% e cai em D+30 por parcela"."""

    __tablename__ = "card_fees"
    __table_args__ = (
        CheckConstraint("forma IN ('DEBITO','CREDITO')", name="forma"),
        CheckConstraint(
            f"parcelas_de >= 1 AND parcelas_ate >= parcelas_de AND parcelas_ate <= {MAX_PARCELAS}",
            name="parcelas",
        ),
        # Débito não parcela: a linha do débito é sempre 1x.
        CheckConstraint("forma = 'CREDITO' OR parcelas_ate = 1", name="debito_a_vista"),
        CheckConstraint("percentual >= 0 AND percentual < 100", name="percentual"),
        CheckConstraint(
            f"prazo_dias >= 0 AND prazo_dias <= {MAX_PRAZO_DIAS}", name="prazo_dias"
        ),
        Index("ix_card_fees_forma", "forma"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    forma: Mapped[str] = mapped_column(String(10), nullable=False)
    #: Faixa de parcelas que esta taxa cobre, inclusive nas duas pontas. Faixas da mesma
    #: forma não se sobrepõem (o service confere com a forma travada): duas taxas para o
    #: mesmo "3x" deixariam a venda escolher uma ao acaso.
    parcelas_de: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=1)
    parcelas_ate: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=1)
    #: Sobre o valor bruto do pagamento, como a credenciadora cobra. Ex.: 3.19 = 3,19%.
    percentual: Mapped[Decimal] = mapped_column(Numeric(5, 2), nullable=False)
    #: Dias corridos entre a venda e o dinheiro na conta (D+1 no débito, D+30 no crédito).
    #: No parcelado, é o prazo da PRIMEIRA parcela; as seguintes caem de 30 em 30 dias.
    prazo_dias: Mapped[int] = mapped_column(SmallInteger, nullable=False)
