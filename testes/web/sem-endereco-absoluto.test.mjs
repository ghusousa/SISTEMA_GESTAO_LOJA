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
 *   (`localStorage['x'] = v`, `localStorage.x`).
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
/**
 * Cada chamada que guarda no navegador e o começo do 1º argumento, a chave (pode vir na linha
 * de baixo). O método vale em QUALQUER objeto — `localStorage?.setItem(`, o apelido
 * `s.setItem(` e `window.sessionStorage.getItem(` são a mesma porta.
 */
const GUARDA_NO_NAVEGADOR = /(?:\??\.\s*(?:get|set|remove)Item\s*(?:\?\.\s*)?|\bnew\s+BroadcastChannel\s*)\(\s*([^\s,)]*)/g;
const USA_O_NAVEGADOR = /\b(?:sessionStorage|localStorage)\s*(?:\?\.|\.|\[)|\bnew\s+BroadcastChannel\s*\(|\??\.\s*(?:get|set|remove)Item\s*(?:\?\.\s*)?\(/;

const nomeSolto = (texto) => /^[A-Za-z_$][\w$]*$/.test(texto);
const escapar = (nome) => nome.replaceAll('$', '\\$');
/** `nome` é declarado `= funcao(` neste arquivo? */
const declaradoCom = (nome, funcao, codigo) =>
  nomeSolto(nome) && new RegExp(`(?<![\\w$])(?:const|let|var)\\s+${escapar(nome)}\\s*=\\s*${funcao}\\(`).test(codigo);

/**
 * A chave da chamada leva a raiz? Ou ela é a própria `nomeNaRaiz(...)`, ou um nome declarado
 * `= nomeNaRaiz(` neste arquivo. Texto solto e conta que a varredura não acompanha (`obj.chave`,
 * `chave()`, template) não passam: a chave sem a raiz é a MESMA na loja e na demo.
 */
function chaveNaRaiz(argumento, codigo) {
  return argumento.startsWith('nomeNaRaiz(') || declaradoCom(argumento, 'nomeNaRaiz', codigo);
}

/**
 * Os nomes que guardam o próprio `sessionStorage`/`localStorage` neste arquivo:
 * `const s = window.sessionStorage`, `let guarda = sessao ? sessionStorage : localStorage`.
 */
function apelidosDoGuarda(codigo) {
  const apelidos = [];
  for (const [, nome, valor] of codigo.matchAll(/(?<![\w$])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]*)/g)) {
    if (/(?:^|[?:]\s*)(?:(?:window|globalThis|self)\s*\??\.\s*)?(?:session|local)Storage\s*$/.test(valor.trim())) apelidos.push(nome);
  }
  return apelidos;
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

    for (const chamada of codigo.matchAll(GUARDA_NO_NAVEGADOR)) {
      if (!chaveNaRaiz(chamada[1], codigo)) anotar(linhaDe(chamada.index), 'chave do navegador sem nomeNaRaiz');
    }
    // A chave como propriedade do próprio guarda (ou de um apelido dele): `localStorage['x'] = v`
    // passa pelo mesmo critério; `localStorage.x` é sempre um nome solto.
    const guardas = ['sessionStorage', 'localStorage', ...apelidosDoGuarda(codigo)].map(escapar).join('|');
    for (const achado of codigo.matchAll(new RegExp(`(?<![\\w$])(?:${guardas})\\s*(?:\\?\\.\\s*)?\\[\\s*([^\\]]*?)\\s*\\]`, 'g'))) {
      if (!chaveNaRaiz(achado[1], codigo)) anotar(linhaDe(achado.index), 'chave do navegador sem nomeNaRaiz');
    }
    const naoEChave = '(?:get|set|remove)Item|clear|key|length';
    for (const achado of codigo.matchAll(new RegExp(`(?<![\\w$])(?:${guardas})\\s*\\??\\.\\s*(?!(?:${naoEChave})(?![\\w$]))[A-Za-z_$]`, 'g'))) {
      anotar(linhaDe(achado.index), 'chave do navegador sem nomeNaRaiz');
    }
    if (USA_O_NAVEGADOR.test(codigo) && !codigo.includes('nomeNaRaiz(')) {
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
      "localStorage[CHAVE] = v;\nlocalStorage[nomeNaRaiz('y')] = v;\nconst n = localStorage.length;\nsessionStorage.clear();",
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
