#!/usr/bin/env node
/**
 * Fotografa o app de verdade — o export web do próprio app, falando com a API local de
 * teste — cena por cena (`cenas.mjs`), numa tela do tamanho de um iPhone.
 *
 * Quem sobe API, banco, dados e o export é o `gerar.sh`; este arquivo só entra pela tela
 * de login com a dona de teste da seed e segue o `ROTEIRO`. Cada foto sai em
 * `.brutas/NN-nome.png` (428 × 926 pt a 3x), e o `compor.mjs` monta a arte em cima.
 *
 * O que é diferente do navegador comum, e por quê (tudo para parecer o que o iPhone mostra):
 *   - as áreas seguras do iPhone, declaradas pelo DevTools: 47 pt em cima (barra de status)
 *     e 34 pt embaixo (indicador de início). O app as lê como no aparelho, e a moldura
 *     desenha a barra e o indicador por cima;
 *   - a barra de abas com a área segura de baixo somada à altura, se o app não a somou: o
 *     `tabBarStyle` com altura fixa ignora o indicador de início, e no iPhone com Face ID os
 *     rótulos encostam nele. A foto mostra a barra como ela deve ficar;
 *   - sem barra de rolagem e sem cursor piscando (nenhum dos dois aparece parado no iPhone);
 *   - o rótulo das abas sem encolher: no navegador o flex corta a parte de baixo das letras,
 *     no iPhone o texto sai inteiro;
 *   - campo de texto do tamanho do que tem dentro, como o TextInput do iPhone: o <input> do
 *     navegador nasce com ~20 letras de largura e espremia o nome da peça ao lado dele.
 *
 * Variáveis (o gerar.sh preenche): CAPTURAS_WEB, CAPTURAS_API, CAPTURAS_EMAIL,
 * CAPTURAS_SENHA, CAPTURAS_LOJA, CAPTURAS_BRUTAS. CAPTURAS_SO=01-vender,02-cobrar
 * fotografa só essas (o roteiro anda inteiro do mesmo jeito, para o estado ser o mesmo).
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CENAS, ROTEIRO, prepararLoja } from './cenas.mjs';
import { APARELHO } from './compor.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const AQUI = dirname(fileURLToPath(import.meta.url));
const WEB = (process.env.CAPTURAS_WEB || 'http://127.0.0.1:8092').replace(/\/$/, '');
const API = (process.env.CAPTURAS_API || 'http://127.0.0.1:8131').replace(/\/$/, '');
const EMAIL = process.env.CAPTURAS_EMAIL || 'dona@loja.com';
const SENHA = process.env.CAPTURAS_SENHA || 'senha12345';
const LOJA = process.env.CAPTURAS_LOJA || 'Loja Tria';
const BRUTAS = process.env.CAPTURAS_BRUTAS || join(AQUI, '.brutas');
const SO = (process.env.CAPTURAS_SO || '').split(',').filter(Boolean);

/** Ajustes só de fotografia (ver o cabeçalho). Nada aqui muda dado ou comportamento. */
const CSS_DA_FOTO = `
  a[role="tab"] div[dir="auto"] { flex-shrink: 0 !important; }
  input, textarea { field-sizing: content; }
  * { scrollbar-width: none !important; }
  *::-webkit-scrollbar { display: none !important; }
  input, textarea { caret-color: transparent !important; }
  *:focus, *:focus-visible { outline: none !important; }
`;

/** Texto que denuncia tela ainda trabalhando. A foto só sai sem nenhum deles à vista. */
const TEXTOS_DE_ESPERA = ['Carregando', 'Abrindo a loja', 'Consultando', 'Sem conexão', 'Enviando…'];

function falhar(mensagem) {
  process.stderr.write(`\n✗ ${mensagem}\n`);
  process.exit(1);
}

async function entrarNaApi() {
  const resposta = await fetch(`${API}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, senha: SENHA }),
  });
  if (!resposta.ok) falhar(`a API local recusou o login da conta de teste (${resposta.status}).`);
  return (await resposta.json()).access_token;
}

/** Tudo o que uma cena pode fazer na tela — sempre pelo caminho que uma pessoa usaria. */
function criarApp(page, token, pendentes) {
  const visiveis = (localizador) => localizador.filter({ visible: true });

  const app = {
    page,

    /** A peça daquele produto que mais tem saldo — como olhar a arara antes de pegar. */
    async peca(produto) {
      const url = `${API}/api/v1/variantes?q=${encodeURIComponent(produto)}&size=50`;
      const resposta = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!resposta.ok) throw new Error(`consulta de "${produto}" falhou (${resposta.status})`);
      const achadas = (await resposta.json()).items.filter((v) => v.produto === produto && v.saldo > 0);
      if (!achadas.length) throw new Error(`nenhuma peça de "${produto}" com saldo — a seed mudou?`);
      return achadas.sort((a, b) => b.saldo - a.saldo || a.id - b.id)[0];
    },

    /** Vai para uma aba; se uma tela estiver empilhada por cima, volta até as abas. */
    async aba(nome) {
      for (let vez = 0; vez < 6; vez += 1) {
        // O nome acessível da aba leva o glifo do ícone junto: acha pela legenda.
        const aba = page.getByRole('tab').filter({ has: page.getByText(nome, { exact: true }) });
        if (await aba.isVisible()) {
          await aba.click();
          return;
        }
        await page.goBack();
        await page.waitForTimeout(500);
      }
      throw new Error(`a aba "${nome}" não apareceu`);
    },

    async tocar(texto) {
      await visiveis(page.getByText(texto, { exact: true })).last().click();
    },

    async botao(nome) {
      await visiveis(page.getByRole('button', { name: nome, exact: true })).last().click();
    },

    /**
     * Escreve num campo e confere que ficou: modal que acabou de abrir zera os campos no
     * primeiro efeito, e o que foi digitado antes dele some.
     */
    async digitar(placeholder, valor) {
      const campo = visiveis(page.getByPlaceholder(placeholder, { exact: true })).last();
      for (let vez = 0; vez < 4; vez += 1) {
        await campo.fill(valor);
        await page.waitForTimeout(350);
        if ((await campo.inputValue()) === valor) return;
      }
      throw new Error(`o campo "${placeholder}" não guardou o que foi digitado`);
    },

    /** Teclado de caixa do app: os dígitos entram pela direita ("100,00" = 1-0-0-0-0). */
    async teclar(valor) {
      for (const digito of valor.replace(/\D/g, '')) {
        await visiveis(page.getByRole('button', { name: digito, exact: true })).last().click();
      }
    },

    async esperarTexto(texto, { some = false, timeout = 20_000 } = {}) {
      const alvo = visiveis(page.getByText(texto)).first();
      await alvo.waitFor({ state: some ? 'hidden' : 'visible', timeout });
    },

    /** "Digitar código": a saída do balcão para a etiqueta que a câmera não lê. */
    async digitarCodigo(codigo) {
      await app.botao('Digitar código');
      await app.digitar('7891234567895', codigo);
      await page.keyboard.press('Enter');
    },

    /** Busca pelo nome e toca na linha do tamanho e da cor certos. */
    async buscarPeca(peca, { botao }) {
      await app.botao(botao);
      await app.digitar('camiseta preta', peca.produto);
      const linha = visiveis(page.getByRole('button'))
        .filter({ has: page.getByText(peca.produto, { exact: true }) })
        .filter({ has: page.getByText(`${peca.tamanho} · ${peca.cor}`, { exact: true }) })
        .first();
      await linha.click();
      await linha.waitFor({ state: 'hidden' });
    },

    /** Fechamento da condicional: quantas de cada peça voltaram, achando a linha pelo nome. */
    async responderVolta(voltaram) {
      const campos = visiveis(page.getByPlaceholder('?', { exact: true }));
      const pecas = await campos.evaluateAll(
        (els, nomes) =>
          els.map((el) => {
            for (let no = el.parentElement; no; no = no.parentElement) {
              const achados = nomes.filter((n) => no.textContent.includes(n));
              if (achados.length) return achados.length === 1 ? achados[0] : null;
            }
            return null;
          }),
        Object.keys(voltaram),
      );
      if (pecas.length !== Object.keys(voltaram).length || pecas.includes(null)) {
        throw new Error(`a condicional não tem as peças esperadas (${pecas.join(', ')})`);
      }
      for (const [i, peca] of pecas.entries()) await campos.nth(i).fill(String(voltaram[peca]));
    },

    /** O campo de uma linha da tela, achado pelo texto da linha (ex.: "Dinheiro na gaveta"). */
    async campoDe(textoDaLinha, placeholder) {
      const campos = visiveis(page.getByPlaceholder(placeholder, { exact: true }));
      const indice = await campos.evaluateAll(
        (els, alvo) =>
          els.findIndex((el) => {
            for (let no = el.parentElement; no; no = no.parentElement) {
              if (no.querySelectorAll('input').length > 1) return false;
              if (no.textContent.includes(alvo)) return true;
            }
            return false;
          }),
        textoDaLinha,
      );
      if (indice < 0) throw new Error(`não achei o campo de "${textoDaLinha}"`);
      return campos.nth(indice);
    },

    /** Tira o foco do campo, como tocar fora dele no iPhone (o teclado desce). */
    async soltarCampo() {
      await page.evaluate(() => document.activeElement?.blur());
    },

    /** As listas voltam ao começo: o clique do Playwright rola até o que tocou. */
    async rolarParaOTopo() {
      await page.evaluate(() => {
        for (const el of document.querySelectorAll('div')) {
          const estilo = getComputedStyle(el);
          if (['auto', 'scroll'].includes(estilo.overflowY) && el.scrollTop > 0) el.scrollTop = 0;
        }
      });
    },

    /** Rola a tela até o fim, como o dedo que desce para o botão de concluir. */
    async rolarAteOFim() {
      await page.evaluate(({ x, y }) => {
        for (let el = document.elementFromPoint(x, y); el; el = el.parentElement) {
          if (['auto', 'scroll'].includes(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1) {
            el.scrollTop = el.scrollHeight;
            return;
          }
        }
      }, { x: APARELHO.largura / 2, y: APARELHO.altura / 2 });
    },

    /**
     * O indicador de início é desenhado por cima da foto, como no iPhone, e a faixa dele
     * (os 28 pt de baixo) é a borda arredondada da tela: texto ali sai cortado ou riscado.
     * Se houver texto visível na faixa, a lista rola o mínimo — para baixo ou para cima,
     * dentro do que a rolagem permite — até a faixa ficar só com fundo.
     */
    async afastarDoIndicador() {
      const { largura, altura } = APARELHO;
      const faixa = { x0: 0, x1: largura, y0: altura - 28, y1: altura };
      const movido = await page.evaluate((z) => {
        const textoNaFaixa = () => {
          const andar = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          for (let no = andar.nextNode(); no; no = andar.nextNode()) {
            const pai = no.parentElement;
            if (!no.textContent.trim() || !pai?.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
            const pedaco = document.createRange();
            pedaco.selectNodeContents(no);
            for (const r of pedaco.getClientRects()) {
              if (r.right <= z.x0 || r.left >= z.x1 || r.bottom <= z.y0 || r.top >= z.y1) continue;
              // Texto cortado pela rolagem ou coberto por um rodapé fixo não aparece: não conta.
              const visto = document.elementFromPoint(
                Math.min(Math.max((r.left + r.right) / 2, z.x0 + 1), z.x1 - 1),
                Math.min(Math.max((r.top + r.bottom) / 2, z.y0 + 1), z.y1 - 1),
              );
              if (visto && (visto === pai || pai.contains(visto) || visto.contains(pai))) return true;
            }
          }
          return false;
        };
        if (!textoNaFaixa()) return 0;
        let rolador = document.elementFromPoint(z.x1 / 2, z.y0 + 1);
        while (rolador && !(['auto', 'scroll'].includes(getComputedStyle(rolador).overflowY) && rolador.scrollHeight > rolador.clientHeight + 1)) {
          rolador = rolador.parentElement;
        }
        if (!rolador) return null;
        const inicio = rolador.scrollTop;
        const maximo = rolador.scrollHeight - rolador.clientHeight;
        for (let passo = 2; passo <= 120; passo += 2) {
          for (const destino of [inicio + passo, inicio - passo]) {
            if (destino < 0 || destino > maximo) continue;
            rolador.scrollTop = destino;
            if (!textoNaFaixa()) return destino - inicio;
          }
        }
        rolador.scrollTop = inicio;
        return null;
      }, faixa);
      if (movido === null) process.stderr.write('  (aviso: ficou texto na faixa do indicador de início)\n');
    },

    /** O gráfico de barras começa no dia mais antigo; arrastado, mostra até hoje. */
    async rolarGraficoAteHoje() {
      const rolados = await page.evaluate(() => {
        let n = 0;
        for (const el of document.querySelectorAll('div')) {
          const estilo = getComputedStyle(el);
          if (['auto', 'scroll'].includes(estilo.overflowX) && el.scrollWidth > el.clientWidth + 2) {
            el.scrollLeft = el.scrollWidth;
            n += 1;
          }
        }
        return n;
      });
      if (!rolados) throw new Error('não achei o gráfico para arrastar');
    },

    /**
     * Espera a tela parar: nada carregando, rede da API quieta e duas fotos seguidas iguais.
     * Devolve a última foto — a que vale.
     */
    async assentar({ timeout = 30_000 } = {}) {
      const limite = Date.now() + timeout;
      await page.mouse.move(APARELHO.largura / 2, 2);
      for (;;) {
        const motivo = await page.evaluate((textos) => {
          const naTela = (el) => {
            if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
          };
          for (const el of document.querySelectorAll('[role="progressbar"]')) {
            if (naTela(el)) return 'indicador de carregamento girando';
          }
          const andar = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          for (let no = andar.nextNode(); no; no = andar.nextNode()) {
            const achado = textos.find((t) => no.textContent.includes(t));
            if (achado && no.parentElement && naTela(no.parentElement)) return `"${achado}" na tela`;
          }
          return null;
        }, TEXTOS_DE_ESPERA);
        if (!motivo && pendentes.size === 0) break;
        if (Date.now() > limite) throw new Error(`a tela não assentou: ${motivo ?? 'a API não respondeu'}`);
        await page.waitForTimeout(200);
      }
      let anterior = await page.screenshot({ type: 'png' });
      for (let iguais = 0; iguais < 2; ) {
        if (Date.now() > limite) throw new Error('a tela não parou de mexer');
        await page.waitForTimeout(400);
        const atual = await page.screenshot({ type: 'png' });
        iguais = atual.equals(anterior) ? iguais + 1 : 0;
        anterior = atual;
      }
      return anterior;
    },

    /** Texto cortado com reticências é foto a refazer: devolve o que estiver cortado. */
    async textosCortados() {
      return page.evaluate(() => {
        const cortados = [];
        for (const el of document.querySelectorAll('div[dir="auto"]')) {
          const estilo = getComputedStyle(el);
          if (estilo.textOverflow !== 'ellipsis' || el.scrollWidth <= el.clientWidth + 1) continue;
          if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
          const r = el.getBoundingClientRect();
          if (r.bottom > 0 && r.top < innerHeight) cortados.push(el.textContent);
        }
        return cortados;
      });
    },
  };
  return app;
}

async function principal() {
  const desconhecidas = SO.filter((nome) => !CENAS.some((c) => c.arquivo === nome));
  if (desconhecidas.length) falhar(`cena desconhecida em CAPTURAS_SO: ${desconhecidas.join(', ')}`);
  for (const nome of ROTEIRO) {
    if (!CENAS.some((c) => c.arquivo === nome)) falhar(`o ROTEIRO cita "${nome}", que não está nas CENAS`);
  }
  if (new Set(ROTEIRO).size !== CENAS.length) falhar('o ROTEIRO precisa passar por todas as cenas, uma vez cada');

  // Rodada inteira recomeça as fotos; com CAPTURAS_SO, as outras ficam como estavam.
  if (!SO.length) rmSync(BRUTAS, { recursive: true, force: true });
  mkdirSync(BRUTAS, { recursive: true });
  const token = await entrarNaApi();

  const navegador = await chromium.launch();
  try {
    const contexto = await navegador.newContext({
      viewport: { width: APARELHO.largura, height: APARELHO.altura },
      deviceScaleFactor: APARELHO.escala,
      locale: 'pt-BR',
      timezoneId: 'America/Sao_Paulo',
    });
    await contexto.addInitScript(
      ({ servidor, css }) => {
        // O mesmo lugar onde o app guarda o endereço no navegador (src/api/servidor.ts).
        localStorage.setItem('loja.servidor', servidor);
        const aplicar = () => {
          const estilo = document.createElement('style');
          estilo.textContent = css;
          document.head.appendChild(estilo);
        };
        if (document.head) aplicar();
        else document.addEventListener('DOMContentLoaded', aplicar);
      },
      { servidor: API, css: CSS_DA_FOTO },
    );
    const page = await contexto.newPage();
    const cdp = await contexto.newCDPSession(page);
    const { status: topo, indicador: base } = APARELHO;
    await cdp.send('Emulation.setSafeAreaInsetsOverride', {
      insets: { top: topo, topMax: topo, bottom: base, bottomMax: base, left: 0, leftMax: 0, right: 0, rightMax: 0 },
    });

    const pendentes = new Set();
    page.on('request', (r) => r.url().startsWith(API) && pendentes.add(r));
    page.on('requestfinished', (r) => pendentes.delete(r));
    page.on('requestfailed', (r) => pendentes.delete(r));
    page.on('pageerror', (e) => process.stderr.write(`  (aviso do app: ${e.message.split('\n')[0]})\n`));
    page.setDefaultTimeout(20_000);

    // Entrada pela tela de login, com a conta de teste da seed.
    await page.goto(`${WEB}/`);
    await page.getByText(LOJA, { exact: true }).waitFor({ timeout: 60_000 }).catch(() => {
      falhar(`a tela de entrada não mostrou "${LOJA}" — o nome da loja foi configurado?`);
    });
    await page.getByPlaceholder('voce@sualoja.com').fill(EMAIL);
    await page.getByPlaceholder('••••••••').fill(SENHA);
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    await page.getByRole('tab').filter({ hasText: 'Vender' }).waitFor({ timeout: 30_000 });
    await page.evaluate((inset) => {
      const barra = document.querySelector('[role="tablist"]')?.parentElement;
      const estilo = barra && getComputedStyle(barra);
      if (!estilo || parseFloat(estilo.paddingBottom) >= inset) return;
      const css = document.createElement('style');
      css.textContent = `div:has(> [role="tablist"]) {
        height: ${parseFloat(estilo.height) + inset}px !important;
        padding-bottom: ${parseFloat(estilo.paddingBottom) + inset}px !important;
      }`;
      document.head.appendChild(css);
    }, base);

    const app = criarApp(page, token, pendentes);
    process.stdout.write('• preparo: taxas da maquininha (Mais → Taxas do cartão)\n');
    try {
      await prepararLoja(app);
    } catch (erro) {
      await page.screenshot({ path: join(BRUTAS, 'erro-preparo.png') }).catch(() => {});
      falhar(`preparo da loja: ${erro.message.split('\n')[0]}\n  (a tela na hora do erro: ${join(BRUTAS, 'erro-preparo.png')})`);
    }
    for (const nome of ROTEIRO) {
      const cena = CENAS.find((c) => c.arquivo === nome);
      process.stdout.write(`• ${cena.arquivo}: ${cena.titulo.replace('\n', ' ')}\n`);
      try {
        await cena.preparar(app);
        await app.assentar();
        await app.afastarDoIndicador();
        const foto = await app.assentar();
        const cortados = await app.textosCortados();
        if (cortados.length) throw new Error(`texto cortado na tela: ${cortados.join(' | ')}`);
        if (!SO.length || SO.includes(nome)) writeFileSync(join(BRUTAS, `${nome}.png`), foto);
      } catch (erro) {
        await page.screenshot({ path: join(BRUTAS, `erro-${nome}.png`) }).catch(() => {});
        falhar(`cena ${nome}: ${erro.message.split('\n')[0]}\n  (a tela na hora do erro: ${join(BRUTAS, `erro-${nome}.png`)})`);
      }
    }
  } finally {
    await navegador.close();
  }
  process.stdout.write(`\n✓ ${SO.length || CENAS.length} foto(s) do app em ${BRUTAS}\n`);
}

await principal();
