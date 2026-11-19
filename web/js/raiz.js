/**
 * Onde este sistema mora no domínio: `""` na loja, `"/demo"` na demonstração (ADR-46).
 *
 * A demonstração sobe com a loja no MESMO domínio — a loja em `loja.x.com.br`, a demo em
 * `loja.x.com.br/demo`, com API, banco e segredo próprios — e serve esta mesma pasta em
 * `/demo/app/`. Ali, um endereço absoluto como `/api/v1` iria para a API da LOJA: a página
 * da demo entraria, venderia e mostraria as fotos da loja de verdade. Por isso nenhum
 * endereço do web é absoluto: API, tempo real, fotos e páginas legais saem da raiz desta
 * página, e as chaves que o navegador guarda levam a raiz no nome.
 *
 * A raiz vem do endereço da página, não de configuração: a mesma pasta serve a loja, a demo
 * e a Vercel, sem build e sem saber onde está. A página é sempre `<raiz>/app/` (o FastAPI
 * monta o web em /app), então a raiz é o que vem antes do `/app` do fim.
 *
 * Sem DOM e sem rede, para dar para testar (`testes/web/raiz.test.mjs`).
 */

/**
 * `"/app/"` → `""`; `"/demo/app/"` e `"/demo/app/index.html"` → `"/demo"`.
 *
 * Endereço sem um segmento `/app` dá `""` — a origem inteira, como sempre foi.
 * @param {string | null | undefined} caminho o `location.pathname`
 * @returns {string}
 */
export function raizDoCaminho(caminho) {
  // Barra dobrada sai antes de tudo. "/demo/app//" ainda abre a página (o servidor de
  // arquivos aceita), e sem isto daria raiz "" — a demo falando com a loja. E "//outro.site"
  // + "/api/v1" é endereço SEM esquema: o navegador o leva a OUTRO site, com o token junto.
  const limpo = String(caminho ?? '').replace(/\/{2,}/g, '/');
  // O ÚLTIMO "/app" inteiro (não "/apple"): a raiz pode ela mesma se chamar "/app".
  const achado = /^(.*)\/app(?:\/.*)?$/.exec(limpo);
  return achado ? achado[1] : '';
}

/**
 * A raiz desta página. Lida a cada chamada (é uma regex): o roteador só mexe no `#`, e o
 * teste troca de endereço sem recarregar o módulo.
 */
export const raizDaPagina = () => raizDoCaminho(globalThis.location?.pathname);

/**
 * Um caminho do servidor desta página: `"/api/v1"` → `"/demo/api/v1"` na demo, o mesmo
 * `"/api/v1"` na loja. O caminho começa com `/`.
 * @param {string} caminho
 */
export const naRaiz = (caminho) => `${raizDaPagina()}${caminho}`;

/**
 * O nome de uma chave do navegador (`sessionStorage`, `localStorage`, `BroadcastChannel`).
 *
 * Loja e demo têm a MESMA origem, e com o mesmo nome dividiriam tudo isso: a aba que passa
 * da loja para a demo retomaria na demo o leitor pareado na loja, e as abas de uma ouviriam
 * as da outra. Na loja o nome fica o de sempre (`leitor-celular`) — nada do que já está
 * guardado se perde na atualização; na demo vira `leitor-celular@/demo`.
 * @param {string} nome
 * @param {string} [raiz] a raiz; padrão, a desta página
 */
export function nomeNaRaiz(nome, raiz = raizDaPagina()) {
  return raiz ? `${nome}@${raiz}` : nome;
}

/**
 * O `src` da foto da peça.
 *
 * A API devolve o caminho RELATIVO (`/media/...`, a foto no disco do servidor) ou a URL
 * ABSOLUTA do Vercel Blob (ADR-42). O relativo é da API que gravou a foto: na demo,
 * `/demo/media/...` — sem a raiz, o navegador pediria a foto à loja. A absoluta já é o
 * endereço da foto e passa como está. Mesma regra de `montarUrlDaFoto`
 * (`mobile/src/lib/enderecoDaFoto.ts`), lá com o servidor do aparelho no lugar da raiz.
 * @param {string | null | undefined} foto o `foto_url` que a API mandou
 * @param {string} [raiz] a raiz; padrão, a desta página
 * @returns {string | null}
 */
export function enderecoDaFoto(foto, raiz = raizDaPagina()) {
  if (!foto) return null;
  if (/^https?:\/\//i.test(foto)) return foto;
  return foto.startsWith('/') ? `${raiz}${foto}` : `${raiz}/${foto}`;
}
