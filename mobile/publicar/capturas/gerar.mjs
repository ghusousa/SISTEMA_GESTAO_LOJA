#!/usr/bin/env node
/**
 * Fotografa o app de verdade — o export web do próprio app, falando com a API local de
 * teste — cena por cena (`cenas.mjs`), numa tela do tamanho de um iPhone.
 *
 * Quem sobe API, banco, dados e o export é o `gerar.sh`; este arquivo só entra pela tela
 * de login com a dona de teste da seed e segue o `ROTEIRO`. Cada foto sai em
 * `.brutas/NN-nome.png` (428 × 926 pt a 3x), com a hora em que saiu em `.brutas/NN-nome.json`
 * (a da barra de status), e o `compor.mjs` monta a arte em cima.
 *
 * O que é diferente do navegador comum, e por quê (tudo para parecer o que o iPhone mostra):
 *   - as áreas seguras do iPhone, declaradas pelo DevTools: 47 pt em cima (barra de status)
 *     e 34 pt embaixo (indicador de início). O app as lê como no aparelho — a barra de abas
 *     e os rodapés se afastam do indicador sozinhos, sem retoque da foto — e a moldura
 *     desenha a barra de status e o indicador por cima;
 *   - sem barra de rolagem e sem cursor piscando (nenhum dos dois aparece parado no iPhone);
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
import { medirQuadro } from './quadro.mjs';

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

/** A faixa de baixo onde o iPhone desenha o indicador de início e a tela se arredonda. */
const FAIXA_DO_INDICADOR = 28;

/** Ajustes só de fotografia (ver o cabeçalho). Nada aqui muda dado ou comportamento. */
const CSS_DA_FOTO = `
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

/** Hora e minuto no fuso da loja (`GET /configuracao`), como o app escreve no recibo. */
async function relogioDaLoja() {
  const resposta = await fetch(`${API}/api/v1/configuracao`);
  if (!resposta.ok) falhar(`a API local não disse o fuso da loja (${resposta.status}).`);
  const { timezone } = await resposta.json();
  return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: timezone });
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

    /**
     * Busca de lista (estoque, produtos): escreve, espera a API responder com aquele termo
     * e solta o campo. A lista mostra o resultado na assentada que vem depois.
     */
    async buscar(placeholder, termo) {
      const respondeu = page.waitForResponse(
        (r) => r.url().startsWith(API) && new URL(r.url()).searchParams.get('q') === termo,
      );
      await app.digitar(placeholder, termo);
      await respondeu;
      await app.soltarCampo();
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
     * Enquadra a tela como uma pessoa faria antes de mostrar: nada cortado nas bordas do que
     * se vê, nada embaixo do indicador de início nem do botão flutuante, e o que a cena pede
     * em `mostrar` inteiro à vista (as regras estão em `quadro.mjs`). A lista rola o mínimo,
     * a partir de onde a cena a deixou; sem posição assim, a cena para dizendo o que cortou.
     */
    async enquadrar(mostrar = []) {
      const medidas = {
        largura: APARELHO.largura,
        altura: APARELHO.altura,
        status: APARELHO.status,
        faixa: FAIXA_DO_INDICADOR,
        mostrar,
      };
      for (let vez = 0; vez < 3; vez += 1) {
        const quadro = await page.evaluate(medirQuadro, { ...medidas, procurar: true });
        if (!quadro.ok) {
          throw new Error(
            `não há enquadramento sem corte (onde a cena deixou: ${quadro.antes.slice(0, 3).join('; ')}); ` +
              `o mais perto: ${quadro.problemas.join('; ')}`,
          );
        }
        if (quadro.para !== quadro.de) {
          const quanto = Math.round(quadro.para - quadro.de);
          process.stdout.write(`  (rolou ${quanto} pt: ${quadro.antes.slice(0, 2).join('; ')})\n`);
        }
        await app.assentar();
        // A lista pode ter desenhado mais linhas ao rolar: confere de novo, parada.
        if ((await page.evaluate(medirQuadro, { ...medidas, procurar: false })).ok) return;
      }
      throw new Error('a tela não parou num enquadramento sem corte');
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
  const relogio = await relogioDaLoja();

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
    // A barra de abas é a do app, sem retoque: ela soma a área segura de baixo sozinha
    // (`medidasDaBarraDeAbas`). Se um dia voltar a ignorá-la, a foto para aqui em vez de
    // mostrar os rótulos em cima do indicador de início.
    const barra = await page.evaluate(() => {
      const el = document.querySelector('[role="tablist"]')?.parentElement;
      const rotulos = [...document.querySelectorAll('a[role="tab"] div[dir="auto"]')].filter((r) => r.textContent.trim());
      return {
        folga: el ? parseFloat(getComputedStyle(el).paddingBottom) : null,
        espremidos: rotulos.filter((r) => r.scrollHeight > r.clientHeight + 1).map((r) => r.textContent.trim()),
      };
    });
    if (barra.folga === null || barra.folga < base) {
      falhar(
        `a barra de abas do app não deixa a área segura de baixo (${barra.folga ?? '?'} pt de folga, ` +
          `precisa de ${base}): confira o medidasDaBarraDeAbas (src/lib/areaSegura.ts).`,
      );
    }
    if (barra.espremidos.length) {
      falhar(`rótulo de aba sem altura para a linha inteira: ${barra.espremidos.join(', ')} (src/lib/areaSegura.ts).`);
    }

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
        await app.enquadrar(cena.mostrar);
        const foto = await app.assentar();
        // A hora da barra de status é a da foto, no fuso da loja: a mesma do recibo e da
        // condicional que a cena acabou de fazer (o "9:41" fixo desmentia as duas).
        const hora = relogio.format(new Date());
        const cortados = await app.textosCortados();
        if (cortados.length) throw new Error(`texto cortado na tela: ${cortados.join(' | ')}`);
        if (!SO.length || SO.includes(nome)) {
          writeFileSync(join(BRUTAS, `${nome}.png`), foto);
          writeFileSync(join(BRUTAS, `${nome}.json`), `${JSON.stringify({ hora })}\n`);
        }
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
