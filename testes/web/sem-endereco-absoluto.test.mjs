/**
 * Varredura de `web/`: nenhum endereço absoluto do servidor (ADR-46).
 *
 * A mesma pasta serve a loja (em `/app/`) e a demonstração (em `/demo/app/`), no MESMO
 * domínio. Um `href="/privacidade"`, um `'/api/v1'` ou uma foto direto no `src` escritos
 * numa tela nova funcionam na loja — e, na demo, vão calados para a loja de verdade: a
 * demo entra, vende e mostra fotos na loja. Nenhum teste de tela pegaria isso (a loja
 * continua certa), então a regra é conferida no texto, aqui:
 *
 * - caminho do servidor (`/api/`, `/media`, `/privacidade`, `/legal/`, `/app/`…) só por
 *   `naRaiz('/...')` (`web/js/raiz.js`) — também o montado depois de `${...}`, como
 *   `${location.host}/api/v1/tempo-real`, o canal de tempo real de antes do ADR-46, que na
 *   demo ia à API da loja (token recusado, religando para sempre). Depois de `${...}` passa
 *   quando o `${...}` é a própria raiz (`${naRaiz('')}/api/...`, ou uma constante declarada
 *   `= naRaiz(`) e quando o endereço é rota de hash (`#/produtos/${id}/media`): não vai ao
 *   servidor;
 * - `href`/`src`/`action` e `url()` do CSS nunca começam com `/` (relativo, ou `naRaiz`);
 * - foto da API só por `enderecoDaFoto(...)`: `foto_url` que chega a `.src =`, a
 *   `setAttribute('src', ...)` ou a `src=${...}` (com aspas ou sem) sem passar por ela reprova;
 * - quem guarda no navegador (`sessionStorage`, `localStorage`, `BroadcastChannel`) dá o
 *   nome por `nomeNaRaiz(...)`, nunca um texto solto: em CADA chamada, a chave é a própria
 *   `nomeNaRaiz(...)` ou uma constante declarada `= nomeNaRaiz(` no mesmo arquivo — ter a
 *   função noutra linha não basta. Vale para toda forma de chegar lá: `localStorage?.setItem(`,
 *   o apelido (`const s = window.sessionStorage; s.setItem(...)`) e a chave como propriedade
 *   (`localStorage['x'] = v`, `localStorage.x`). Só no guarda: `lista.getItem(0)` é de outra
 *   coleção, `obj.s` não é o apelido `s`, e o apelido que também é parâmetro ou outra
 *   declaração no arquivo (`(s) => s.trim()`) só conta pelo método (`s.setItem(`).
 *
 * Comentário não conta (linha que começa com `*`, `/*`, `//`, e o `<!-- -->` do HTML): é
 * onde estas regras são explicadas. `js/vendor/` é de terceiros e não fala com o servidor.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

/** Os arquivos servidos que têm código ou marcação: `.js`, `.html` e `.css`. */
function arquivosDoWeb() {
  return readdirSync(WEB, { recursive: true })
    .map((nome) => String(nome).replaceAll('\\', '/'))
    .filter((nome) => /\.(js|html|css)$/.test(nome) && !nome.startsWith('js/vendor/'))
    .sort();
}

/** O texto sem comentário: a linha de comentário fica vazia, e o número da linha continua certo. */
function semComentario(nome, texto) {
  // O comentário do HTML some, mas deixa as quebras.
  if (nome.endsWith('.html')) texto = texto.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ''));
  return texto
    .split('\n')
    .map((linha) => (/^\s*(\*|\/\*|\/\/)/.test(linha) ? '' : linha))
    .join('\n');
}

// O `}` conta como aspa: `${location.host}/api/...` é endereço absoluto montado em template.
const SERVIDOR = /(['"`}])\/(?:api|media|privacidade|exclusao-de-dados|termos|legal|app)(?=[/'"`?#])/g;
const ATRIBUTO = /\b(?:href|src|action)\s*=\s*["'`]\/(?!\/)/;
const URL_DO_CSS = /url\(\s*['"]?\/(?!\/)/;
/** O que vai ao `src` da imagem: o lado direito de `.src =` e de `setAttribute('src', …)` (até o `;`, no máximo a linha de baixo) e o `${` de `src=${…}`. */
const SRC_ATRIBUIDO = /\.\s*src\s*=(?!=)([^;\n]*(?:\n[^;\n]*)?)/g;
const SRC_POR_SETATTRIBUTE = /\bsetAttribute\(\s*(['"`])src\1\s*,([^;\n]*(?:\n[^;\n]*)?)/g;
const SRC_EM_TEMPLATE = /\bsrc\s*=\s*["']?(?=\$\{)/g;

const nomeSolto = (texto) => /^[A-Za-z_$][\w$]*$/.test(texto);
const escapar = (nome) => nome.replaceAll('$', '\\$');
/** `nome` é declarado `= funcao(` neste arquivo? */
const declaradoCom = (nome, funcao, codigo) =>
  nomeSolto(nome) && new RegExp(`(?<![\\w$])(?:const|let|var)\\s+${escapar(nome)}\\s*=\\s*${funcao}\\(`).test(codigo);

/**
 * O guarda do navegador no lugar de quem recebe o método, o colchete ou o ponto:
 * `sessionStorage`/`localStorage` — sozinho, como propriedade de uma janela (`window.`,
 * `globalThis.`, `w.`) ou pelo nome entre aspas (`window['localStorage']`) —, ele como um ramo
 * de `?:`, `||`, `??` ou `&&` entre parênteses (`(sessao ? sessionStorage : localStorage)`; os
 * argumentos de uma chamada e o `(localStorage.length)`, não) ou um apelido dele neste arquivo.
 * O apelido, sim, nunca é propriedade de outro objeto (`obj.s` não é o `s`) nem pedaço de outro
 * nome (`itens` não termina no apelido `s`).
 */
function oGuarda(apelidos) {
  const caminhos = [
    '(?<![\\w$])(?:session|local)Storage',
    '\\b(?:window|globalThis|self)\\s*(?:\\?\\.\\s*)?\\[\\s*(?:\'(?:session|local)Storage\'|"(?:session|local)Storage"|`(?:session|local)Storage`)\\s*\\]',
    '(?<![\\w$)\\]])\\(\\s*[\\w$.?:|&\\s]*?\\b(?:session|local)Storage\\b(?!\\s*\\??\\.)[\\w$.?:|&\\s]*\\)',
  ];
  if (apelidos.length) caminhos.push(`(?<![\\w$.])(?:${apelidos.map(escapar).join('|')})`);
  return `(?:${caminhos.join('|')})`;
}
const METODO_DO_GUARDA = '(?:get|set|remove)Item\\s*(?:\\?\\.\\s*)?';
/**
 * Cada chamada que guarda no navegador e o começo do 1º argumento, a chave (pode vir na linha
 * de baixo). O método conta no guarda, chegue-se a ele como for — `localStorage?.setItem(`,
 * `window.sessionStorage.getItem(`, o apelido `s.setItem(` —, e só nele: `lista.getItem(0)` é
 * de outra coleção. O guarda que sai de uma função (`obterGuarda().setItem(`) ou mora noutro
 * objeto (`this.guarda.setItem(`) a varredura não distingue de uma coleção: use-o pelo nome ou
 * por um apelido.
 */
const guardaNoNavegador = (apelidos) =>
  new RegExp(`(?:${oGuarda(apelidos)}\\s*\\??\\.\\s*${METODO_DO_GUARDA}|\\bnew\\s+BroadcastChannel\\s*)\\(\\s*([^\\s,)]*)`, 'g');
const usaONavegador = (apelidos) =>
  new RegExp(
    `\\b(?:sessionStorage|localStorage)\\s*(?:\\?\\.|\\.|\\[)|\\bnew\\s+BroadcastChannel\\s*\\(|${oGuarda(apelidos)}\\s*\\??\\.\\s*${METODO_DO_GUARDA}\\(`,
  );

/**
 * A chave da chamada leva a raiz? Ou ela é a própria `nomeNaRaiz(...)`, ou um nome declarado
 * `= nomeNaRaiz(` neste arquivo. Texto solto e conta que a varredura não acompanha (`obj.chave`,
 * `chave()`, template) não passam: a chave sem a raiz é a MESMA na loja e na demo.
 */
function chaveNaRaiz(argumento, codigo) {
  return argumento.startsWith('nomeNaRaiz(') || declaradoCom(argumento, 'nomeNaRaiz', codigo);
}

/**
 * O valor dá o próprio guarda? Ele, ou um ramo de `?:`, `||`, `??` e `&&`, com parênteses ou
 * sem: `window.sessionStorage`, `sessao ? sessionStorage : localStorage`,
 * `sessionStorage || localStorage`, `(window.localStorage)`.
 */
const daOGuarda = (valor) =>
  valor
    .replace(/\/\/.*$/, '')
    .split(/\?\?|\|\||&&|\?(?!\.)|:/)
    .some((ramo) => /^(?:(?:window|globalThis|self)\??\.)?(?:session|local)Storage$/.test(ramo.replace(/[\s()]/g, '')));
/** Cada `nome = valor` do arquivo, declarado ou não (nunca `obj.nome =`, `==` ou `=>`). */
const ATRIBUICAO = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*=(?![=>])\s*([^;\n]*)/g;
/** O padrão de uma desestruturação declarada (`const { localStorage: guarda } = window`) e quem renomeia o guarda nele. */
const DESESTRUTURACAO = /(?<![\w$.])(?:const|let|var)\s*(\{[^{}]*\}|\[[^[\]]*\])/g;
const RENOMEIA_O_GUARDA = /\b(?:session|local)Storage\s*:\s*([A-Za-z_$][\w$]*)/g;
/** As listas que dão nome a parâmetros: `function f(…)`, `(…) =>`, `metodo(…) {` e `catch (…) {`. */
const PARAMETROS = [
  /\bfunction\b[\s*]*[\w$]*\s*\(([^()]*)\)/g,
  /\(([^()]*)\)\s*=>/g,
  /(?<![\w$.])(?!(?:if|for|while|switch|with)(?![\w$]))[A-Za-z_$][\w$]*\s*\(([^()]*)\)\s*\{/g,
];

/**
 * Os nomes que guardam o próprio `sessionStorage`/`localStorage` neste arquivo:
 * `const s = window.sessionStorage`, `let guarda = sessao ? sessionStorage : localStorage`,
 * `guarda = sessionStorage || localStorage` (sem declarar) e `const { localStorage: guarda } = window`.
 */
function apelidosDoGuarda(codigo) {
  const apelidos = new Set();
  for (const [, nome, valor] of codigo.matchAll(ATRIBUICAO)) if (daOGuarda(valor)) apelidos.add(nome);
  for (const [, padrao] of codigo.matchAll(DESESTRUTURACAO)) {
    for (const [, nome] of padrao.matchAll(RENOMEIA_O_GUARDA)) apelidos.add(nome);
  }
  return [...apelidos];
}

/**
 * O apelido também é outra coisa neste arquivo: recebe outro valor (`const s = situacao(c)`,
 * `s = null`), é parâmetro (`(s) => …`, `s => …`, `function f(g)`, `salvar(g) {`, `catch (g)`),
 * nome de laço (`for (const s of …)`), de função ou de classe, ou sai de uma desestruturação sem
 * ser o guarda renomeado. A varredura não acompanha escopo: aí o colchete e o ponto (`g[0]`,
 * `s.trim()`) não dizem de qual dos dois se trata — o `.setItem(` diz.
 */
function temOutroSentido(nome, codigo) {
  const n = escapar(nome);
  const nele = (trecho) => new RegExp(`(?<![\\w$])${n}(?![\\w$])`).test(trecho);
  for (const [, outro, valor] of codigo.matchAll(ATRIBUICAO)) if (outro === nome && !daOGuarda(valor)) return true;
  const nomeia = `(?<![\\w$.])${n}\\s*=>|\\b(?:function|class)\\s+${n}(?![\\w$])|\\b(?:const|let|var)\\s+${n}\\s+(?:of|in)\\b`;
  if (new RegExp(nomeia).test(codigo)) return true;
  for (const [, padrao] of codigo.matchAll(DESESTRUTURACAO)) if (nele(padrao.replace(RENOMEIA_O_GUARDA, ''))) return true;
  return PARAMETROS.some((lista) => [...codigo.matchAll(lista)].some(([, dentro]) => nele(dentro)));
}

/** O `${...}` inteiro que fecha no `}` de `fim`: o índice do `$` e a expressão de dentro (ou null). */
function templateQueFechaEm(texto, fim) {
  let chaves = 0;
  for (let i = fim; i >= 0; i--) {
    if (texto[i] === '}') chaves += 1;
    else if (texto[i] === '{' && --chaves === 0) return texto[i - 1] === '$' ? { inicio: i - 1, expressao: texto.slice(i + 1, fim) } : null;
  }
  return null;
}

/** O `${...}` inteiro que abre no `$` de `inicio`: a expressão de dentro. */
function expressaoQueAbreEm(texto, inicio) {
  let chaves = 0;
  for (let i = inicio + 1; i < texto.length; i++) {
    if (texto[i] === '{') chaves += 1;
    else if (texto[i] === '}' && --chaves === 0) return texto.slice(inicio + 2, i);
  }
  return texto.slice(inicio + 2);
}

/**
 * O endereço que termina no `}` de `fim`, voltando por `${...}` inteiros até a aspa, a crase,
 * o espaço ou o operador: em `` `#/produtos/${id}/media` `` é `#/produtos/${id}`.
 */
function enderecoQueTerminaEm(texto, fim) {
  let i = fim + 1;
  while (i > 0) {
    if (texto[i - 1] === '}') {
      const template = templateQueFechaEm(texto, i - 1);
      if (!template) break;
      i = template.inicio;
    } else if (/[\s'"`(=,+]/.test(texto[i - 1])) {
      break;
    } else {
      i -= 1;
    }
  }
  return texto.slice(i, fim + 1);
}

/** O caminho do servidor depois do `}` de `fim` sai da raiz (`${naRaiz('')}`) ou é rota de hash? */
function depoisDoTemplateSemPerigo(texto, fim, codigo) {
  if (enderecoQueTerminaEm(texto, fim).startsWith('#/')) return true;
  const expressao = templateQueFechaEm(texto, fim)?.expressao.trim() ?? '';
  return /^naRaiz\(/.test(expressao) || declaradoCom(expressao, 'naRaiz', codigo);
}

/** O trecho leva `foto_url` ao `src` sem passar por `enderecoDaFoto(`? */
const fotoSemEndereco = (trecho) => /\bfoto_url\b/.test(trecho) && !trecho.includes('enderecoDaFoto(');

/** Cada infração vira `"arquivo:linha — motivo: trecho"`, para o erro dizer onde mexer. */
function infracoesEm(arquivos) {
  const achadas = [];
  for (const { nome, texto } of arquivos) {
    const codigo = semComentario(nome, texto);
    const linhas = codigo.split('\n').map((linha, i) => ({ numero: i + 1, texto: linha }));
    const anotar = ({ numero, texto: trecho }, motivo) => achadas.push(`${nome}:${numero} — ${motivo}: ${trecho.trim()}`);
    const linhaDe = (indice) => linhas[codigo.slice(0, indice).split('\n').length - 1];

    for (const linha of linhas) {
      for (const achado of linha.texto.matchAll(SERVIDOR)) {
        if (linha.texto.slice(0, achado.index).endsWith('naRaiz(')) continue;
        if (achado[1] === '}' && depoisDoTemplateSemPerigo(linha.texto, achado.index, codigo)) continue;
        anotar(linha, 'caminho do servidor sem naRaiz');
      }
      if (ATRIBUTO.test(linha.texto)) anotar(linha, 'href/src/action absoluto');
      if (nome.endsWith('.css') && URL_DO_CSS.test(linha.texto)) anotar(linha, 'url() absoluta');
    }

    // A foto no src: o que vai ao `src`, venha ele de onde vier (atribuição, atributo, template).
    for (const achado of codigo.matchAll(SRC_ATRIBUIDO)) {
      if (fotoSemEndereco(achado[1])) anotar(linhaDe(achado.index), 'foto sem enderecoDaFoto');
    }
    for (const achado of codigo.matchAll(SRC_POR_SETATTRIBUTE)) {
      if (fotoSemEndereco(achado[2])) anotar(linhaDe(achado.index), 'foto sem enderecoDaFoto');
    }
    for (const achado of codigo.matchAll(SRC_EM_TEMPLATE)) {
      const inicio = achado.index + achado[0].length;
      if (fotoSemEndereco(expressaoQueAbreEm(codigo, inicio))) anotar(linhaDe(achado.index), 'foto sem enderecoDaFoto');
    }

    const apelidos = apelidosDoGuarda(codigo);
    for (const chamada of codigo.matchAll(guardaNoNavegador(apelidos))) {
      if (!chaveNaRaiz(chamada[1], codigo)) anotar(linhaDe(chamada.index), 'chave do navegador sem nomeNaRaiz');
    }
    // A chave como propriedade do próprio guarda (ou de um apelido dele): `localStorage['x'] = v`
    // passa pelo mesmo critério; `localStorage.x` é sempre um nome solto. O apelido que também é
    // outra coisa no arquivo (`temOutroSentido`) fica só com o método, que diz de quem se trata.
    const guarda = oGuarda(apelidos.filter((apelido) => !temOutroSentido(apelido, codigo)));
    for (const achado of codigo.matchAll(new RegExp(`${guarda}\\s*(?:\\?\\.\\s*)?\\[\\s*([^\\]]*?)\\s*\\]`, 'g'))) {
      if (!chaveNaRaiz(achado[1], codigo)) anotar(linhaDe(achado.index), 'chave do navegador sem nomeNaRaiz');
    }
    const naoEChave = '(?:get|set|remove)Item|clear|key|length';
    // Colado no ponto, como se escreve código: "no localStorage. Depois" num comentário não é chave.
    for (const achado of codigo.matchAll(new RegExp(`${guarda}\\??\\.(?!(?:${naoEChave})(?![\\w$]))[A-Za-z_$]`, 'g'))) {
      anotar(linhaDe(achado.index), 'chave do navegador sem nomeNaRaiz');
    }
    if (usaONavegador(apelidos).test(codigo) && !codigo.includes('nomeNaRaiz(')) {
      achadas.push(`${nome} — guarda no navegador e não chama nomeNaRaiz`);
    }
  }
  return achadas;
}

const infracoes = () => infracoesEm(arquivosDoWeb().map((nome) => ({ nome, texto: readFileSync(join(WEB, nome), 'utf8') })));

test('a varredura enxerga o web inteiro (sem isso, passar não provaria nada)', () => {
  const nomes = arquivosDoWeb();
  for (const esperado of ['index.html', 'js/api.js', 'js/main.js', 'js/views/produtos.js', 'legal/privacidade.html', 'css/estilo.css']) {
    assert.ok(nomes.includes(esperado), `${esperado} ficou de fora`);
  }
  assert.ok(!nomes.some((n) => n.startsWith('js/vendor/')), 'vendor entrou na varredura');
});

test('a varredura reprova o que o ADR-46 corrigiu, e não o que está certo (sem isso, passar não provaria nada)', () => {
  const reprovados = {
    // O canal de tempo real de antes: na demo, ia à API da loja, que recusa o token da demo.
    'js/tempo-real.js': 'return `${protocolo}//${location.host}/api/v1/tempo-real`;',
    'js/socket.js': 'const ws = new WebSocket(`ws://${location.host}/api/v1/tempo-real`);',
    'js/legal.js': 'export const politica = () => `${location.origin}/privacidade`;',
    'js/foto.js': 'img.src = `${location.origin}/media/produtos/${nome}`;',
    // A chave solta num arquivo que já chama nomeNaRaiz noutra linha: loja e demo a dividem.
    'js/leitor.js': "const CHAVE = nomeNaRaiz('leitor');\nconst OUTRA = 'leitor-outra';\nsessionStorage.setItem(OUTRA, '1');",
    'js/canal.js': "const CHAVE = nomeNaRaiz('canal');\nconst canal = new BroadcastChannel(\n  'canal-da-loja',\n);",
    'js/formato.js': "const CHAVE = nomeNaRaiz('x');\nlocalStorage.getItem(opcoes.chave);",
    'js/sem-raiz.js': "localStorage.removeItem('formato');",
    // Outros caminhos até o guarda, num arquivo que já tem nomeNaRaiz: o `?.`, o apelido e a
    // chave como propriedade.
    'js/opcional.js': "const CHAVE = nomeNaRaiz('x');\nlocalStorage?.setItem('formato', v);",
    'js/opcional-no-metodo.js': "const CHAVE = nomeNaRaiz('x');\nlocalStorage.getItem?.('formato');",
    'js/apelido.js': "const CHAVE = nomeNaRaiz('x');\nconst s = window.sessionStorage;\ns.setItem('leitor', v);",
    'js/colchete.js': "const CHAVE = nomeNaRaiz('x');\nlocalStorage['x'] = v;",
    'js/apelido-colchete.js': "const CHAVE = nomeNaRaiz('x');\nconst guarda = sessao ? sessionStorage : localStorage;\nguarda['x'] = v;",
    'js/ponto.js': "const CHAVE = nomeNaRaiz('x');\nwindow.localStorage.formato = v;",
    // O método só conta no guarda, mas no guarda por qualquer caminho: o apelido que também é
    // parâmetro noutra função, o de `||` ou sem declarar, o da janela guardada, o entre aspas,
    // o entre parênteses e o do método na linha de baixo.
    'js/apelido-e-parametro-no-metodo.js':
      "const CHAVE = nomeNaRaiz('x');\nconst s = window.sessionStorage;\ns.setItem('leitor', v);\nconst nomes = l.map((s) => s.trim());",
    'js/apelido-por-ou.js': "const CHAVE = nomeNaRaiz('x');\nlet g;\ng = window.sessionStorage || window.localStorage;\ng.getItem('formato');",
    'js/outra-janela.js': "const CHAVE = nomeNaRaiz('x');\nconst w = window;\nw.localStorage.setItem('formato', v);",
    'js/entre-aspas.js': "const CHAVE = nomeNaRaiz('x');\nwindow['localStorage'].removeItem('formato');",
    'js/entre-parenteses.js': "const CHAVE = nomeNaRaiz('x');\n(sessao ? sessionStorage : localStorage).setItem('formato', v);",
    'js/linha-de-baixo.js': "const CHAVE = nomeNaRaiz('x');\nwindow?.sessionStorage\n  ?.setItem('leitor', v);",
    // A foto da API direto no src: na demo, o /media/... vai à loja e dá 404 (ADR-42/46).
    'js/foto-src.js': 'export function f(img, item) { img.src = item.foto_url; }',
    'js/foto-src-quebrado.js': 'img.src =\n  item.foto_url;',
    'js/foto-sem-aspas.js': 'const t = html`<img src=${p.foto_url}>`;',
    'js/foto-com-aspas.js': 'const t = html`<img class="x" src="${p.foto_url}" alt="">`;',
    'js/foto-atributo.js': "img.setAttribute('src', p.foto_url);",
  };
  for (const [nome, texto] of Object.entries(reprovados)) {
    assert.notDeepEqual(infracoesEm([{ nome, texto }]), [], `${nome} passou na varredura: ${texto}`);
  }
  const aprovados = {
    'js/rotas.js': 'location.hash = `#/vendas/${id}/editar`;',
    // Rota de hash que termina num nome do servidor: não vai ao servidor.
    'js/rotas-de-hash.js':
      'location.hash = `#/produtos/${id}/media`;\nconst a = html`<a href="#/produtos/${p.id}/media">Fotos</a>`;',
    'js/api.js': "const BASE = naRaiz('/api/v1');",
    // O `${...}` antes do caminho é a própria raiz.
    'js/raiz-no-template.js': "fetch(`${naRaiz('')}/api/v1/x`);\nconst RAIZ = naRaiz('');\nfetch(`${RAIZ}/api/v1/y`);",
    'js/tempo-real.js': "return `${protocolo}//${location.host}${naRaiz('/api/v1/tempo-real')}`;",
    'js/leitor.js':
      "const CHAVE = nomeNaRaiz('leitor-celular');\nsessionStorage.setItem(\n  CHAVE,\n  String(id),\n);\n" +
      "const canal = new BroadcastChannel(CHAVE);\nlocalStorage.getItem(nomeNaRaiz('formato'));",
    'js/guarda.js':
      "const CHAVE = nomeNaRaiz('x');\nlocalStorage?.setItem(CHAVE, v);\nconst s = window.sessionStorage;\ns.setItem(CHAVE, v);\n" +
      "localStorage[CHAVE] = v;\nlocalStorage[nomeNaRaiz('y')] = v;\nconst n = localStorage.length;\nsessionStorage.clear();\n" +
      'salvar(CHAVE); // guarda no localStorage. Depois, nada',
    // getItem/setItem/removeItem de outra coleção não é o guarda (nem pede nomeNaRaiz no arquivo).
    'js/colecao.js': "const primeiro = lista.getItem(0);\nfila.setItem(1, x);\nmapa.removeItem?.(chave);",
    // O apelido não vale como propriedade de outro objeto nem no meio de outro nome; e, onde o
    // nome também é outra coisa (parâmetro, outra declaração), o colchete e o ponto são da outra.
    'js/apelido-como-propriedade.js':
      "const CHAVE = nomeNaRaiz('x');\nconst s = window.sessionStorage;\ns.setItem(CHAVE, v);\nconst nome = obj.s.nome;\n" +
      'const primeira = obj?.s[0];\nconst item = itens.getItem(0);',
    'js/apelido-e-parametro.js':
      "const CHAVE = nomeNaRaiz('x');\nfunction guardar(v) {\n  const s = window.sessionStorage;\n  s.setItem(CHAVE, v);\n}\n" +
      'function limpar(l) {\n  return l.map((s) => s.trim());\n}',
    'js/apelido-colchete-e-parametro.js':
      "const CHAVE = nomeNaRaiz('x');\nconst g = localStorage;\ng.setItem(CHAVE, v);\nfunction primeiro(g) {\n  return g[0];\n}",
    'js/apelido-e-outra-declaracao.js':
      "const CHAVE = nomeNaRaiz('x');\nfunction guardar(v) {\n  const s = sessionStorage;\n  s.setItem(CHAVE, v);\n}\n" +
      'function rotulo(c) {\n  const s = situacao(c);\n  return s.texto + s[0];\n}',
    'js/foto.js':
      "img.src = enderecoDaFoto(item.foto_url) ?? '';\nimg.setAttribute('src', enderecoDaFoto(p.foto_url));\n" +
      'const t = html`<img src=${enderecoDaFoto(p.foto_url)}>`;\nprevia.src = url;\n' +
      '${p.foto_url\n  ? cru(html`<img class="foto" src="${enderecoDaFoto(p.foto_url)}" alt="" />`)\n  : ""}',
    // Comentário não conta: é onde a regra é explicada.
    'js/raiz.js': "// antes: `${location.host}/api/v1/tempo-real` e sessionStorage.setItem('leitor')",
  };
  for (const [nome, texto] of Object.entries(aprovados)) {
    assert.deepEqual(infracoesEm([{ nome, texto }]), [], `${nome} reprovado sem motivo: ${texto}`);
  }
});

test('nenhum endereço absoluto do servidor no web: tudo sai da raiz da página', () => {
  const achadas = infracoes();
  assert.deepEqual(achadas, [], `endereços que na demo (/demo/app/) iriam à loja:\n${achadas.join('\n')}`);
});
