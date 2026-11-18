from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.modules.catalogo.models import TipoCodigo

TAMANHOS_SUGERIDOS = ["PP", "P", "M", "G", "GG", "XG", "U"]

#: CFOP de quem revende mercadoria comprada de terceiros, dentro do estado. É o caso de
#: quase toda loja de roupa; o contador troca peça a peça quando não for (ex.: 5405, ST).
CFOP_PADRAO = "5102"


def _codigo_fiscal(v: str | None, digitos: int, nome: str) -> str | None:
    """NCM, CEST e CFOP chegam do jeito que vêm no papel do contador: "6109.10.00",
    "28.038.00", "5.102". Guardamos só os dígitos — e só se forem a quantidade certa.
    Vazio é "não informado", nunca um código."""
    if v is None:
        return None
    limpo = "".join(c for c in v if not c.isspace() and c not in ".-/")
    if not limpo:
        return None
    if not limpo.isdigit() or len(limpo) != digitos:
        raise ValueError(f"{nome} tem {digitos} dígitos (ex.: {_EXEMPLO[nome]}).")
    return limpo


_EXEMPLO = {"NCM": "6109.10.00", "CEST": "28.038.00", "CFOP": "5102"}


class DadosFiscaisIn(BaseModel):
    """Campos fiscais do produto (ADR-41). Todos opcionais no cadastro: a loja que não
    emite NFC-e não precisa deles, e a emissão recusa dizendo o que falta."""

    ncm: str | None = Field(default=None, max_length=20)
    cest: str | None = Field(default=None, max_length=20)
    origem: int | None = Field(default=None, ge=0, le=8)
    cfop: str | None = Field(default=None, max_length=10)

    @field_validator("ncm")
    @classmethod
    def _ncm(cls, v: str | None) -> str | None:
        return _codigo_fiscal(v, 8, "NCM")

    @field_validator("cest")
    @classmethod
    def _cest(cls, v: str | None) -> str | None:
        return _codigo_fiscal(v, 7, "CEST")

    @field_validator("cfop")
    @classmethod
    def _cfop(cls, v: str | None) -> str | None:
        return _codigo_fiscal(v, 4, "CFOP")


# ---------------------------------------------------------------- categorias
class CategoriaIn(BaseModel):
    nome: str = Field(min_length=2, max_length=80)

    @field_validator("nome")
    @classmethod
    def _limpar(cls, v: str) -> str:
        return v.strip()


class CategoriaOut(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: int
    nome: str = Field(validation_alias="name")
    criada_em: datetime = Field(validation_alias="created_at")


# ---------------------------------------------------------------- variantes
class VarianteIn(BaseModel):
    """Uma peça concreta da grade. `codigo_barras` vazio faz o sistema gerar um código interno."""

    tamanho: str = Field(min_length=1, max_length=20)
    cor: str = Field(default="Única", min_length=1, max_length=40)
    codigo_barras: str | None = Field(default=None, max_length=32)
    preco_custo: Decimal = Field(ge=0, decimal_places=2)
    preco_venda: Decimal = Field(gt=0, decimal_places=2)
    estoque_minimo: int = Field(default=0, ge=0)

    @field_validator("tamanho", "cor")
    @classmethod
    def _limpar(cls, v: str) -> str:
        return v.strip()

    @field_validator("codigo_barras")
    @classmethod
    def _limpar_codigo(cls, v: str | None) -> str | None:
        if v is None:
            return None
        limpo = v.strip()
        return limpo or None


class VarianteUpdate(BaseModel):
    tamanho: str | None = Field(default=None, min_length=1, max_length=20)
    cor: str | None = Field(default=None, min_length=1, max_length=40)
    codigo_barras: str | None = Field(default=None, min_length=1, max_length=32)
    preco_custo: Decimal | None = Field(default=None, ge=0, decimal_places=2)
    preco_venda: Decimal | None = Field(default=None, gt=0, decimal_places=2)
    estoque_minimo: int | None = Field(default=None, ge=0)


class VarianteOut(BaseModel):
    """Resposta para VENDEDOR: sem preço de custo (ADR-5 — o papel é filtrado no servidor)."""

    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: int
    produto_id: int = Field(validation_alias="product_id")
    #: Nome do produto. Vem preenchido pelo service: sem ele a busca por nome devolveria
    #: uma lista de tamanhos e cores sem dizer de QUE peça.
    produto: str = ""
    tamanho: str = Field(validation_alias="size")
    cor: str = Field(validation_alias="color")
    codigo_barras: str = Field(validation_alias="barcode")
    tipo_codigo: TipoCodigo = Field(validation_alias="barcode_type")
    preco_venda: Decimal = Field(validation_alias="sale_price")
    estoque_minimo: int = Field(validation_alias="min_stock")
    saldo: int = 0


class VarianteAdminOut(VarianteOut):
    preco_custo: Decimal = Field(validation_alias="cost_price")


# ---------------------------------------------------------------- produtos
class ProdutoIn(DadosFiscaisIn):
    categoria_id: int
    nome: str = Field(min_length=2, max_length=120)
    descricao: str | None = Field(default=None, max_length=2000)
    variantes: list[VarianteIn] = Field(min_length=1)

    @field_validator("nome")
    @classmethod
    def _limpar(cls, v: str) -> str:
        return v.strip()

    @field_validator("variantes")
    @classmethod
    def _sem_grade_repetida(cls, v: list[VarianteIn]) -> list[VarianteIn]:
        combos = [(i.tamanho.lower(), i.cor.lower()) for i in v]
        if len(combos) != len(set(combos)):
            raise ValueError("A grade tem tamanho e cor repetidos.")
        codigos = [i.codigo_barras for i in v if i.codigo_barras]
        if len(codigos) != len(set(codigos)):
            raise ValueError("A grade tem códigos de barras repetidos.")
        return v


class ProdutoUpdate(DadosFiscaisIn):
    """Os campos fiscais seguem o `exclude_unset`: mandar `"cest": null` apaga o CEST;
    não mandar a chave deixa como está."""

    categoria_id: int | None = None
    nome: str | None = Field(default=None, min_length=2, max_length=120)
    descricao: str | None = Field(default=None, max_length=2000)


class ProdutoOut(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: int
    nome: str = Field(validation_alias="name")
    descricao: str | None = Field(default=None, validation_alias="description")
    foto_url: str | None = Field(default=None, validation_alias="photo_url")
    categoria_id: int = Field(validation_alias="category_id")
    categoria: str
    ncm: str | None = None
    cest: str | None = None
    origem: int = 0
    cfop: str = CFOP_PADRAO
    variantes: list[VarianteOut] = Field(default_factory=list)
    saldo_total: int = 0


class ProdutoAdminOut(ProdutoOut):
    variantes: list[VarianteAdminOut] = Field(default_factory=list)


# ---------------------------------------------------------------- lookup do PDV
class VarianteLookupOut(BaseModel):
    """O que o PDV precisa saber ao bipar uma etiqueta, em uma única resposta."""

    variante_id: int
    produto_id: int
    produto: str
    categoria: str
    tamanho: str
    cor: str
    codigo_barras: str
    preco_venda: Decimal
    saldo: int
    foto_url: str | None = None


class DadosFiscaisPecaOut(BaseModel):
    """O que a NFC-e precisa saber de cada peça vendida. Lido também de peça excluída do
    catálogo: a venda de ontem continua precisando de nota hoje."""

    variante_id: int
    produto_id: int
    produto: str
    tamanho: str
    cor: str
    codigo_barras: str
    ncm: str | None
    cest: str | None
    origem: int
    cfop: str


class CodigoInternoOut(BaseModel):
    codigo: str
    tipo: TipoCodigo = TipoCodigo.INTERNO
