#!/usr/bin/env node
/**
 * Baixa a gravação de tela do link UMA vez, no começo da rodada do Actions, e devolve o
 * caminho do arquivo (saída `caminho` no $GITHUB_OUTPUT). Os passos seguintes — a conferência
 * do modo completo e a ficha — passam esse CAMINHO ao publicador, não o link: um link
 * pré-assinado (S3, BrowserStack) pode vencer durante os 20 a 120 min de compilação.
 *
 *   node publicar/baixar-video.mjs <https://...> <pasta>
 *
 * O vídeo é conferido aqui (MP4/MOV de verdade, no tamanho) — link quebrado para a rodada
 * antes de gastar qualquer minuto de compilação.
 */

import { appendFileSync } from 'node:fs';
import { guardarVideo } from './anexos.mjs';

const [origem, pasta] = process.argv.slice(2);
if (!origem || !pasta) {
  process.stderr.write('Uso: node publicar/baixar-video.mjs <https://...> <pasta>\n');
  process.exit(2);
}
try {
  const caminho = await guardarVideo(origem, pasta);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `caminho=${caminho}\n`);
  process.stdout.write(`✔ Gravação de tela baixada e conferida: ${caminho}\n`);
} catch (erro) {
  process.stderr.write(`✖ ${erro.message}\n`);
  process.exitCode = 1;
}
