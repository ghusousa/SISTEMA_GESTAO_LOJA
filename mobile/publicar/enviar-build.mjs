#!/usr/bin/env node
/**
 * Sobe o último build do EAS para o App Store Connect usando a MESMA chave do
 * config.json — para não ter credencial duplicada em dois arquivos.
 *
 *   npm run publicar:build
 *
 * O registro do app tem de existir na conta da Apple: com chave de API ninguém o cria (só o
 * site, uma vez — README desta pasta).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const caminho = process.env.PUBLICAR_CONFIG || join(AQUI, 'config.json');
if (!existsSync(caminho)) {
  console.error(`Não achei ${caminho}. Copie config.exemplo.json para config.json e preencha.`);
  process.exit(1);
}
const config = JSON.parse(readFileSync(caminho, 'utf8'));

const resultado = spawnSync(
  'npx',
  [
    'eas',
    'submit',
    '--platform',
    'ios',
    '--latest',
    '--non-interactive',
    '--asc-api-key-path',
    resolve(dirname(caminho), config.arquivo_p8),
    '--asc-api-key-id',
    config.key_id,
    '--asc-api-key-issuer-id',
    config.issuer_id,
  ],
  { stdio: 'inherit', shell: process.platform === 'win32' },
);
process.exit(resultado.status ?? 1);
