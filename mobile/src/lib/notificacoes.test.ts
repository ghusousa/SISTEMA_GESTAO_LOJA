/**
 * Notificações do chamado do leitor (ADR-47), a parte sem sistema nem rede. O que importa:
 * o toque só liga o leitor com um chamado de verdade e recente, o app só pede a permissão
 * quando o servidor manda push (E1: nasce desligado), e o token que sai daqui é um que o
 * servidor aceita.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  avisoDasNotificacoes,
  comoRegistrar,
  comportamentoNoPrimeiroPlano,
  ehChamadoDoLeitor,
  instanteDaNotificacao,
  lerPermissao,
  lerPushDoServidor,
  MAX_TOKEN,
  podeReceberPush,
  PRAZO_DA_RESPOSTA_MS,
  precisaRegistrarDeNovo,
  pushDoServidor,
  respostaAindaVale,
  situacaoNaTela,
  tokenValido,
  trocaDoTokenDoAparelho,
  UMA_HORA_MS,
  type UltimoRegistro,
} from './notificacoes';

test('chamado do leitor: o tipo certo e um sinal no formato dígito-letra-dígito', () => {
  assert.equal(ehChamadoDoLeitor({ tipo: 'leitor-chamado', sinal: '7K3' }), true);
  assert.equal(ehChamadoDoLeitor({ tipo: 'leitor-chamado', sinal: '2A9', extra: 1 }), true);
});

test('chamado do leitor: o resto não liga leitor nenhum', () => {
  const recusados: unknown[] = [
    null,
    undefined,
    'leitor-chamado',
    {},
    { tipo: 'leitor-chamado' },
    { sinal: '7K3' },
    { tipo: 'outro', sinal: '7K3' },
    { tipo: 'leitor-chamado', sinal: '7k3' }, // minúscula
    { tipo: 'leitor-chamado', sinal: '1K3' }, // 1 se confunde com I
    { tipo: 'leitor-chamado', sinal: '0K3' },
    { tipo: 'leitor-chamado', sinal: '7I3' }, // sem I
    { tipo: 'leitor-chamado', sinal: '7O3' }, // sem O
    { tipo: 'leitor-chamado', sinal: '7K' },
    { tipo: 'leitor-chamado', sinal: '7K33' },
    { tipo: 'leitor-chamado', sinal: ' 7K3' },
    { tipo: 'leitor-chamado', sinal: 723 },
  ];
  for (const dados of recusados) assert.equal(ehChamadoDoLeitor(dados), false, JSON.stringify(dados));
});

test('o instante da notificação: segundos (iOS) viram ms, ms (Android) ficam', () => {
  assert.equal(instanteDaNotificacao(1_763_560_000), 1_763_560_000_000);
  assert.equal(instanteDaNotificacao(1_763_560_000.5), 1_763_560_000_500);
  assert.equal(instanteDaNotificacao(1_763_560_000_000), 1_763_560_000_000);
  assert.ok(Number.isNaN(instanteDaNotificacao(Number.NaN)));
  assert.ok(Number.isNaN(instanteDaNotificacao(0)));
  assert.ok(Number.isNaN(instanteDaNotificacao(-5)));
});

test('a resposta à notificação liga o leitor só dentro dos 5 min do chamado', () => {
  const chegou = 1_763_560_000_000;
  assert.equal(respostaAindaVale(chegou, chegou), true);
  assert.equal(respostaAindaVale(chegou, chegou + PRAZO_DA_RESPOSTA_MS), true, 'no limite ainda vale');
  assert.equal(respostaAindaVale(chegou, chegou + PRAZO_DA_RESPOSTA_MS + 1), false, 'velha: só abre o app');
  assert.equal(respostaAindaVale(chegou, chegou + 60 * 60_000), false);
  assert.equal(respostaAindaVale(chegou + 30_000, chegou), true, 'relógio um pouco atrás');
  assert.equal(respostaAindaVale(chegou + 10 * 60_000, chegou), false, 'do futuro não é recente');
  assert.equal(respostaAindaVale(Number.NaN, chegou), false);
});

test('com o app na frente, o chamado não vira banner (quem mostra é a faixa)', () => {
  assert.deepEqual(comportamentoNoPrimeiroPlano({ tipo: 'leitor-chamado', sinal: '7K3' }), {
    shouldShowBanner: false,
    shouldShowList: false,
    shouldPlaySound: false,
    shouldSetBadge: false,
  });
  const outro = comportamentoNoPrimeiroPlano({ tipo: 'outra-coisa' });
  assert.equal(outro.shouldShowBanner, true);
  assert.equal(outro.shouldShowList, true);
  assert.equal(outro.shouldSetBadge, false);
});

test('o push do servidor: só `true` de verdade; servidor antigo (sem o campo) é desligado', () => {
  assert.equal(pushDoServidor({ notificacoes_push: true }), true);
  for (const valor of [false, 'true', 1, null, undefined]) {
    assert.equal(pushDoServidor({ notificacoes_push: valor }), false, String(valor));
  }
  assert.equal(pushDoServidor({}), false);
  assert.equal(pushDoServidor(null), false);
  assert.equal(pushDoServidor(undefined), false);
});

test('a permissão do sistema: só `granted` libera; `denied` é recusa; o resto ainda pergunta', () => {
  assert.equal(lerPermissao({ granted: true, status: 'granted' }), 'liberada');
  assert.equal(lerPermissao({ granted: false, status: 'denied' }), 'negada');
  assert.equal(lerPermissao({ granted: false, status: 'undetermined' }), 'indefinida');
  assert.equal(lerPermissao(null), 'indefinida');
});

const IOS = { plataforma: 'ios', expoGo: false, pushNoServidor: true };

test('só o iPhone fora do Expo Go, num servidor com push, chega a falar de permissão', () => {
  assert.equal(podeReceberPush(IOS), true);
  assert.equal(podeReceberPush({ ...IOS, pushNoServidor: false }), false, 'push nasce desligado (E1)');
  assert.equal(podeReceberPush({ ...IOS, expoGo: true }), false);
  assert.equal(podeReceberPush({ ...IOS, plataforma: 'android' }), false, 'sem FCM nesta versão');
  assert.equal(podeReceberPush({ ...IOS, plataforma: 'web' }), false);
});

test('como registrar: iOS liberado manda o token; o resto registra sem; o web não registra', () => {
  assert.equal(comoRegistrar({ ...IOS, permissao: 'liberada' }), 'com-token');
  assert.equal(comoRegistrar({ ...IOS, permissao: 'negada' }), 'sem-token');
  assert.equal(comoRegistrar({ ...IOS, permissao: 'indefinida' }), 'sem-token');
  assert.equal(comoRegistrar({ ...IOS, plataforma: 'android', permissao: null }), 'sem-token');
  assert.equal(comoRegistrar({ ...IOS, expoGo: true, permissao: null }), 'sem-token');
  assert.equal(comoRegistrar({ ...IOS, plataforma: 'web', permissao: null }), 'nao-registra');
});

test('servidor sem push (E1): registra sem token mesmo com a permissão dada', () => {
  // O registro continua: é ele que faz o SEM_CELULAR do computador dizer a verdade.
  assert.equal(comoRegistrar({ ...IOS, pushNoServidor: false, permissao: 'liberada' }), 'sem-token');
  assert.equal(comoRegistrar({ ...IOS, pushNoServidor: false, plataforma: 'android', permissao: null }), 'sem-token');
});

test('a linha da tela do leitor, estado por estado', () => {
  const ios = { plataforma: 'ios', expoGo: false };
  assert.equal(situacaoNaTela({ ...ios, push: null, permissao: null }), 'lendo');
  assert.equal(situacaoNaTela({ ...ios, push: 'desligado', permissao: null }), 'servidor-sem-push');
  assert.equal(situacaoNaTela({ ...ios, push: 'desligado', permissao: 'liberada' }), 'servidor-sem-push');
  assert.equal(situacaoNaTela({ ...ios, push: 'ligado', permissao: null }), 'lendo');
  assert.equal(situacaoNaTela({ ...ios, push: 'ligado', permissao: 'liberada' }), 'liberada');
  assert.equal(situacaoNaTela({ ...ios, push: 'ligado', permissao: 'negada' }), 'abrir-ajustes');
  assert.equal(situacaoNaTela({ ...ios, push: 'ligado', permissao: 'indefinida' }), 'pedir');
  for (const aparelho of [
    { plataforma: 'android', expoGo: false },
    { plataforma: 'ios', expoGo: true },
    { plataforma: 'web', expoGo: false },
  ]) {
    assert.equal(situacaoNaTela({ ...aparelho, push: 'ligado', permissao: null }), 'sem-suporte');
  }
});

test('o modo do push: campo AUSENTE é servidor antigo, diferente de `false` (servidor novo sem push)', () => {
  assert.equal(lerPushDoServidor({ notificacoes_push: true }), 'ligado');
  assert.equal(lerPushDoServidor({ notificacoes_push: false }), 'desligado');
  // Veio, mas torto: o servidor é novo, e o push não está ligado.
  for (const valor of ['true', 1, null, undefined]) {
    assert.equal(lerPushDoServidor({ notificacoes_push: valor }), 'desligado', String(valor));
  }
  assert.equal(lerPushDoServidor({}), 'servidor-antigo');
  assert.equal(lerPushDoServidor({ nome: 'Loja', segmento: 'ROUPAS' } as { notificacoes_push?: unknown }), 'servidor-antigo');
});

test('servidor antigo (sem o campo): a tela do leitor não promete o chamado — nenhuma linha', () => {
  // App novo, VPS ainda sem a ADR-47: lá o computador nem tem o botão do chamado.
  const ios = { plataforma: 'ios', expoGo: false };
  for (const aparelho of [ios, { plataforma: 'android', expoGo: false }, { plataforma: 'web', expoGo: false }]) {
    for (const permissao of [null, 'liberada', 'negada', 'indefinida'] as const) {
      const situacao = situacaoNaTela({ ...aparelho, push: lerPushDoServidor({}), permissao });
      assert.equal(situacao, 'servidor-antigo', `${aparelho.plataforma}/${permissao}`);
      assert.equal(avisoDasNotificacoes(situacao), null);
    }
  }
  // O servidor novo com o push desligado continua dizendo a verdade: com o app aberto, chega.
  assert.equal(
    avisoDasNotificacoes(situacaoNaTela({ ...ios, push: lerPushDoServidor({ notificacoes_push: false }), permissao: null }))
      ?.texto,
    'O chamado do computador aparece aqui com o app aberto.',
  );
});

test('o texto da linha: recusada leva aos Ajustes; o resto só informa; pedir e lendo não mostram nada', () => {
  assert.deepEqual(avisoDasNotificacoes('abrir-ajustes'), {
    texto: 'Notificações desligadas: o chamado do computador só aparece com o app aberto.',
    botao: 'Abrir Ajustes',
  });
  assert.equal(avisoDasNotificacoes('liberada')?.texto, 'O computador chama este celular mesmo com o app fechado.');
  assert.equal(avisoDasNotificacoes('sem-suporte')?.texto, 'Neste aparelho o chamado só aparece com o app aberto.');
  assert.equal(avisoDasNotificacoes('liberada')?.botao, null);
  assert.equal(avisoDasNotificacoes('pedir'), null);
  assert.equal(avisoDasNotificacoes('lendo'), null);
});

test('servidor sem push: a linha não fala de chave, de Apple nem de permissão', () => {
  const aviso = avisoDasNotificacoes('servidor-sem-push');
  assert.ok(aviso);
  assert.equal(aviso.botao, null);
  assert.match(aviso.texto, /app aberto/);
  assert.doesNotMatch(aviso.texto, /Apple|APNs|chave|permit|Ajustes/i);
});

test('o token: o mesmo que o servidor aceita (espelho de validar_token)', () => {
  assert.equal(tokenValido('ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]'), 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]');
  assert.equal(tokenValido('ExpoPushToken[abc]'), 'ExpoPushToken[abc]');
  assert.equal(tokenValido('  ExponentPushToken[abc]\n'), 'ExponentPushToken[abc]', 'aparado, como no servidor');
  const noLimite = `ExponentPushToken[${'a'.repeat(MAX_TOKEN - 19)}]`;
  assert.equal(noLimite.length, MAX_TOKEN);
  assert.equal(tokenValido(noLimite), noLimite);
});

test('o token: o que o servidor recusaria com 422 não sai do app', () => {
  const recusados: unknown[] = [
    '',
    '   ',
    'abc',
    'ExponentPushToken[abc', // sem "]"
    'ExponentPushToken[a b]', // com espaço
    'ExponentPushToken[a\nb]', // com quebra de linha
    'ExponentPushToken[a\u0007b]', // controle
    'ExponentPushToken[a\u0085b]', // controle C1
    `ExponentPushToken[${'a'.repeat(MAX_TOKEN - 18)}]`, // 201 caracteres
    'PushToken[abc]',
    null,
    undefined,
    42,
  ];
  for (const token of recusados) assert.equal(tokenValido(token), null, JSON.stringify(token));
});

test('o token conta caracteres como o Python, não unidades de UTF-16', () => {
  // 181 emojis: 181 caracteres + 19 = 200 (cabe), mas 362 unidades de UTF-16.
  const comEmoji = `ExponentPushToken[${'😀'.repeat(MAX_TOKEN - 19)}]`;
  assert.equal(tokenValido(comEmoji), comEmoji);
});

test('troca do token do aparelho: o eco do próprio registro não registra de novo (sem laço de PUTs)', () => {
  // O registro pede o token; o iOS responde com o MESMO evento. Durante o registro, nunca.
  assert.deepEqual(trocaDoTokenDoAparelho({ anterior: null, recebido: 'abc', registrando: true }), {
    valor: 'abc',
    registrar: false,
  });
  // Depois, o mesmo token de novo: nada.
  assert.equal(trocaDoTokenDoAparelho({ anterior: 'abc', recebido: 'abc', registrando: false }).registrar, false);
  // O sistema trocou o token de verdade, sem registro no ar: registra.
  assert.deepEqual(trocaDoTokenDoAparelho({ anterior: 'abc', recebido: 'def', registrando: false }), {
    valor: 'def',
    registrar: true,
  });
  // Primeira vez fora de um registro (o evento chegou atrasado): uma rodada só, e o eco dela para.
  const primeira = trocaDoTokenDoAparelho({ anterior: null, recebido: 'abc', registrando: false });
  assert.equal(primeira.registrar, true);
  assert.equal(trocaDoTokenDoAparelho({ anterior: primeira.valor, recebido: 'abc', registrando: false }).registrar, false);
  // Token que não é texto (o do web é objeto): comparado pelo JSON.
  assert.equal(trocaDoTokenDoAparelho({ anterior: '{"a":1}', recebido: { a: 1 }, registrando: false }).registrar, false);
});

const ULTIMO: UltimoRegistro = { base: 'https://loja.x', push: true, permissao: 'liberada', hora: 1_000_000 };

test('volta ao app: registra de novo só quando há motivo', () => {
  const agora = ULTIMO.hora + 10 * 60_000;
  const igual = { ultimo: ULTIMO, agora, base: ULTIMO.base, push: true, permissao: 'liberada' as const };
  assert.equal(precisaRegistrarDeNovo(igual), false, 'dez minutos depois, nada mudou');
  assert.equal(precisaRegistrarDeNovo({ ...igual, ultimo: null }), true, 'nunca registrou (ou falhou)');
  assert.equal(precisaRegistrarDeNovo({ ...igual, base: 'https://outra.x' }), true, 'outro servidor');
  assert.equal(precisaRegistrarDeNovo({ ...igual, agora: ULTIMO.hora + UMA_HORA_MS + 1 }), true, 'mais de 1 h');
  assert.equal(precisaRegistrarDeNovo({ ...igual, push: false }), true, 'o servidor desligou o push');
  assert.equal(precisaRegistrarDeNovo({ ...igual, permissao: 'negada' }), true, 'foi aos Ajustes');
  assert.equal(precisaRegistrarDeNovo({ ...igual, push: null, permissao: null }), false, 'não saber não é motivo');
});

