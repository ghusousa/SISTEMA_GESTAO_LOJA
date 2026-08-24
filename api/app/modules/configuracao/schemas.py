"""Contratos da configuração da loja.

`ConfiguracaoOut` é lida SEM login (a tela de login precisa do nome antes de existir
sessão), então ela carrega só o que pode ficar na porta da loja: nome, ramo e as palavras
da tela. Contato e documento saem junto porque vão impressos no recibo, que é papel
público de qualquer forma.
"""

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core.config import settings
from app.core.segmentos import Segmento, vocabulario


class VocabularioOut(BaseModel):
    """As palavras que a tela usa. Vêm prontas do servidor para web e app não divergirem."""

    icone: str
    exemplo_produto: str
    item: str
    itens: str
    artigo: str
    eixo1: str
    eixo1_exemplos: str
    eixo1_rapidos: list[str]
    eixo2: str
    eixo2_exemplos: str


class SegmentoOut(BaseModel):
    """Uma opção da lista de ramos, para a tela de configuração montar o seletor."""

    valor: str
    rotulo: str
    eixo1: str
    eixo2: str


class ConfiguracaoOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    nome: str
    segmento: str
    #: O fuso da loja atravessa o fio porque as telas precisam dele para formatar hora.
    #: Sem isto, o navegador formata no fuso de quem OLHA — e a venda das 22h43 de 23/08
    #: era impressa como "24/08 22:43", um instante que nunca existiu.
    timezone: str
    documento: str | None = None
    telefone: str | None = None
    endereco: str | None = None
    #: Derivado do segmento — a tela nunca precisa saber traduzir sozinha.
    vocabulario: VocabularioOut

    @classmethod
    def de_modelo(cls, config) -> "ConfiguracaoOut":  # noqa: ANN001
        v = vocabulario(config.segmento)
        return cls(
            nome=config.nome,
            segmento=config.segmento,
            timezone=settings.timezone_loja,
            documento=config.documento,
            telefone=config.telefone,
            endereco=config.endereco,
            vocabulario=VocabularioOut(
                icone=v.icone,
                exemplo_produto=v.exemplo_produto,
                item=v.item,
                itens=v.itens,
                artigo=v.artigo,
                eixo1=v.eixo1,
                eixo1_exemplos=v.eixo1_exemplos,
                eixo1_rapidos=list(v.eixo1_rapidos),
                eixo2=v.eixo2,
                eixo2_exemplos=v.eixo2_exemplos,
            ),
        )


class ConfiguracaoUpdate(BaseModel):
    """Tudo opcional: mudar só o telefone não deve exigir reenviar o nome."""

    nome: str | None = Field(default=None, min_length=1, max_length=120)
    segmento: Segmento | None = None
    documento: str | None = Field(default=None, max_length=24)
    telefone: str | None = Field(default=None, max_length=32)
    endereco: str | None = Field(default=None, max_length=200)

    @field_validator("nome")
    @classmethod
    def _nome_sem_espaco_solto(cls, v: str | None) -> str | None:
        if v is None:
            return None
        limpo = v.strip()
        if not limpo:
            raise ValueError("O nome da loja não pode ser vazio.")
        return limpo

    @field_validator("documento", "telefone", "endereco")
    @classmethod
    def _vazio_vira_nulo(cls, v: str | None) -> str | None:
        # Campo apagado na tela chega como "" — guardar string vazia faria o recibo
        # imprimir uma linha em branco no lugar de não imprimir nada.
        if v is None:
            return None
        return v.strip() or None
