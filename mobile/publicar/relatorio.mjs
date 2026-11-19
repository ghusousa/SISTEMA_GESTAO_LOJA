/**
 * O que o publicador conta enquanto trabalha e o RESUMO honesto do fim: o que ficou feito,
 * os avisos, as pendências (o que ainda precisa de alguém) e o que a API da Apple não cobre.
 *
 * No GitHub Actions o resumo também vai para a página da execução ($GITHUB_STEP_SUMMARY) e
 * cada aviso/pendência vira anotação — o dono vê sem abrir o log. Valor de segredo (a senha
 * da conta demo) nunca sai: qualquer texto que o contenha é trocado por •••, inclusive a
 * mensagem de erro que a Apple devolver.
 */

import { appendFileSync } from 'node:fs';

/** Texto de anotação do Actions: %, \r e \n precisam de escape, senão a linha quebra. */
const anotacao = (texto) => texto.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

export function criarRelatorio({ segredos = [] } = {}) {
  const ocultos = segredos.filter((s) => typeof s === 'string' && s.length >= 3);
  const limpar = (texto) => ocultos.reduce((t, s) => t.split(s).join('•••'), String(texto));
  const escrever = (texto) => process.stdout.write(limpar(texto));
  const feitos = [];
  const avisos = [];
  const pendencias = [];
  const assuntos = new Set();

  return {
    limpar,
    /** Segredo que só aparece no meio da rodada (a senha da demo lida da Apple): some daqui em diante. */
    ocultar(segredo) {
      if (typeof segredo === 'string' && segredo.length >= 3 && !ocultos.includes(segredo)) ocultos.push(segredo);
    },
    passo: (texto) => escrever(`\n• ${texto}\n`),
    /** Progresso miúdo (cada captura, cada consulta): só no log. */
    ok: (texto) => escrever(`  ✔ ${texto}\n`),
    linha: (texto) => escrever(`${texto}\n`),
    /** Uma etapa concluída: no log e no resumo. */
    feito(texto) {
      feitos.push(limpar(texto));
      escrever(`  ✔ ${texto}\n`);
    },
    avisar(texto) {
      avisos.push(limpar(texto));
      escrever(`  ⚠ ${texto}\n`);
    },
    /**
     * Algo que a publicação não conseguiu fazer sozinha e que precisa de alguém. `assunto`
     * evita dizer a mesma coisa duas vezes (ex.: a idade, apontada antes e depois do envio).
     */
    pendente(texto, assunto = texto) {
      if (assuntos.has(assunto)) return;
      assuntos.add(assunto);
      pendencias.push(limpar(texto));
      escrever(`  ✖ PENDENTE: ${texto}\n`);
    },
    get pendencias() {
      return [...pendencias];
    },

    /**
     * Fecha a execução. `fatal` = o motivo de ter parado (ou null se terminou);
     * `foraDaApi` = lembretes do que nenhum programa consegue fazer pela API da Apple.
     */
    resumo({ fatal = null, foraDaApi = [], depois = [] } = {}) {
      const bloco = (titulo, itens, marca) =>
        itens.length ? `${titulo}\n${itens.map((i) => `  ${marca} ${i}`).join('\n')}\n` : '';
      const fora = foraDaApi.map(limpar);
      const texto =
        `\n════════ RESUMO DA PUBLICAÇÃO ════════\n` +
        (fatal ? `✖ PAROU: ${limpar(fatal)}\n\n` : '') +
        (bloco('Feito:', feitos, '✔') || 'Feito: nada ainda.\n') +
        bloco(`Avisos (${avisos.length}):`, avisos, '⚠') +
        bloco(`Pendências — o que ainda precisa de alguém (${pendencias.length}):`, pendencias, '✖') +
        bloco('Fora do alcance da API da Apple:', fora, '•') +
        (depois.length ? `\n${depois.map(limpar).join('\n')}\n` : '');
      process.stdout.write(texto);

      if (process.env.GITHUB_ACTIONS === 'true') {
        for (const a of avisos) process.stdout.write(`::warning title=App Store — aviso::${anotacao(a)}\n`);
        for (const p of pendencias) process.stdout.write(`::error title=App Store — pendência::${anotacao(p)}\n`);
        if (fatal) process.stdout.write(`::error title=App Store — parou::${anotacao(limpar(fatal))}\n`);
      }
      const arquivo = process.env.GITHUB_STEP_SUMMARY;
      if (arquivo) {
        const lista = (itens) => itens.map((i) => `- ${i}`).join('\n');
        const md = [
          '## Publicação na App Store',
          fatal ? `**Parou:** ${limpar(fatal)}` : '**Terminou.**',
          feitos.length ? `### Feito\n${lista(feitos)}` : '',
          avisos.length ? `### Avisos\n${lista(avisos)}` : '',
          pendencias.length ? `### Pendências — o que ainda precisa de alguém\n${lista(pendencias)}` : '',
          fora.length ? `### Fora do alcance da API da Apple\n${lista(fora)}` : '',
        ]
          .filter(Boolean)
          .join('\n\n');
        try {
          appendFileSync(arquivo, `${md}\n`);
        } catch {
          /* sem resumo na página, o log já tem tudo */
        }
      }
    },
  };
}
