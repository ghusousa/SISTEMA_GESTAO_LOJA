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
 *   demo ia à API da loja (token recusado, religando para sempre);
 * - `href`/`src`/`action` e `url()` do CSS nunca começam com `/` (relativo, ou `naRaiz`);
 * - foto da API só por `enderecoDaFoto(...)`;
 * - quem guarda no navegador (`sessionStorage`, `localStorage`, `BroadcastChannel`) dá o
 *   nome por `nomeNaRaiz(...)`, nunca um texto solto: em CADA chamada, a chave é a própria
 *   `nomeNaRaiz(...)` ou uma constante declarada `= nomeNaRaiz(` no mesmo arquivo — ter a
 *   função noutra linha não basta.
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
const SRC_DA_FOTO = /src\s*=\s*["']\$\{([^}]*foto_url[^}]*)\}/;
/** Cada chamada que guarda no navegador e o começo do 1º argumento, a chave (pode vir na linha de baixo). */
const GUARDA_NO_NAVEGADOR = /(?:(?:session|local)Storage\.(?:get|set|remove)Item|new BroadcastChannel)\(\s*([^\s,)]*)/g;
const USA_O_NAVEGADOR = /\b(?:sessionStorage|localStorage)\.|new BroadcastChannel\(/;

/**
 * A chave da chamada leva a raiz? Ou ela é a própria `nomeNaRaiz(...)`, ou um nome declarado
 * `= nomeNaRaiz(` neste arquivo. Texto solto e conta que a varredura não acompanha (`obj.chave`,
 * `chave()`, template) não passam: a chave sem a raiz é a MESMA na loja e na demo.
 */
function chaveNaRaiz(argumento, codigo) {
  if (argumento.startsWith('nomeNaRaiz(')) return true;
  if (!/^[A-Za-z_$][\w$]*$/.test(argumento)) return false;
  return new RegExp(`\\b(?:const|let|var)\\s+${argumento.replaceAll('$', '\\$')}\\s*=\\s*nomeNaRaiz\\(`).test(codigo);
}

/** Cada infração vira `"arquivo:linha — motivo: trecho"`, para o erro dizer onde mexer. */
function infracoesEm(arquivos) {
  const achadas = [];
  for (const { nome, texto } of arquivos) {
    const codigo = semComentario(nome, texto);
    const linhas = codigo.split('\n').map((linha, i) => ({ numero: i + 1, texto: linha }));
    const anotar = ({ numero, texto: trecho }, motivo) => achadas.push(`${nome}:${numero} — ${motivo}: ${trecho.trim()}`);

    for (const linha of linhas) {
      for (const achado of linha.texto.matchAll(SERVIDOR)) {
        if (!linha.texto.slice(0, achado.index).endsWith('naRaiz(')) anotar(linha, 'caminho do servidor sem naRaiz');
      }
      if (ATRIBUTO.test(linha.texto)) anotar(linha, 'href/src/action absoluto');
      if (nome.endsWith('.css') && URL_DO_CSS.test(linha.texto)) anotar(linha, 'url() absoluta');
      const foto = SRC_DA_FOTO.exec(linha.texto);
      if (foto && !foto[1].includes('enderecoDaFoto(')) anotar(linha, 'foto sem enderecoDaFoto');
    }

    for (const chamada of codigo.matchAll(GUARDA_NO_NAVEGADOR)) {
      if (!chaveNaRaiz(chamada[1], codigo)) {
        anotar(linhas[codigo.slice(0, chamada.index).split('\n').length - 1], 'chave do navegador sem nomeNaRaiz');
      }
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
  };
  for (const [nome, texto] of Object.entries(reprovados)) {
    assert.notDeepEqual(infracoesEm([{ nome, texto }]), [], `${nome} passou na varredura: ${texto}`);
  }
  const aprovados = {
    'js/rotas.js': 'location.hash = `#/vendas/${id}/editar`;',
    'js/api.js': "const BASE = naRaiz('/api/v1');",
    'js/tempo-real.js': "return `${protocolo}//${location.host}${naRaiz('/api/v1/tempo-real')}`;",
    'js/leitor.js':
      "const CHAVE = nomeNaRaiz('leitor-celular');\nsessionStorage.setItem(\n  CHAVE,\n  String(id),\n);\n" +
      "const canal = new BroadcastChannel(CHAVE);\nlocalStorage.getItem(nomeNaRaiz('formato'));",
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
