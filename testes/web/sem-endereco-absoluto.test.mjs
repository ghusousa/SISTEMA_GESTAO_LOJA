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
 *   `naRaiz('/...')` (`web/js/raiz.js`);
 * - `href`/`src`/`action` e `url()` do CSS nunca começam com `/` (relativo, ou `naRaiz`);
 * - foto da API só por `enderecoDaFoto(...)`;
 * - quem guarda no navegador (`sessionStorage`, `localStorage`, `BroadcastChannel`) dá o
 *   nome por `nomeNaRaiz(...)`, nunca um texto solto.
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

/** `[{ numero, texto }]` das linhas que não são comentário. */
function linhasDeCodigo(nome) {
  let texto = readFileSync(join(WEB, nome), 'utf8');
  // O comentário do HTML some, mas deixa as quebras: o número da linha continua certo.
  if (nome.endsWith('.html')) texto = texto.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ''));
  return texto
    .split('\n')
    .map((linha, i) => ({ numero: i + 1, texto: linha }))
    .filter(({ texto: l }) => !/^\s*(\*|\/\*|\/\/)/.test(l));
}

const SERVIDOR = /(['"`])\/(?:api|media|privacidade|exclusao-de-dados|termos|legal|app)(?=[/'"`?#])/g;
const ATRIBUTO = /\b(?:href|src|action)\s*=\s*["'`]\/(?!\/)/;
const URL_DO_CSS = /url\(\s*['"]?\/(?!\/)/;
const SRC_DA_FOTO = /src\s*=\s*["']\$\{([^}]*foto_url[^}]*)\}/;
const CHAVE_SOLTA = /(?:(?:session|local)Storage\.(?:get|set|remove)Item|new BroadcastChannel)\(\s*['"`]/;
const USA_O_NAVEGADOR = /\b(?:sessionStorage|localStorage)\.|new BroadcastChannel\(/;

/** Cada infração vira `"arquivo:linha — motivo: trecho"`, para o erro dizer onde mexer. */
function infracoes() {
  const achadas = [];
  for (const nome of arquivosDoWeb()) {
    const linhas = linhasDeCodigo(nome);
    const anotar = ({ numero, texto }, motivo) => achadas.push(`${nome}:${numero} — ${motivo}: ${texto.trim()}`);

    for (const linha of linhas) {
      for (const achado of linha.texto.matchAll(SERVIDOR)) {
        if (!linha.texto.slice(0, achado.index).endsWith('naRaiz(')) anotar(linha, 'caminho do servidor sem naRaiz');
      }
      if (ATRIBUTO.test(linha.texto)) anotar(linha, 'href/src/action absoluto');
      if (nome.endsWith('.css') && URL_DO_CSS.test(linha.texto)) anotar(linha, 'url() absoluta');
      const foto = SRC_DA_FOTO.exec(linha.texto);
      if (foto && !foto[1].includes('enderecoDaFoto(')) anotar(linha, 'foto sem enderecoDaFoto');
      if (CHAVE_SOLTA.test(linha.texto)) anotar(linha, 'chave do navegador sem nomeNaRaiz');
    }

    const usa = linhas.some((l) => USA_O_NAVEGADOR.test(l.texto));
    if (usa && !linhas.some((l) => l.texto.includes('nomeNaRaiz('))) {
      achadas.push(`${nome} — guarda no navegador e não chama nomeNaRaiz`);
    }
  }
  return achadas;
}

test('a varredura enxerga o web inteiro (sem isso, passar não provaria nada)', () => {
  const nomes = arquivosDoWeb();
  for (const esperado of ['index.html', 'js/api.js', 'js/main.js', 'js/views/produtos.js', 'legal/privacidade.html', 'css/estilo.css']) {
    assert.ok(nomes.includes(esperado), `${esperado} ficou de fora`);
  }
  assert.ok(!nomes.some((n) => n.startsWith('js/vendor/')), 'vendor entrou na varredura');
});

test('nenhum endereço absoluto do servidor no web: tudo sai da raiz da página', () => {
  const achadas = infracoes();
  assert.deepEqual(achadas, [], `endereços que na demo (/demo/app/) iriam à loja:\n${achadas.join('\n')}`);
});
