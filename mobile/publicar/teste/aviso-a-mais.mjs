/**
 * Gancho de módulo SÓ do rodar.mjs, que roda o publicador com `node --import` deste arquivo: a
 * conferência do servidor de demonstração devolve o que devolveria e mais um aviso, que não é
 * do suporte. O "Pronto para a revisão" sabe do suporte pelo campo dele (`suporte`), nunca pela
 * contagem de avisos — com o aviso a mais e a página de suporte no ar, a frase tem de seguir
 * "privacidade e suporte".
 *
 * O mesmo arquivo entra pelos dois lados: no processo do publicador, registra-se como gancho;
 * na thread dos ganchos, embrulha o servidor-demo.mjs quando ele é carregado. Não importe daqui
 * noutro lugar: quem importa registra o gancho no próprio processo.
 */
import { register } from 'node:module';
import { isMainThread } from 'node:worker_threads';

const AVISO_A_MAIS = 'Aviso a mais da conferência do servidor de demonstração, que não é do suporte (teste).';
const DECLARACAO = 'export async function conferirServidorDemo(';

if (isMainThread) register(import.meta.url);

/** O servidor-demo.mjs de verdade, com a conferência embrulhada: a mesma resposta, mais um aviso. */
export async function load(url, contexto, proximo) {
  const carregado = await proximo(url, contexto);
  if (!url.endsWith('/publicar/servidor-demo.mjs')) return carregado;
  const fonte = typeof carregado.source === 'string' ? carregado.source : new TextDecoder().decode(carregado.source);
  // Sem a declaração, o embrulho não entraria e o cenário passaria sem provar nada: para aqui.
  if (!fonte.includes(DECLARACAO)) throw new Error(`aviso-a-mais.mjs: não achei "${DECLARACAO}" em ${url}`);
  const embrulho =
    '\nexport async function conferirServidorDemo(opcoes) {\n' +
    '  const r = await conferirServidorDemoDeVerdade(opcoes);\n' +
    `  return { ...r, avisos: [...r.avisos, ${JSON.stringify(AVISO_A_MAIS)}] };\n` +
    '}\n';
  return { ...carregado, source: fonte.replace(DECLARACAO, 'async function conferirServidorDemoDeVerdade(') + embrulho };
}
