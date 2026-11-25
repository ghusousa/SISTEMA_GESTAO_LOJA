/**
 * O link "instale grátis" da tela "Conectar à loja" (Apple 3.2: o app só vai à lista pública
 * porque qualquer loja instala o servidor sozinha). Reprova se o link sair da tela, se a âncora
 * não apontar para o título "## Instalação" do README ou se o README perder a licença aberta.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { CHAMADA_DO_GUIA, GUIA_DE_INSTALACAO } from './instalacaoDoServidor';

const raiz = join(__dirname, '..', '..', '..');

test('o link leva ao título "Instalação" do README do repositório aberto', () => {
  const url = new URL(GUIA_DE_INSTALACAO);
  assert.equal(url.origin, 'https://github.com');
  assert.equal(url.pathname, '/ghusousa/SISTEMA_GESTAO_LOJA');
  assert.equal(decodeURIComponent(url.hash), '#instalação');
  const readme = readFileSync(join(raiz, 'README.md'), 'utf8');
  assert.match(readme, /^## Instalação$/m, 'o README não tem mais o título "## Instalação": a âncora do link quebrou');
  assert.match(readFileSync(join(raiz, 'LICENSE'), 'utf8'), /^MIT License/, 'a licença aberta é o que a resposta à Apple (3.2) promete');
});

test('a tela "Conectar à loja" mostra o link para quem ainda não tem o sistema', () => {
  const tela = readFileSync(join(raiz, 'mobile', 'src', 'app', '(auth)', 'servidor.tsx'), 'utf8');
  assert.match(tela, /Linking\.openURL\(GUIA_DE_INSTALACAO\)/);
  assert.match(tela, /\{CHAMADA_DO_GUIA\}/);
  assert.ok(CHAMADA_DO_GUIA.startsWith('Ainda não tem o sistema na loja?'));
});
