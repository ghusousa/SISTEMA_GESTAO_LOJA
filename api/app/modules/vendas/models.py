import uuid
from datetime import datetime
from decimal import Decimal
from enum import StrEnum

from sqlalchemy import (
    CheckConstraint,
    Computed,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    Numeric,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.config import settings
from app.core.db import Base


class StatusVenda(StrEnum):
    CONCLUIDA = "CONCLUIDA"
    CANCELADA = "CANCELADA"


class FormaPagamento(StrEnum):
    DINHEIRO = "DINHEIRO"
    PIX = "PIX"
    DEBITO = "DEBITO"
    CREDITO = "CREDITO"
    #: Vale de troca. Não entra dinheiro: a loja já recebeu na venda que gerou o vale.
    VALE = "VALE"
    #: Crediário. A venda existe hoje, o dinheiro vem depois — e pode não vir.
    FIADO = "FIADO"


#: As formas que viram dinheiro NA GAVETA hoje.
#:
#: Existe separado de `FormaPagamento` porque o fechamento de caixa conta o que está na
#: gaveta, e VALE e FIADO não estão: o vale foi pago na venda anterior, o fiado ainda nem
#: foi pago. Percorrer `FormaPagamento` inteiro no caixa faria a loja procurar por dinheiro
#: que nunca existiu e fechar o dia com uma diferença fantasma todo dia que houvesse fiado.
FORMAS_DE_GAVETA: tuple[FormaPagamento, ...] = (
    FormaPagamento.DINHEIRO,
    FormaPagamento.PIX,
    FormaPagamento.DEBITO,
    FormaPagamento.CREDITO,
)

_TODAS = "','".join(FormaPagamento)
_GAVETA = "','".join(FORMAS_DE_GAVETA)


class Sale(Base):
    __tablename__ = "sales"
    __table_args__ = (
        CheckConstraint("status IN ('CONCLUIDA','CANCELADA')", name="status"),
        CheckConstraint("subtotal >= 0 AND discount >= 0 AND total >= 0", name="amounts"),
        CheckConstraint("discount <= subtotal", name="discount_max"),
        CheckConstraint("total = subtotal - discount", name="total_math"),
        CheckConstraint(
            "(status = 'CANCELADA' AND cancelled_at IS NOT NULL AND cancelled_by_id IS NOT NULL)"
            " OR (status = 'CONCLUIDA' AND cancelled_at IS NULL AND cancelled_by_id IS NULL)",
            name="cancel_consistency",
        ),
        UniqueConstraint("id", "customer_id", name="id_customer_id"),
        Index("ix_sales_sold_at", "sold_at"),
        Index("ix_sales_seller_id", "seller_id"),
        Index("ix_sales_status_sold_at", "status", "sold_at"),
        # "Quanto a cliente deve" soma as vendas DELA, e a lista de Clientes faz essa conta
        # para cada cliente. O UNIQUE (id, customer_id) acima não serve: customer_id é a
        # segunda coluna, então cada cliente varria o índice inteiro — 70 s para abrir a
        # tela com 20 mil clientes. Parcial porque a maioria das vendas não tem cliente.
        Index(
            "ix_sales_customer_id",
            "customer_id",
            postgresql_where=text("customer_id IS NOT NULL"),
        ),
        # "Dia" do comércio no fuso da loja: usado por relatórios e fechamento de caixa.
        Index(
            "ix_sales_business_date",
            text(f"((sold_at AT TIME ZONE '{settings.timezone_loja}')::date)"),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    seller_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    status: Mapped[str] = mapped_column(String(10), nullable=False, default=StatusVenda.CONCLUIDA)
    subtotal: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    discount: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    total: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    sold_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_by_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT")
    )
    cancel_reason: Mapped[str | None] = mapped_column(Text)
    # Chave de idempotência gerada pelo app: retry de rede não vira venda duplicada.
    client_uuid: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), nullable=False, unique=True
    )
    note: Mapped[str | None] = mapped_column(Text)
    #: Quem comprou. Só é obrigatório para venda no fiado — dívida sem nome não se cobra.
    customer_id: Mapped[int | None] = mapped_column(ForeignKey("customers.id", ondelete="RESTRICT"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    items: Mapped[list["SaleItem"]] = relationship(
        back_populates="sale", lazy="selectin", cascade="all, delete-orphan"
    )
    payments: Mapped[list["SalePayment"]] = relationship(
        back_populates="sale",
        lazy="selectin",
        cascade="all, delete-orphan",
        # Explícito porque agora existem DOIS caminhos de FK até `sales`: o `sale_id` de
        # sempre e a chave composta (sale_id, customer_id) que amarra o fiado ao cliente
        # da venda. O relacionamento é pelo primeiro.
        foreign_keys="SalePayment.sale_id",
    )


class SaleItem(Base):
    """Preço e custo congelados: reajuste de amanhã não reescreve o lucro de ontem."""

    __tablename__ = "sale_items"
    __table_args__ = (
        CheckConstraint("quantity > 0", name="quantity"),
        CheckConstraint("unit_price >= 0 AND unit_cost >= 0", name="prices"),
        # A rede de segurança contra devolver mais do que foi vendido. Mesmo desenho do
        # saldo de estoque (ADR-1): o contador é materializado na linha e o CHECK é a
        # última palavra, porque conferir em memória deixa duas devoluções simultâneas
        # passarem juntas e a peça volta duas vezes para a arara.
        CheckConstraint(
            "returned_quantity >= 0 AND returned_quantity <= quantity", name="returned_quantity"
        ),
        # Redundante como chave, indispensável como ALVO: é ela que deixa a devolução
        # apontar (item, venda, variante) de uma vez, e o banco recusar sozinho item de
        # OUTRA venda ou variante trocada. Quatro linhas de DDL no lugar de uma classe
        # inteira de bug no service.
        UniqueConstraint("id", "sale_id", "variant_id", name="id_sale_id_variant_id"),
        # INCLUDE: o CMV, as peças por dia e os mais vendidos leem só estas colunas dos
        # itens de um período. Com elas no índice, a soma do mês sai do índice (Index Only
        # Scan) em vez de varrer os anos de `sale_items` atrás de dez mil linhas.
        Index(
            "ix_sale_items_sale_id",
            "sale_id",
            postgresql_include=["variant_id", "quantity", "unit_price", "unit_cost"],
        ),
        Index("ix_sale_items_variant_id", "variant_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    sale_id: Mapped[int] = mapped_column(ForeignKey("sales.id", ondelete="CASCADE"), nullable=False)
    variant_id: Mapped[int] = mapped_column(
        ForeignKey("product_variants.id", ondelete="RESTRICT"), nullable=False
    )
    quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    unit_price: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    unit_cost: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    line_total: Mapped[Decimal] = mapped_column(
        Numeric(14, 2), Computed("unit_price * quantity", persisted=True)
    )
    #: Quanto desta linha já voltou. Não é reescrever a história: preço e custo continuam
    #: congelados; o que se conta aqui é o que saiu de volta pela porta.
    returned_quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    sale: Mapped[Sale] = relationship(back_populates="items")


class SalePayment(Base):
    __tablename__ = "sale_payments"
    __table_args__ = (
        CheckConstraint(f"method IN ('{_TODAS}')", name="method"),
        CheckConstraint("amount > 0", name="amount"),
        # Pagamento em VALE tem de dizer QUAL vale; e vale só aparece em pagamento VALE.
        CheckConstraint(
            "(method = 'VALE' AND voucher_id IS NOT NULL)"
            " OR (method <> 'VALE' AND voucher_id IS NULL)",
            name="voucher_consistency",
        ),
        # Fiado sem nome não se cobra. A regra podia morar no service; aqui ela é
        # impossível de furar — inclusive por script, importação ou correção manual.
        CheckConstraint(
            "(method = 'FIADO') = (customer_id IS NOT NULL)", name="fiado_tem_cliente"
        ),
        # E o cliente do pagamento é obrigatoriamente o cliente DA VENDA.
        ForeignKeyConstraint(
            ["sale_id", "customer_id"],
            ["sales.id", "sales.customer_id"],
            name="sale_id_customer_id_sales",
        ),
        # Parcelado só existe no crédito: "débito em 3x" ou "PIX em 2x" é erro de tela, e
        # viraria três recebíveis que a conta nunca recebe (ADR-35).
        CheckConstraint(
            "parcelas >= 1 AND (parcelas = 1 OR method = 'CREDITO')", name="parcelas"
        ),
        # Bandeira e prazo são do cartão; taxa só o cartão paga. O prazo é obrigatório no
        # cartão porque é dele que sai a data da agenda de recebíveis.
        CheckConstraint(
            "bandeira IS NULL OR method IN ('DEBITO','CREDITO')", name="bandeira_so_cartao"
        ),
        CheckConstraint(
            "taxa_percentual >= 0 AND taxa_percentual < 100"
            " AND (taxa_percentual = 0 OR method IN ('DEBITO','CREDITO'))",
            name="taxa_percentual",
        ),
        CheckConstraint(
            "(method IN ('DEBITO','CREDITO')) = (prazo_dias IS NOT NULL)"
            " AND (prazo_dias IS NULL OR prazo_dias >= 0)",
            name="prazo_so_cartao",
        ),
        Index("ix_sale_payments_sale_id", "sale_id"),
        # Só o fiado: "vendido a prazo" no resumo do mês e a dívida de cada cliente somam
        # exatamente isto, e é uma fração pequena dos pagamentos.
        Index(
            "ix_sale_payments_fiado",
            "sale_id",
            postgresql_include=["amount"],
            postgresql_where=text("method = 'FIADO'"),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    sale_id: Mapped[int] = mapped_column(ForeignKey("sales.id", ondelete="CASCADE"), nullable=False)
    method: Mapped[str] = mapped_column(String(10), nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    voucher_id: Mapped[int | None] = mapped_column(ForeignKey("vouchers.id", ondelete="RESTRICT"))
    #: Só preenchido em pagamento FIADO — e então igual ao cliente da venda (FK composta).
    customer_id: Mapped[int | None] = mapped_column()
    #: Em quantas vezes a cliente parcelou no crédito. 1 em toda outra forma.
    parcelas: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, default=1, server_default="1"
    )
    #: Visa, Mastercard, Elo… Opcional e livre: serve para conferir o extrato da
    #: credenciadora, não para calcular nada.
    bandeira: Mapped[str | None] = mapped_column(String(20))
    #: Taxa da maquininha FOTOGRAFADA na venda (ADR-35). Mudar a tabela de taxas amanhã não
    #: reescreve o resultado de hoje — mesmo princípio do custo congelado em `sale_items`.
    taxa_percentual: Mapped[Decimal] = mapped_column(
        Numeric(5, 2), nullable=False, default=Decimal("0.00"), server_default="0"
    )
    #: Dias até cair na conta (no parcelado, a 1ª parcela; as outras de 30 em 30). Também
    #: fotografado: a agenda de recebíveis não muda porque o contrato mudou depois.
    prazo_dias: Mapped[int | None] = mapped_column(SmallInteger)

    sale: Mapped[Sale] = relationship(
        back_populates="payments", foreign_keys="SalePayment.sale_id"
    )


class SaleReturn(Base):
    """Devolução parcial: a venda não é reescrita, a volta é registrada ao lado.

    Mutar a venda original seria mais curto e destruiria a única coisa que o histórico tem
    de valioso — o que foi combinado no dia. Preço e custo congelados perderiam sentido, o
    CHECK `total = subtotal - discount` cairia, e "quanto essa peça vendeu em agosto?"
    deixaria de ter resposta. Aqui a venda continua dizendo o que foi vendido, e a
    devolução diz o que voltou.

    **A devolução é evento do dia em que acontece**, nunca do dia da venda (ADR-19): mês
    fechado não se reabre, e caixa de terça não muda porque alguém devolveu na quinta.
    """

    __tablename__ = "sale_returns"
    __table_args__ = (
        CheckConstraint("total >= 0", name="total"),
        UniqueConstraint("id", "sale_id", name="id_sale_id"),
        Index("ix_sale_returns_sale_id", "sale_id"),
        Index("ix_sale_returns_returned_at", "returned_at"),
        Index(
            "ix_sale_returns_business_date",
            text(f"((returned_at AT TIME ZONE '{settings.timezone_loja}')::date)"),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    sale_id: Mapped[int] = mapped_column(
        ForeignKey("sales.id", ondelete="RESTRICT"), nullable=False
    )
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    returned_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    reason: Mapped[str | None] = mapped_column(Text)
    total: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    client_uuid: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), nullable=False, unique=True
    )

    items: Mapped[list["SaleReturnItem"]] = relationship(
        back_populates="devolucao",
        lazy="selectin",
        cascade="all, delete-orphan",
        primaryjoin="SaleReturn.id == SaleReturnItem.return_id",
        foreign_keys="SaleReturnItem.return_id",
    )
    payments: Mapped[list["SaleReturnPayment"]] = relationship(
        back_populates="devolucao", lazy="selectin", cascade="all, delete-orphan"
    )


class SaleReturnItem(Base):
    __tablename__ = "sale_return_items"
    __table_args__ = (
        CheckConstraint("quantity > 0", name="quantity"),
        CheckConstraint("refund_amount >= 0", name="refund_amount"),
        # A mesma peça duas vezes na mesma devolução some com o controle de quantidade.
        UniqueConstraint("return_id", "sale_item_id", name="return_id_sale_item_id"),
        # As duas FKs compostas fecham no banco o que seria checagem no service: o item
        # devolvido é DAQUELA venda, e a variante é a que foi vendida naquela linha.
        ForeignKeyConstraint(
            ["sale_item_id", "sale_id", "variant_id"],
            ["sale_items.id", "sale_items.sale_id", "sale_items.variant_id"],
            name="sale_item_id_sale_id_variant_id_sale_items",
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["return_id", "sale_id"],
            ["sale_returns.id", "sale_returns.sale_id"],
            name="return_id_sale_id_sale_returns",
            ondelete="CASCADE",
        ),
        Index("ix_sale_return_items_return_id", "return_id"),
        Index("ix_sale_return_items_variant_id", "variant_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    return_id: Mapped[int] = mapped_column(nullable=False)
    sale_id: Mapped[int] = mapped_column(nullable=False)
    sale_item_id: Mapped[int] = mapped_column(nullable=False)
    variant_id: Mapped[int] = mapped_column(nullable=False)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    #: Preço e custo NÃO são copiados: eles vivem congelados em `sale_items` e vêm por
    #: JOIN. Copiar seria a chance concreta de alguém escrever aqui o custo de HOJE — e
    #: destruir a única promessa que o projeto faz sobre custo histórico.
    #:
    #: O que volta em dinheiro, esse sim mora aqui: é o preço com o desconto da venda já
    #: rateado. Sem ele, devolver uma peça de uma venda com 20% de desconto devolveria
    #: mais do que a cliente pagou, e a diferença sai do bolso da loja em toda troca.
    refund_amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    #: Peça com defeito não volta para a arara — e o custo dela continua sendo custo.
    restock: Mapped[bool] = mapped_column(nullable=False, default=True)

    devolucao: Mapped[SaleReturn] = relationship(
        back_populates="items",
        primaryjoin="SaleReturn.id == SaleReturnItem.return_id",
        foreign_keys="SaleReturnItem.return_id",
    )


class SaleReturnPayment(Base):
    """Como o valor voltou. Espelha `sale_payments` porque a venda pode ter sido mista.

    Uma coluna só não daria conta: quem pagou metade no PIX e metade em dinheiro não pode
    receber tudo de volta em espécie — isso esvazia a gaveta e deixa o caixa negativo sem
    ninguém entender por quê.
    """

    __tablename__ = "sale_return_payments"
    __table_args__ = (
        CheckConstraint(f"method IN ('{_TODAS}')", name="method"),
        CheckConstraint("amount > 0", name="amount"),
        CheckConstraint(
            "(method = 'VALE' AND voucher_id IS NOT NULL)"
            " OR (method <> 'VALE' AND voucher_id IS NULL)",
            name="voucher_consistency",
        ),
        Index("ix_sale_return_payments_return_id", "return_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    return_id: Mapped[int] = mapped_column(
        ForeignKey("sale_returns.id", ondelete="CASCADE"), nullable=False
    )
    method: Mapped[str] = mapped_column(String(10), nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    #: Preenchido quando a devolução virou vale — é este o vale gerado.
    voucher_id: Mapped[int | None] = mapped_column(ForeignKey("vouchers.id", ondelete="RESTRICT"))

    devolucao: Mapped[SaleReturn] = relationship(back_populates="payments")


class Voucher(Base):
    """Vale de troca, ao portador.

    É como a loja resolve troca de verdade: a cliente devolve a blusa hoje e leva outra —
    às vezes na mesma hora, às vezes no sábado. Não existe "modo troca": troca é devolução
    que vira vale, mais uma venda nova paga com o vale. Um caminho só, com rastro.

    O consumo é `UPDATE ... WHERE used_value + :valor <= value RETURNING` — mesma mecânica
    do saldo de estoque. Conferir em memória deixaria o mesmo vale pagar duas vendas
    simultâneas, e o dinheiro dessa segunda venda nunca existiu.
    """

    __tablename__ = "vouchers"
    __table_args__ = (
        CheckConstraint("value > 0", name="value"),
        CheckConstraint("used_value >= 0 AND used_value <= value", name="used_value"),
        Index("ix_vouchers_code", "code", unique=True),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    #: Curto e legível em voz alta: é ditado por telefone e escrito num papel.
    code: Mapped[str] = mapped_column(String(16), nullable=False)
    value: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    #: Uso parcial existe porque a peça nova quase nunca custa o mesmo que a devolvida.
    used_value: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    return_id: Mapped[int | None] = mapped_column(ForeignKey("sale_returns.id", ondelete="RESTRICT"))
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
