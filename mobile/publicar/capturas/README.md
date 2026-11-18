# Capturas da App Store

As 10 imagens da ficha do app na Apple, com o **código das telas do app**: o export web do
próprio app, numa tela de iPhone, falando com uma API local cheia dos dados de mentira da seed
(a mesma "Loja Tria" do servidor de demonstração). Nada é desenhado à mão — mudou a tela,
roda de novo.

**O que é do navegador, e não do iPhone:** a navegação. O cabeçalho das fotos é o do export
web (seta "←", título à esquerda, ~63 pt); no iPhone ele é o nativo (título centralizado,
"‹ Voltar", 44 pt). E o "Cobrar" (02) abre em tela cheia, enquanto no iPhone ele é uma folha
por cima do PDV. O conteúdo de cada tela é o do app; para fotos com o cabeçalho nativo, só
fotografando num aparelho ou simulador (a sessão do BrowserStack da gravação serve).

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
| `cenas.mjs` | as 10 cenas: título, subtítulo, o que tem de aparecer inteiro (`mostrar`) e como cada tela é preparada — sempre pelo caminho de uma pessoa (bipar pelo "Digitar código", buscar pelo nome, cobrar, abrir a condicional) |
| `quadro.mjs` | o enquadramento: nada cortado nas bordas do que se vê (regras abaixo) |
| `compor.mjs` | a arte: fundo da marca, título, subtítulo, o app num celular com barra de status e indicador de início. `node compor.mjs` refaz só a arte; `--conferir` só confere |
| `png.mjs` | lê e grava PNG em Node puro (zlib): é ele que garante o RGB sem alfa |

`ROTEIRO` (em `cenas.mjs`) é a ordem em que as fotos saem: o fiado e a condicional antes,
para o caixa e o financeiro já contarem com eles, e a venda do PDV atravessando três cenas
(carrinho → cobrança → recibo). Antes de tudo a dona cadastra as taxas da maquininha, para o
financeiro descontar taxa de verdade.

A foto só sai com a tela parada: nada girando, nenhum "Carregando…", a API sem resposta
pendente e duas fotos seguidas iguais. Texto cortado com reticências é erro.

### Nada cortado (`quadro.mjs`)

Antes da foto, a lista que rola (a da área sob o centro da tela) é enquadrada: a partir de
onde a cena a deixou — até uma tela de distância —, rola o mínimo até que

- nenhuma linha de texto, campo, ícone ou imagem fique cortada pela borda de cima ou de
  baixo, nem embaixo do indicador de início (os 28 pt de baixo);
- nenhum cartão (o que tem fundo, borda ou sombra) fique cortado em cima, colado na borda de
  cima com a lista rolada, ou terminando embaixo do indicador; cartão cortado embaixo — a
  lista continuando — mostra ao menos uma linha inteira (fatia vazia, como uma fileira de
  teclas sob o rodapé, é defeito; só na faixa do indicador, sem texto, é a lista passando por
  baixo dele, como no iPhone);
- o botão flutuante (o + dos produtos) não cubra texto nenhum;
- o que a cena lista em `mostrar` apareça inteiro.

Fora da lista nada se move, e nada pode ficar embaixo da barra de status nem do indicador.
Sem posição assim, a cena para dizendo o que cortou onde ela deixou a tela, na posição que
chega mais perto, no topo e no fim da lista — o ajuste é na cena. Foi assim que o caixa
passou a sair com a gaveta batendo (a linha "Faltou" deixa a tela mais alta que o iPhone), a
condicional antes de escolher a forma de pagamento, e o estoque e os produtos pela busca (as
blusas, as calças): a lista inteira deixava fatia de cartão em cima da barra de abas, e o
botão + flutua sempre em cima de algum preço — o vão entre dois cartões é menor que ele.

### O que a foto ajusta, e por quê

Tudo para o navegador mostrar o que o iPhone mostra — nada muda dado nem comportamento:

- as áreas seguras do iPhone (47 pt em cima, 34 pt embaixo) são declaradas ao navegador, e o
  app se arruma como no aparelho — a barra de abas e os rodapés se afastam do indicador de
  início sozinhos (`lib/areaSegura.ts`); se a barra de abas deixar de fazê-lo, ou um rótulo
  dela ficar espremido, o gerador para em vez de retocar a foto;
- a barra de status e o indicador de início são da moldura. A hora da barra é a da foto, no
  fuso da loja: a mesma do recibo e da condicional que a cena acabou de fazer (o gerador a
  anota em `.brutas/NN-nome.json`). Fora das 8h–22h o `gerar.sh` avisa: a venda da foto sai
  com aquela hora. A COR da barra é a que o app pede para aquela tela (`lib/barraDeStatus.ts`:
  escura na entrada, no servidor e em Vender; clara sob o cabeçalho azul), anotada junto: se
  ela sumir sobre o fundo da foto, o `compor.mjs` para — a arte não corrige o que o iPhone
  mostra;
- campo de texto do tamanho do conteúdo (como o `TextInput`), sem barra de rolagem, sem
  cursor piscando.

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
