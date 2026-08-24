"""O que é "o dia" para esta loja — num lugar só, porque já custou caro ter quatro.

Às 22h43 de 23/08 em São Paulo o relógio UTC já marca 01h43 de 24/08. Toda coluna de
instante do sistema é `TIMESTAMPTZ` gravada em UTC; toda tela de filtro manda um DIA
("2026-08-23"), que é o que sai de um `<input type="date">`. Traduzir um no outro é o
trabalho deste arquivo — e é exatamente onde o sistema já errou de verdade: a tela de
Vendas recebia o dia como `datetime`, o FastAPI o convertia em meia-noite do COMEÇO do
dia, e ninguém punha fuso em lugar nenhum. O dono filtrou "De 16/08 Até 23/08" às 22h43
do dia 23 e viu ZERO vendas: o dia 23 inteiro ficava de fora (meia-noite do começo) e o
valor ingênuo era lido como UTC, comendo mais três horas de todo dia 22.

Há DOIS jeitos certos de fazer essa tradução, e os dois moram aqui:

1. Recortar a JANELA — `inicio_do_dia` / `fim_exclusivo_do_dia`. Vira o dia da loja em
   dois instantes COM fuso e compara com a coluna crua. É o que serve para listagem
   ordenada por tempo (vendas, extrato de estoque, auditoria): a comparação cai direto
   nos índices de `sold_at` / `created_at`.
2. Converter a COLUNA — `dia_da_loja`. Traz o instante do banco para o dia da loja com
   `AT TIME ZONE` e compara dia com dia. É o que serve para agregação por dia (caixa,
   relatórios), e existem índices funcionais casando com essa expressão exata
   (`ix_sales_business_date`, `ix_sale_returns_business_date`).

Escolha um por consulta; não misture, e não invente um terceiro.

E NUNCA aplique nada disto a coluna `Date` — `expenses.expense_date` é dia de calendário
digitado por gente, não instante. Convertê-lo faria o Postgres promovê-lo a timestamp
antes de comparar, e toda despesa andaria um dia para trás.
"""

from datetime import UTC, date, datetime, time, timedelta

from sqlalchemy import func

from app.core.config import settings


def hoje_na_loja() -> date:
    """O dia de hoje no balcão, não no relógio do servidor.

    `date.today()` dentro do contêiner (que roda em UTC) já virou o dia seguinte às 21h de
    São Paulo: a consulta devolve um caixa vazio numa loja que vendeu a noite toda.
    """
    return datetime.now(UTC).astimezone(settings.tz_loja).date()


def inicio_do_dia(dia: date | None) -> datetime | None:
    """00:00:00 do dia NO FUSO DA LOJA, como instante — comparar com `>=`.

    Devolve datetime AWARE de propósito. Um datetime ingênuo chega ao asyncpg sem fuso e o
    driver o converte assumindo o fuso da MÁQUINA: no contêiner (UTC) o corte escorrega 3
    horas. Pior: escorrega em silêncio, e sumiria por acidente se alguém pusesse
    `TZ=America/Sao_Paulo` na VPS — voltando na próxima reinstalação, sem nada de errado
    no log.
    """
    if dia is None:
        return None
    return datetime.combine(dia, time.min, tzinfo=settings.tz_loja)


def fim_exclusivo_do_dia(dia: date | None) -> datetime | None:
    """00:00:00 do dia SEGUINTE no fuso da loja. Fim EXCLUSIVO: comparar com `<`, nunca `<=`.

    Quem chama passa o ÚLTIMO DIA QUE A PESSOA PEDIU ("Até 23/08"); somar o dia é serviço
    daqui, não da tela.

    O intervalo é meio-aberto `[inicio, fim)` porque é a única forma que não depende da
    precisão do timestamp. A tentação é devolver 23:59:59.999999 (`time.max`) e comparar
    com `<=` — funciona enquanto a coluna guardar microssegundo, mas basta um valor
    arredondado ao segundo para esse instante virar a meia-noite seguinte e o filtro passar
    a incluir o começo do dia de amanhã. Meio-aberto não tem borda para escorregar: o
    último instante do dia entra, o primeiro do dia seguinte não.

    (Se o horário de verão voltar ao Brasil, esta é a linha a revisar: a transição daqui
    era à MEIA-NOITE, e meia-noite é justamente o instante que este helper constrói.)
    """
    if dia is None:
        return None
    return datetime.combine(dia + timedelta(days=1), time.min, tzinfo=settings.tz_loja)


def dia_da_loja(coluna):  # noqa: ANN001, ANN201 — expressão SQL, não valor Python
    """`date(coluna AT TIME ZONE 'America/Sao_Paulo')`: o instante do banco vira o dia do comércio.

    O outro lado da moeda: em vez de esticar o filtro até o UTC, traz a coluna para o fuso
    da loja. É o que caixa e relatórios usam para agrupar e somar POR DIA, e é a forma
    indexável — `ix_sales_business_date` e `ix_sale_returns_business_date` são índices
    sobre exatamente esta expressão. Só para coluna de INSTANTE (`TIMESTAMPTZ`).
    """
    return func.date(func.timezone(settings.timezone_loja, coluna))
