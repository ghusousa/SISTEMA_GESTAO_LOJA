"""Contratos da configuração da loja.

São DOIS retratos da mesma linha, e a diferença entre eles é o login:

- `ConfiguracaoPublicaOut` é lida SEM login (a tela de entrada precisa do nome antes de
  existir sessão). Leva só o que a porta da loja já mostra: nome, ramo, fuso e as palavras
  da tela.
- `ConfiguracaoOut` acrescenta documento, telefone e endereço, e exige sessão. Para MEI ou
  para quem vende em casa, o "CNPJ ou CPF" é o CPF do dono e o endereço é o de casa dele:
  deixar isso aberto a quem digitar a URL era entregar os dois a qualquer um. O recibo
  continua imprimindo — quem imprime está logado.
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


def _vocabulario_out(segmento: str) -> VocabularioOut:
    v = vocabulario(segmento)
    return VocabularioOut(
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
    )


class ConfiguracaoPublicaOut(BaseModel):
    """O que a porta da loja mostra a quem ainda não entrou. Nada de contato nem documento."""

    model_config = ConfigDict(from_attributes=True)

    nome: str
    segmento: str
    #: O fuso da loja atravessa o fio porque as telas precisam dele para formatar hora.
    #: Sem isto, o navegador formata no fuso de quem OLHA — e a venda das 22h43 de 23/08
    #: era impressa como "24/08 22:43", um instante que nunca existiu.
    timezone: str
    #: Derivado do segmento — a tela nunca precisa saber traduzir sozinha.
    vocabulario: VocabularioOut
    #: Esta é a demonstração que sobe com a loja (ADR-46)? As telas põem a faixa "dados
    #: fictícios" no topo: a demo mora no mesmo domínio da loja, e uma venda de verdade
    #: lançada nela por engano seria uma venda perdida. Vem da config da máquina, não do
    #: banco: quem decide é o contêiner (LOJA_DEMONSTRACAO), não quem está logado. Na
    #: Vercel é falso — lá nada muda (ADR-42).
    demonstracao: bool = False
    #: Este servidor manda o push do chamado do leitor (`NOTIFICACOES_PUSH=expo`, ADR-47)? O
    #: app só pede a permissão de notificação (e só manda o token) quando é true: ninguém vê
    #: um pedido de notificação que não vai funcionar. Desligado, o chamado chega ao app
    #: aberto. Vem da config da máquina, como `demonstracao`; servidor antigo não manda o
    #: campo, e o app trata ausente como false.
    notificacoes_push: bool = False

    @classmethod
    def de_modelo(cls, config) -> "ConfiguracaoPublicaOut":  # noqa: ANN001
        return cls(
            nome=config.nome,
            segmento=config.segmento,
            timezone=settings.timezone_loja,
            vocabulario=_vocabulario_out(config.segmento),
            demonstracao=settings.demonstracao,
            notificacoes_push=settings.notificacoes_push == "expo",
        )


class ConfiguracaoOut(ConfiguracaoPublicaOut):
    """A configuração inteira, para quem está logado: o recibo imprime estes três campos."""

    documento: str | None = None
    telefone: str | None = None
    endereco: str | None = None
    #: Dados fiscais da NFC-e (ADR-41). Saem para qualquer logado: estão impressos em toda
    #: nota que a loja emite. A credencial do emissor NUNCA passa por aqui — mora no .env.
    regime_tributario: int | None = None
    inscricao_estadual: str | None = None
    serie_nfce: int = 1

    @classmethod
    def de_modelo(cls, config) -> "ConfiguracaoOut":  # noqa: ANN001
        return cls(
            nome=config.nome,
            segmento=config.segmento,
            timezone=settings.timezone_loja,
            documento=config.documento,
            telefone=config.telefone,
            endereco=config.endereco,
            regime_tributario=config.regime_tributario,
            inscricao_estadual=config.inscricao_estadual,
            serie_nfce=config.serie_nfce,
            vocabulario=_vocabulario_out(config.segmento),
            demonstracao=settings.demonstracao,
            notificacoes_push=settings.notificacoes_push == "expo",
        )


class ConfiguracaoUpdate(BaseModel):
    """Tudo opcional: mudar só o telefone não deve exigir reenviar o nome."""

    nome: str | None = Field(default=None, min_length=1, max_length=120)
    segmento: Segmento | None = None
    documento: str | None = Field(default=None, max_length=24)
    telefone: str | None = Field(default=None, max_length=32)
    endereco: str | None = Field(default=None, max_length=200)
    #: 1 = Simples Nacional · 2 = Simples, excesso de sublimite · 3 = Regime Normal.
    regime_tributario: int | None = Field(default=None, ge=1, le=3)
    inscricao_estadual: str | None = Field(default=None, max_length=30)
    serie_nfce: int | None = Field(default=None, ge=0, le=889)

    @field_validator("inscricao_estadual")
    @classmethod
    def _ie_so_digitos(cls, v: str | None) -> str | None:
        # Vem como está no cartão do CNPJ ("110.042.490.114"); guardamos os dígitos.
        if v is None:
            return None
        limpo = "".join(c for c in v if not c.isspace() and c not in ".-/")
        if not limpo:
            return None
        if not limpo.isdigit() or not 2 <= len(limpo) <= 14:
            raise ValueError("A inscrição estadual tem só números (até 14 dígitos).")
        return limpo

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
