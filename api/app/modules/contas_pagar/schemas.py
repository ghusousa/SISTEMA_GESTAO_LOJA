from datetime import date, datetime
from decimal import Decimal
from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel, Field, field_validator, model_validator

from app.modules.contas_pagar.models import FormaPagamentoConta

#: Mais que isto é engano de digitação (360 parcelas de R$ 1,00), não uma compra de coleção.
MAX_PARCELAS = 24


class ParcelaIn(BaseModel):
    vencimento: date
    valor: Decimal = Field(gt=0, decimal_places=2)


class NotaFornecedorIn(BaseModel):
    """A nota do fornecedor: quanto custou a compra e em que datas se paga.

    É a mesma forma na Entrada (opcional, só para quem vê dinheiro) e no lançamento avulso.
    As parcelas vêm prontas da tela — a sugestão 30/60/90 e o centavo que sobra são dela —,
    e o servidor só confere que somam a nota: parcela que não fecha com o total é a nota
    digitada errada, e a diferença viraria dívida que ninguém deve (ou conta esquecida).
    """

    numero: str | None = Field(default=None, max_length=40)
    valor_total: Decimal = Field(gt=0, decimal_places=2)
    parcelas: list[ParcelaIn] = Field(min_length=1, max_length=MAX_PARCELAS)

    @field_validator("numero")
    @classmethod
    def _limpar_numero(cls, v: str | None) -> str | None:
        return (v or "").strip() or None

    @model_validator(mode="after")
    def _parcelas_fecham_com_a_nota(self) -> "NotaFornecedorIn":
        soma = sum((p.valor for p in self.parcelas), Decimal("0"))
        if soma != self.valor_total:
            raise ValueError(f"As parcelas somam {soma:.2f} e a nota é de {self.valor_total:.2f}.")
        return self


class ContaPagarIn(BaseModel):
    """Conta lançada à mão, sem Entrada: a nota antiga, o boleto que chegou depois."""

    client_uuid: UUID = Field(description="Reenvio com a mesma chave não lança de novo.")
    fornecedor: str = Field(min_length=2, max_length=120)
    descricao: str = Field(min_length=2, max_length=160)
    observacao: str | None = Field(default=None, max_length=2000)
    nota: NotaFornecedorIn

    @field_validator("fornecedor", "descricao")
    @classmethod
    def _limpar(cls, v: str) -> str:
        return v.strip()


class ContaPagarUpdate(BaseModel):
    fornecedor: str | None = Field(default=None, min_length=2, max_length=120)
    descricao: str | None = Field(default=None, min_length=2, max_length=160)
    numero_nota: str | None = Field(default=None, max_length=40)
    valor: Decimal | None = Field(default=None, gt=0, decimal_places=2)
    vencimento: date | None = None
    observacao: str | None = Field(default=None, max_length=2000)


class PagamentoContaIn(BaseModel):
    forma: FormaPagamentoConta
    #: Sem ele, hoje no fuso da loja. Pagou ontem e só marcou hoje? Diga o dia.
    pago_em: date | None = None


class SituacaoConta(StrEnum):
    ABERTA = "ABERTA"
    VENCIDA = "VENCIDA"
    PAGA = "PAGA"


class FiltroContas(StrEnum):
    ABERTAS = "abertas"
    VENCIDAS = "vencidas"
    PROXIMOS_7_DIAS = "proximos_7_dias"
    PAGAS = "pagas"
    TODAS = "todas"


class ContaPagarOut(BaseModel):
    id: int
    fornecedor: str
    descricao: str
    numero_nota: str | None = None
    valor: Decimal
    vencimento: date
    parcela: int
    parcelas: int
    situacao: SituacaoConta
    #: Dias até o vencimento (negativo = atrasada), contados no dia da loja.
    dias_para_vencer: int
    paga_em: date | None = None
    forma_pagamento: FormaPagamentoConta | None = None
    entrada_id: int | None = None
    observacao: str | None = None
    ativo: bool = True
    criada_em: datetime


class LancamentoContasOut(BaseModel):
    contas: list[ContaPagarOut]
    valor_total: Decimal


class FaixaOut(BaseModel):
    quantidade: int
    valor: Decimal


class ResumoContasOut(BaseModel):
    """O aviso de quem olha o dinheiro: o que já venceu e o que vence na semana."""

    hoje: date
    vencidas: FaixaOut
    proximos_7_dias: FaixaOut
    em_aberto: FaixaOut
