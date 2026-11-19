/**
 * O "Digitar código" (`components/CodigoManual.tsx`): o que dá para mandar, uma abertura e um
 * código, a câmera parada com a caixa na frente dela — e a tela do leitor ligado (o celular como
 * leitor do computador, ADR-43/47), que não tinha a caixa: a etiqueta de barras ilegíveis não
 * saía do celular.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  codigoDigitado,
  criarDigitacao,
  MAX_CODIGO_DIGITADO,
  MIN_CODIGO_DIGITADO,
  type DependenciasDaDigitacao,
} from './codigoDigitado';
import { decidirLeitura, ESPERA_QUALQUER, type EstadoLeitura } from './leitura';

const EAN = '7891234567895';

// ------------------------------------------------------------------ o que dá para mandar

test('o código digitado sai sem os espaços das pontas', () => {
  assert.equal(codigoDigitado(` ${EAN} `), EAN);
  assert.equal(codigoDigitado(EAN), EAN);
});

test('menos de 4 caracteres é engano de dedo; vazio e só espaço também não saem', () => {
  assert.equal(MIN_CODIGO_DIGITADO, 4);
  assert.equal(codigoDigitado(''), null);
  assert.equal(codigoDigitado('    '), null);
  assert.equal(codigoDigitado('123'), null);
  assert.equal(codigoDigitado('  123  '), null);
  assert.equal(codigoDigitado('1234'), '1234');
});

test('o teto é o do servidor para a leitura que vai ao computador, contado como ele conta', () => {
  // `MAX_CODIGO_LIDO` em api/app/modules/leitor/schemas.py: passou dele, o bipe voltava 422 e
  // virava "não enviado" sem dizer por quê. Mudou lá, este teste cai até mudar aqui.
  const schemas = readFileSync(
    join(__dirname, '..', '..', '..', 'api', 'app', 'modules', 'leitor', 'schemas.py'),
    'utf8',
  );
  const teto = /^MAX_CODIGO_LIDO\s*=\s*(\d+)\s*$/m.exec(schemas);
  assert.ok(teto, 'o teto do servidor mudou de nome: o espelho não provaria nada');
  assert.equal(MAX_CODIGO_DIGITADO, Number(teto[1]));
  assert.equal(codigoDigitado('7'.repeat(MAX_CODIGO_DIGITADO)), '7'.repeat(MAX_CODIGO_DIGITADO));
  assert.equal(codigoDigitado('7'.repeat(MAX_CODIGO_DIGITADO + 1)), null);
  // O servidor conta pontos de código (Python), não metades de UTF-16.
  const largo = '𝟕'.repeat(MAX_CODIGO_DIGITADO);
  assert.equal(largo.length, MAX_CODIGO_DIGITADO * 2);
  assert.equal(codigoDigitado(largo), largo);
});

test('caractere de controle não sai: viraria tecla no campo do computador', () => {
  for (const c of ['\t', '\n', '\r', '\u0000', '\u001b', '\u007f', '\u0085', '\u009f']) {
    assert.equal(codigoDigitado(`7891${c}234`), null, JSON.stringify(c));
  }
  // Espaço no meio não é controle (Code 128 tem), e o servidor também aceita.
  assert.equal(codigoDigitado('AB 1234'), 'AB 1234');
});

// ------------------------------------------------------------------ uma abertura, um código

/** As dependências de mentira, com o diário do que aconteceu, na ordem. */
function arnes(extra: Partial<DependenciasDaDigitacao> = {}) {
  const diario: string[] = [];
  const dep: DependenciasDaDigitacao = {
    pausar: () => diario.push('pausar'),
    retomar: () => diario.push('retomar'),
    entregar: (codigo) => diario.push(`entregar:${codigo}`),
    ...extra,
  };
  return { diario, digitacao: criarDigitacao(dep) };
}

test('abrir para a câmera; o código digitado sai limpo e a câmera volta depois dele', () => {
  const { diario, digitacao } = arnes();
  digitacao.abrir();
  assert.deepEqual(diario, ['pausar']);
  assert.equal(digitacao.aberta(), true);
  assert.equal(digitacao.confirmar(`  ${EAN} `), true);
  assert.deepEqual(diario, ['pausar', `entregar:${EAN}`, 'retomar']);
  assert.equal(digitacao.aberta(), false);
});

test('o segundo toque antes de a caixa sumir não manda a peça de novo', () => {
  // No leitor do computador, o toque duplo em "Enviar" (ou o Enter junto com o botão) seria a
  // mesma peça duas vezes no carrinho de lá.
  const { diario, digitacao } = arnes();
  digitacao.abrir();
  assert.equal(digitacao.confirmar(EAN), true);
  assert.equal(digitacao.confirmar(EAN), false);
  assert.equal(diario.filter((d) => d.startsWith('entregar')).length, 1);
  assert.equal(diario.filter((d) => d === 'retomar').length, 1);
});

test('código que não dá para mandar: nada sai, a caixa fica e a câmera segue parada', () => {
  const { diario, digitacao } = arnes();
  digitacao.abrir();
  assert.equal(digitacao.confirmar('12'), false);
  assert.equal(digitacao.confirmar('7'.repeat(MAX_CODIGO_DIGITADO + 1)), false);
  assert.equal(digitacao.aberta(), true);
  assert.deepEqual(diario, ['pausar']);
  // Corrigido o número, sai.
  assert.equal(digitacao.confirmar(EAN), true);
  assert.deepEqual(diario, ['pausar', `entregar:${EAN}`, 'retomar']);
});

test('voltar fecha sem mandar nada e devolve a câmera uma vez só', () => {
  const { diario, digitacao } = arnes();
  digitacao.abrir();
  digitacao.fechar();
  digitacao.fechar(); // o voltar do Android depois do "Voltar", ou a tela saindo em seguida
  assert.deepEqual(diario, ['pausar', 'retomar']);
  assert.equal(digitacao.confirmar(EAN), false, 'fechada, o Enter atrasado não manda nada');
  assert.deepEqual(diario, ['pausar', 'retomar']);
});

test('abrir duas vezes não para a câmera duas vezes: cada pausar tem um retomar', () => {
  const { diario, digitacao } = arnes();
  digitacao.abrir();
  digitacao.abrir();
  assert.equal(digitacao.confirmar(EAN), true);
  digitacao.abrir();
  digitacao.fechar();
  assert.deepEqual(diario, ['pausar', `entregar:${EAN}`, 'retomar', 'pausar', 'retomar']);
});

test('quem recebe o código falhou: a câmera volta mesmo assim', () => {
  const { diario, digitacao } = arnes({
    entregar: () => {
      throw new Error('a tela saiu');
    },
  });
  digitacao.abrir();
  assert.throws(() => digitacao.confirmar(EAN), /a tela saiu/);
  assert.deepEqual(diario, ['pausar', 'retomar']);
  assert.equal(digitacao.aberta(), false);
});

test('com a caixa aberta a etiqueta embaixo da lente não vira bipe; fechada, as travas recomeçam', () => {
  // O Scanner de mentira: `pausar`/`retomar` fazem o que o `ScannerRef` faz com o estado que
  // `decidirLeitura` lê (lib/leitura.ts).
  let agora = 10_000;
  let estado: EstadoLeitura = {
    ultimoCodigo: null,
    instanteUltimoCodigo: 0,
    instanteQualquer: 0,
    pausado: false,
    ocupado: false,
  };
  const entregues: string[] = [];
  const digitacao = criarDigitacao({
    pausar: () => {
      estado = { ...estado, pausado: true };
    },
    retomar: () => {
      estado = { ...estado, pausado: false, instanteUltimoCodigo: agora, instanteQualquer: agora };
    },
    entregar: (codigo) => entregues.push(codigo),
  });

  digitacao.abrir();
  agora += 5_000;
  assert.equal(decidirLeitura(estado, '2000000000017', agora), 'ignorar');
  assert.equal(digitacao.confirmar(EAN), true);
  assert.deepEqual(entregues, [EAN]);
  // A etiqueta que ficou embaixo da lente espera a trava curta, como depois de um diálogo.
  assert.equal(decidirLeitura(estado, '2000000000017', agora + ESPERA_QUALQUER - 1), 'ignorar');
  assert.equal(decidirLeitura(estado, '2000000000017', agora + ESPERA_QUALQUER), 'ler');
});

// ------------------------------------------------------------------ as telas

/** O JSX que `LeitorPareado` devolve: do `return (` da função até o fim dela. */
function retornoDoLeitorPareado(fonte: string): string {
  const inicio = fonte.indexOf('export function LeitorPareado(');
  assert.ok(inicio >= 0, 'LeitorPareado sumiu: a guarda não provaria nada');
  const corpo = fonte.slice(inicio);
  const ret = corpo.indexOf('return (');
  return corpo.slice(ret, corpo.indexOf('\n}\n', ret));
}

/** As props de um elemento JSX: do `<Nome` até o `>` (ou `/>`) que o fecha. */
function propsDe(jsx: string, nome: string): string {
  const inicio = jsx.indexOf(`<${nome}`);
  assert.ok(inicio >= 0, `não há <${nome}> no JSX`);
  let chaves = 0;
  let fim = inicio;
  for (; fim < jsx.length && !(jsx[fim] === '>' && chaves === 0); fim += 1) {
    if (jsx[fim] === '{') chaves += 1;
    else if (jsx[fim] === '}') chaves -= 1;
  }
  return jsx.slice(inicio, fim + 1);
}

/** O corpo de `const nome = useCallback(() => { ... }, [...])`. */
function corpoDoCallback(fonte: string, nome: string): string {
  const m = new RegExp(`const ${nome} = useCallback\\(\\(\\) => \\{([\\s\\S]*?)\\n  \\}, \\[`).exec(fonte);
  assert.ok(m, `${nome} não é mais um useCallback: a guarda não provaria nada`);
  return m[1];
}

test('o leitor ligado tem o "Digitar código", e o código vai pelo mesmo caminho da câmera', () => {
  const fonte = readFileSync(join(__dirname, '..', 'components', 'LeitorPareado.tsx'), 'utf8');
  const jsx = retornoDoLeitorPareado(fonte);
  assert.match(jsx, /<CodigoManual\b/, 'a tela do leitor ligado não oferece "Digitar código"');
  const caixa = propsDe(jsx, 'CodigoManual');
  const scanner = propsDe(jsx, 'Scanner');
  // O mesmo `aoLer` da câmera: o `ler` da fila, com o client_uuid e a instalação (leitorStore).
  assert.match(caixa, /\baoConfirmar=\{aoLer\}/);
  assert.match(scanner, /\baoLer=\{aoLer\}/);
  assert.match(fonte, /const aoLer = useCallback\(\(codigo: string\) => ler\(codigo\), \[ler\]\)/);
  assert.match(fonte, /const ler = useLeitorStore\(\(e\) => e\.ler\)/);
  assert.match(caixa, /\bacao="Enviar"/, 'no leitor o botão manda ao computador, não "Buscar"');
  // Fora do Scanner: com o app no fundo a câmera sai de cena e volta nova; a caixa fica.
  assert.doesNotMatch(scanner, /CodigoManual/);
  // Abrindo a rolagem, colado na câmera: numa faixa fixa entre a câmera e a rolagem, ele comia a
  // altura da lista e do "Desligar" no SE com o Texto Maior (a régua da D3).
  const rolagem = jsx.indexOf('<ScrollView');
  const codigo = jsx.indexOf('<CodigoManual');
  assert.ok(rolagem > jsx.indexOf('style={s.cameraArea}'), 'a ordem câmera → rolagem mudou');
  assert.ok(
    codigo > rolagem && codigo < jsx.indexOf('</ScrollView>') && codigo < jsx.indexOf('<OutrosChamando'),
    'o "Digitar código" não abre a rolagem (antes dos outros chamados)',
  );
});

test('o leitor ligado para a câmera com a caixa aberta e a devolve ao fechar', () => {
  const fonte = readFileSync(join(__dirname, '..', 'components', 'LeitorPareado.tsx'), 'utf8');
  const caixa = propsDe(retornoDoLeitorPareado(fonte), 'CodigoManual');
  const abrir = /\baoAbrir=\{(\w+)\}/.exec(caixa);
  const fechar = /\baoFechar=\{(\w+)\}/.exec(caixa);
  assert.ok(abrir && fechar, 'a caixa não avisa a tela quando abre e fecha: a câmera lê por baixo dela');
  const corpoAbrir = corpoDoCallback(fonte, abrir[1]);
  const corpoFechar = corpoDoCallback(fonte, fechar[1]);
  assert.match(corpoAbrir, /scanner\.current\?\.pausar\(\)/);
  assert.match(corpoFechar, /scanner\.current\?\.retomar\(\)/);
  // E no estado da TELA, como no "Desligar?": a câmera que volta com o app (nova, sem a pausa
  // de dentro do Scanner) nasce parada enquanto a caixa estiver aberta.
  const estado = /set(\w+)\(true\)/.exec(corpoAbrir);
  assert.ok(estado, 'abrir a caixa não marca o estado da tela');
  assert.match(corpoFechar, new RegExp(`set${estado[1]}\\(false\\)`));
  const variavel = estado[1][0].toLowerCase() + estado[1].slice(1);
  const ativo = /\bativo=\{([^}]*)\}/.exec(propsDe(retornoDoLeitorPareado(fonte), 'Scanner'));
  assert.ok(ativo);
  assert.match(ativo[1], new RegExp(`!${variavel}\\b`), `o "ativo" do Scanner não olha ${variavel}`);
});

test('a caixa do "Digitar código" segue as regras da lib e cabe na tela com o Texto Maior', () => {
  const fonte = readFileSync(join(__dirname, '..', 'components', 'CodigoManual.tsx'), 'utf8');
  assert.match(fonte, /criarDigitacao\(\{/, 'a caixa não usa as regras de lib/codigoDigitado.ts');
  assert.match(fonte, /desabilitado=\{codigoDigitado\(codigo\) === null\}/);
  assert.match(fonte, /maxLength=\{MAX_CODIGO_DIGITADO\}/);
  // A tela que sai com a caixa aberta devolve a câmera de quem fica.
  assert.match(fonte, /useEffect\(\(\) => \(\) => digitacao\.fechar\(\), \[digitacao\]\)/);
  assert.match(fonte, /onRequestClose=\{fechar\}/);
  // O texto rola; o campo e os botões ficam fora da rolagem (Texto Maior + teclado no SE).
  const jsx = fonte.slice(fonte.indexOf('<Modal'), fonte.indexOf('</Modal>'));
  const fimDaRolagem = jsx.indexOf('</ScrollView>');
  assert.ok(fimDaRolagem > 0, 'a caixa não tem rolagem');
  assert.ok(jsx.indexOf('<TextInput') > fimDaRolagem, 'o campo entrou na rolagem');
  assert.ok(jsx.indexOf('<Botao') > fimDaRolagem, 'os botões entraram na rolagem');
  const caixa = /\n  caixa: \{([\s\S]*?)\n  \},/.exec(fonte);
  assert.ok(caixa);
  assert.match(caixa[1], /maxHeight: '85%'/);
  assert.match(caixa[1], /flexShrink: 1/);
  // Modal de tela cheia: o topo desce da barra de status e da ilha (CLAUDE.md, área segura).
  assert.match(fonte, /const respiroDeCima = useRespiroDeCima\(\)/);
  assert.match(fonte, /paddingTop: respiroDeCima/);
});
