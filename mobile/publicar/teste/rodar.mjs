/**
 * Teste de ponta a ponta do publicador: sobe a App Store de mentira, gera uma
 * chave descartável, roda `publicar.mjs --enviar` de verdade contra ela e confere
 * que TUDO chegou: textos, categorias, idade, capturas (bytes e ordem), conta
 * demo, preço, build e o envio para revisão.
 *
 *   node publicar/teste/rodar.mjs
 */

import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { subirMock } from './mock-asc.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, '..', '..', '..');

const { porta, fechar } = await subirMock();

// chave EC igual à da Apple, só que descartável
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pasta = mkdtempSync(join(tmpdir(), 'publicar-teste-'));
writeFileSync(join(pasta, 'chave-apple.p8'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
writeFileSync(
  join(pasta, 'config.json'),
  JSON.stringify({
    key_id: 'TESTE123',
    issuer_id: '00000000-0000-0000-0000-000000000000',
    arquivo_p8: 'chave-apple.p8',
    email_suporte: 'suporte@teste.dev',
    url_suporte: 'https://sistemaobras.com.br',
    nome_contato: 'Dona Teste',
    telefone_contato: '+55 11 90000-0000',
    titular_copyright: 'Loja Teste',
    email_demo: 'revisao@teste.dev',
    senha_demo: 'segredo-demo',
    codigo_demo: '7890000000000',
    url_etiquetas_demo: '',
  }),
);

// spawn assíncrono, nunca spawnSync: o mock roda NESTE processo, e o síncrono
// congelaria o loop — o publicador perguntaria e ninguém responderia.
const codigo = await new Promise((resolver) => {
  const filho = spawn(process.execPath, [join(AQUI, '..', 'publicar.mjs'), '--enviar'], {
    env: { ...process.env, ASC_BASE: `http://127.0.0.1:${porta}`, PUBLICAR_CONFIG: join(pasta, 'config.json') },
    stdio: 'inherit',
  });
  filho.on('exit', resolver);
});
if (codigo !== 0) {
  console.error('\n✖ o publicador terminou com erro');
  process.exit(1);
}

const estado = await (await fetch(`http://127.0.0.1:${porta}/_estado`)).json();
fechar();

const capturasNaPasta = readdirSync(join(RAIZ, 'media', 'app-store', 'iphone-6.5')).filter((a) =>
  a.endsWith('.png'),
).length;
const recebidas = Object.values(estado.capturas);

let falhas = 0;
const conferir = (condicao, rotulo) => {
  console.log(`${condicao ? '✔' : '✖'} ${rotulo}`);
  if (!condicao) falhas += 1;
};

conferir(estado.app.primaryLocale === 'pt-BR', 'idioma principal virou pt-BR');
conferir(estado.infoLoc?.name === 'Gestão de Loja', 'nome na ficha');
conferir([...(estado.infoLoc?.subtitle ?? '')].length <= 30, 'subtítulo dentro do limite');
conferir(estado.infoLoc?.privacyPolicyUrl?.includes('/privacidade'), 'URL de privacidade');
conferir(estado.categorias?.principal === 'BUSINESS' && estado.categorias?.secundaria === 'PRODUCTIVITY', 'categorias');
conferir(estado.idade?.gambling === false && estado.idade?.violenceRealistic === 'NONE', 'classificação etária toda "não"');
conferir(estado.versao?.copyright?.includes('Loja Teste'), 'copyright');
conferir(estado.versao?.releaseType === 'AFTER_APPROVAL', 'libera sozinho depois de aprovado');
conferir([...(estado.versaoLoc?.description ?? '')].length > 1000, 'descrição foi inteira');
conferir([...(estado.versaoLoc?.keywords ?? '')].length === 100, 'palavras-chave nos 100 caracteres');
conferir(estado.versaoLoc?.whatsNew === undefined, 'sem "Novidades" na primeira versão');
conferir(recebidas.length === capturasNaPasta && capturasNaPasta >= 10, `capturas: ${recebidas.length} de ${capturasNaPasta}`);
conferir(recebidas.every((c) => c.confirmada && c.bytesRecebidos === c.esperado), 'todas subiram inteiras e foram confirmadas');
conferir(estado.ordem?.length === recebidas.length, 'ordem das capturas gravada');
conferir(estado.revisao?.demoAccountName === 'revisao@teste.dev' && estado.revisao?.demoAccountRequired === true, 'conta demo do revisor');
conferir(estado.revisao?.notes?.includes('7890000000000'), 'código demo entrou nas notas');
conferir(!estado.revisao?.notes?.includes('{{'), 'nenhum {{marcador}} sobrou nos textos');
conferir(estado.preco === 'PP0', 'preço grátis');
conferir(estado.buildPreso === 'B1', 'build preso à versão');
conferir(estado.envio?.enviado === true && estado.envio?.itens === 1, 'ENVIADO para revisão');

if (falhas) {
  console.error(`\n✖ ${falhas} verificação(ões) falharam`);
  process.exit(1);
}
console.log('\nTudo certo: o publicador faz a Fase 6 inteira sozinho.');
