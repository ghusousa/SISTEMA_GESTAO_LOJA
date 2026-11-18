# Capturas da App Store

As 10 imagens da ficha do app na Apple, com o **app de verdade**: o export web do próprio
app, numa tela de iPhone, falando com uma API local cheia dos dados de mentira da seed (a
mesma "Loja Tria" do servidor de demonstração). Nada é desenhado à mão — mudou a tela,
roda de novo.

```bash
mobile/publicar/capturas/gerar.sh               # do zero (~3 min)
mobile/publicar/capturas/gerar.sh --sem-build   # reaproveita o mobile/dist-web
```

Saem em `media/app-store/`, com os mesmos nomes e a mesma ordem nas duas pastas:

| Pasta | Tamanho | Para quê |
|---|---|---|
| `iphone-6.5/` | 1242 × 2688 | conjunto obrigatório (slot de 6,5") |
| `iphone-6.9/` | 1320 × 2868 | extra (slot de 6,7"/6,9") |

PNG RGB **sem canal alfa** (a Apple recusa transparência). O `compor.mjs` confere cada
arquivo nos bytes — tamanho exato, tipo de cor 2, os 10 nomes nas duas pastas — e o gerador
sai com erro se algo estiver fora. **Confira cada imagem com os olhos antes do commit.**

## O que precisa

- Postgres local (`createdb`, `dropdb`, `psql`); o banco de teste (`loja_capturas`) é
  apagado e recriado a cada rodada.
- `api/.venv` com as dependências da API (ou `CAPTURAS_PYTHON=/caminho/do/python`).
- `mobile/node_modules` (`npm ci` dentro de `mobile/`), para o export web.
- Playwright com o Chromium (`npm i -g playwright && npx playwright install chromium`).
- A fonte Inter, com a Inter Display (Ubuntu: `fonts-inter`; confira com `fc-list | grep Inter`).

Portas 8131 (API) e 8092 (app) livres, ou `CAPTURAS_PORTA_API`/`CAPTURAS_PORTA_WEB`. Todas as
variáveis: `gerar.sh --help`.

## Como funciona

| Arquivo | Faz |
|---|---|
| `gerar.sh` | banco novo, migrations, API local, a seed, nome "Loja Tria" e ramo roupas pela rota de configuração, o export web servido por `mobile/servir-web.mjs`; chama os dois abaixo e derruba tudo no fim |
| `gerar.mjs` | entra pela tela de login com a dona de teste e fotografa cada cena (`.brutas/`, 428 × 926 pt a 3x) |
| `cenas.mjs` | as 10 cenas: título, subtítulo e como cada tela é preparada — sempre pelo caminho de uma pessoa (bipar pelo "Digitar código", buscar pelo nome, cobrar, abrir a condicional) |
| `compor.mjs` | a arte: fundo da marca, título, subtítulo, o app num celular com barra de status e indicador de início. `node compor.mjs` refaz só a arte; `--conferir` só confere |
| `png.mjs` | lê e grava PNG em Node puro (zlib): é ele que garante o RGB sem alfa |

`ROTEIRO` (em `cenas.mjs`) é a ordem em que as fotos saem: o fiado e a condicional antes,
para o caixa e o financeiro já contarem com eles, e a venda do PDV atravessando três cenas
(carrinho → cobrança → recibo). Antes de tudo a dona cadastra as taxas da maquininha, para o
financeiro descontar taxa de verdade.

A foto só sai com a tela parada: nada girando, nenhum "Carregando…", a API sem resposta
pendente e duas fotos seguidas iguais. Texto cortado com reticências é erro, e texto embaixo
do indicador de início faz a lista rolar o mínimo para sair dali.

### O que a foto ajusta, e por quê

Tudo para o navegador mostrar o que o iPhone mostra — nada muda dado nem comportamento:

- as áreas seguras do iPhone (47 pt em cima, 34 pt embaixo) são declaradas ao navegador, e o
  app se arruma como no aparelho; a barra de status e o indicador de início são da moldura;
- a barra de abas ganha a área segura de baixo, que o `tabBarStyle` de altura fixa do app
  não soma (no iPhone com Face ID os rótulos encostariam no indicador);
- rótulo de aba sem encolher, campo de texto do tamanho do conteúdo (como o `TextInput`), sem
  barra de rolagem, sem cursor piscando.

## Mudou uma tela?

Rode o `gerar.sh` de novo e confira as 20 imagens. Se a mudança quebrou um passo (um botão
trocou de nome, por exemplo), o gerador para dizendo a cena e deixa a foto da hora do erro em
`.brutas/erro-<cena>.png`; o ajuste é em `cenas.mjs`. Texto novo de título ou subtítulo
precisa caber: título em duas linhas (o `\n`), subtítulo em uma — o `compor.mjs` recusa o que
vazar. Para refazer só algumas: `CAPTURAS_SO=01-vender,07-caixa gerar.sh` (o roteiro anda
inteiro do mesmo jeito; só essas imagens são trocadas). Para comparar antes de trocar, gere
noutra pasta: `CAPTURAS_DESTINO=/outra/pasta gerar.sh` — as commitadas ficam como estão.

Mudou título, subtítulo, nome ou ordem de uma cena? Atualize também as tabelas de
`media/app-store/FASE-6-COLAR-NA-APPLE.md` e do §8 de `docs/LOJAS-DE-APP.md` (e a legenda em
inglês de `publicar/revisao/guia.mjs`). O CI confere as imagens commitadas contra as cenas
(`compor.mjs --conferir`) e as sobe na Apple de mentira (`publicar/teste/rodar.mjs --reais`),
mas não roda o gerador: ele pede Postgres, Chromium e as fontes.

O guia PDF do revisor da Apple (`publicar/revisao/app-review-guide.pdf`) leva os prints de
6,5": o `gerar.sh` o refaz no fim (`revisao/gerar-guia.mjs`), menos com `CAPTURAS_DESTINO`.
Faça commit dele e do `app-review-guide.entradas.json` junto com as imagens — o CI e o
`--enviar` do publicador recusam o guia de prints velhos.

A seed lança as despesas do mês inteiro de uma vez: na primeira quinzena o "Resultado do
mês" ainda sai negativo, e a cena 03 para avisando. Rode na segunda quinzena (ou
`CAPTURAS_ACEITAR_PREJUIZO=1`, sabendo o que vai na foto).
