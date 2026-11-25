/**
 * O registro do aparelho para o chamado do leitor (ADR-47), com um iPhone e um servidor de
 * mentira: o que sai para a API, e em que ordem. Os dois buracos que isto fecha:
 * - o dono religa o push e a API reinicia: o app reconecta e lê `true`, mas o token só voltava
 *   ao servidor quando o celular ia ao fundo e voltava (o computador dizia SEM_NOTIFICACAO e a
 *   notificação não chegava);
 * - a limpeza pendente de um servidor que deixou de existir era tentada para sempre, e segurava
 *   o registro no servidor de agora pelos 10 s do teto, a cada abertura do app.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { VALIDADE_DA_LIMPEZA_MS, type Permissao } from './notificacoes';
import { criarRegistroDoAparelho, type DependenciasDoRegistro } from './registroDoAparelho';

const TOKEN = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';
const LOJA = 'https://loja.exemplo';
const ANTIGO = 'http://192.168.0.10:8000';
const DIA_MS = 24 * 60 * 60_000;

/** O servidor respondeu com um status HTTP (o resto é rede caída ou tempo esgotado). */
class RespostaHttp extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

function adiado<T = void>() {
  let resolver!: (valor: T) => void;
  let rejeitar!: (erro: unknown) => void;
  const promessa = new Promise<T>((r, j) => {
    resolver = r;
    rejeitar = j;
  });
  return { promessa, resolver, rejeitar };
}

/** Deixa rodar o que está na fila de microtarefas (e um tique do relógio). */
const assentar = () => new Promise<void>((r) => setTimeout(r, 5));

/** O teste falha (em vez de pendurar) quando a promessa segura mais do que devia. */
async function aTempo<T>(promessa: Promise<T>, ms = 300): Promise<T | 'preso'> {
  let relogio: ReturnType<typeof setTimeout> | undefined;
  const teto = new Promise<'preso'>((r) => {
    relogio = setTimeout(() => r('preso'), ms);
  });
  try {
    return await Promise.race([promessa, teto]);
  } finally {
    clearTimeout(relogio);
  }
}

function montar(sobre: Partial<DependenciasDoRegistro> = {}) {
  const servidor: { push: boolean | null; base: string } = { push: true, base: LOJA };
  const aparelho: { permissao: Permissao | null } = { permissao: 'liberada' };
  /** O que saiu para a API, em ordem: "PUT token" | "PUT null" | "PUT sem campo" | "DELETE <base>". */
  const saidas: string[] = [];
  let cofre: string | null = null;
  let relogio = 1_763_560_000_000;
  const respostasDoDelete = new Map<string, () => Promise<unknown>>();

  const dep: DependenciasDoRegistro = {
    plataforma: 'ios',
    expoGo: false,
    temSessao: async () => true,
    pushNoServidor: async () => servidor.push,
    pushEmCache: () => servidor.push,
    base: () => servidor.base,
    instalacao: async () => (servidor.base === LOJA ? 'inst-loja' : 'inst-outra'),
    permissao: async () => aparelho.permissao,
    token: async () => TOKEN,
    registrar: async (corpo) => {
      const token = corpo.token === undefined ? 'sem campo' : corpo.token === null ? 'null' : 'token';
      saidas.push(`PUT ${token}`);
    },
    esquecer: (base) => {
      saidas.push(`DELETE ${base}`);
      return (respostasDoDelete.get(base) ?? (async () => undefined))();
    },
    respondeu: (erro) => erro instanceof RespostaHttp,
    cofre: {
      ler: async () => cofre,
      gravar: async (texto) => {
        cofre = texto;
      },
      apagar: async () => {
        cofre = null;
      },
    },
    agora: () => relogio,
    esperar: (ms) => new Promise((r) => setTimeout(r, ms)),
    ...sobre,
  };
  return {
    registro: criarRegistroDoAparelho(dep),
    servidor,
    aparelho,
    saidas,
    /** Como o DELETE para esta base responde (o padrão é 204). */
    deleteResponde(base: string, resposta: () => Promise<unknown>) {
      respostasDoDelete.set(base, resposta);
    },
    lerCofre: () => (cofre === null ? null : (JSON.parse(cofre) as Record<string, unknown>)),
    gravarCofre: (valor: unknown) => {
      cofre = JSON.stringify(valor);
    },
    passar: (ms: number) => {
      relogio += ms;
    },
    agora: () => relogio,
  };
}

// ------------------------------------------------------------------ o push religado

test('o dono religa o push: a configuração que chega com o modo novo manda o token na hora', async () => {
  const t = montar();
  t.servidor.push = false;
  await t.registro.preparar();
  assert.deepEqual(t.saidas, ['PUT null'], 'com o push desligado, registra sem token (o servidor apaga o que tinha)');

  // O dono liga NOTIFICACOES_PUSH=expo e a API reinicia; o tempo real religa e refaz a configuração.
  t.servidor.push = true;
  t.registro.aoMudarAConfiguracao(true);
  await assentar();
  assert.deepEqual(t.saidas, ['PUT null', 'PUT token'], 'sem esperar o celular ir ao fundo e voltar');
});

test('o dono desliga o push: a configuração nova apaga o token do servidor na hora', async () => {
  const t = montar();
  await t.registro.preparar();
  t.servidor.push = false;
  t.registro.aoMudarAConfiguracao(false);
  await assentar();
  assert.deepEqual(t.saidas, ['PUT token', 'PUT null']);
});

test('religação do tempo real sem mudança no push: nenhum PUT a mais', async () => {
  const t = montar();
  await t.registro.preparar();
  for (let i = 0; i < 5; i += 1) t.registro.aoMudarAConfiguracao(true);
  t.registro.aoMudarAConfiguracao(null); // servidor fora: nada a decidir
  await assentar();
  assert.deepEqual(t.saidas, ['PUT token']);
});

test('a rodada no ar que ainda vai ler a configuração leva o modo novo: um PUT só', async () => {
  // A 2ª leitura da configuração (a da rodada da volta ao app) fica presa até a nova chegar.
  const presa = adiado<boolean | null>();
  let leituras = 0;
  const t = montar({
    pushNoServidor: () => {
      leituras += 1;
      return leituras === 2 ? presa.promessa : Promise.resolve(t.servidor.push);
    },
  });
  t.servidor.push = false;
  await t.registro.preparar(); // registrado com o push desligado

  t.passar(61 * 60_000);
  t.servidor.push = true;
  const volta = t.registro.naVolta(); // mais de 1 h: registra, e para na leitura
  await assentar();
  // A configuração chega com o push ligado ENQUANTO a rodada espera por ela.
  t.registro.aoMudarAConfiguracao(true);
  presa.resolver(true);
  await volta;
  await assentar();
  assert.deepEqual(t.saidas, ['PUT null', 'PUT token'], 'a rodada no ar já leva o token: sem PUT dobrado');
});

test('a rodada no ar que já leu o modo velho: a configuração nova dá UMA rodada a mais, com o token', async () => {
  const put = adiado();
  let puts = 0;
  const t = montar({
    registrar: async (corpo) => {
      puts += 1;
      t.saidas.push(`PUT ${corpo.token === null ? 'null' : corpo.token === undefined ? 'sem campo' : 'token'}`);
      if (puts === 1) await put.promessa;
    },
  });
  t.servidor.push = false;
  const preparo = t.registro.preparar();
  await assentar(); // a 1ª rodada leu "desligado" e está no PUT
  t.servidor.push = true;
  t.registro.aoMudarAConfiguracao(true);
  put.resolver();
  await preparo;
  await assentar();
  assert.deepEqual(t.saidas, ['PUT null', 'PUT token']);
});

test('o toque em "Abrir o leitor" com o iPhone liberado e o registro velho: manda o token', async () => {
  const t = montar();
  t.servidor.push = false;
  await t.registro.preparar();
  // O dono religou o push; a configuração nova chegou ao cache sem passar pelo vigia: o toque
  // confere o que o aparelho pode agora.
  t.servidor.push = true;
  t.registro.conferir({ push: true, permissao: 'liberada' });
  await assentar();
  assert.deepEqual(t.saidas, ['PUT null', 'PUT token']);
  // Com o registro em dia, o toque de sempre não manda nada.
  t.registro.conferir({ push: true, permissao: 'liberada' });
  await assentar();
  assert.deepEqual(t.saidas, ['PUT null', 'PUT token']);
});

test('o registro que falhou na abertura (servidor fora) sai no toque, quando o servidor volta', async () => {
  const t = montar();
  t.servidor.push = null; // GET /configuracao sem resposta
  await t.registro.preparar();
  assert.deepEqual(t.saidas, []);
  t.servidor.push = true;
  t.registro.conferir({ push: true, permissao: 'liberada' });
  await assentar();
  assert.deepEqual(t.saidas, ['PUT token']);
});

test('Android (sem FCM): o modo do push no servidor não muda o registro, e não há PUT a mais', async () => {
  const t = montar({ plataforma: 'android' });
  t.servidor.push = false;
  await t.registro.preparar();
  t.servidor.push = true;
  t.registro.aoMudarAConfiguracao(true);
  t.registro.conferir({ push: true, permissao: null }); // o toque em "Abrir o leitor"
  await assentar();
  assert.deepEqual(t.saidas, ['PUT null']);
});

test('no export web nada é registrado nem esquecido', async () => {
  const t = montar({ plataforma: 'web' });
  await t.registro.preparar();
  t.registro.aoMudarAConfiguracao(true);
  t.registro.conferir({ push: true, permissao: 'liberada' });
  await t.registro.esquecer({ timeout: 50 });
  await assentar();
  assert.deepEqual(t.saidas, []);
});

// ------------------------------------------------------------------ a limpeza pendente

test('a limpeza de OUTRO servidor não segura o registro no servidor de agora', async () => {
  const t = montar();
  t.gravarCofre({ base: ANTIGO, instalacao: 'inst-velha', em: t.agora() - DIA_MS });
  // O servidor antigo sumiu (IP que descarta pacotes): o DELETE só acabaria no teto de 10 s.
  const someu = adiado<unknown>();
  t.deleteResponde(ANTIGO, () => someu.promessa);

  const preparo = await aTempo(t.registro.preparar());
  assert.notEqual(preparo, 'preso', 'o registro esperou o DELETE do servidor que não existe mais');
  assert.deepEqual(t.saidas, [`DELETE ${ANTIGO}`, 'PUT token']);

  // A tentativa termina depois, com resposta: a pendente sai do cofre.
  someu.rejeitar(new RespostaHttp(404));
  await assentar();
  assert.equal(t.lerCofre(), null);
});

test('a limpeza do servidor de AGORA continua indo antes do registro', async () => {
  const t = montar();
  t.gravarCofre({ base: LOJA, instalacao: 'inst-loja', em: t.agora() - DIA_MS });
  const resposta = adiado<unknown>();
  t.deleteResponde(LOJA, () => resposta.promessa);

  const preparo = t.registro.preparar();
  await assentar();
  assert.deepEqual(t.saidas, [`DELETE ${LOJA}`], 'o PUT espera: um DELETE depois dele apagaria o registro novo');
  resposta.resolver(undefined);
  await preparo;
  assert.deepEqual(t.saidas, [`DELETE ${LOJA}`, 'PUT token']);
  assert.equal(t.lerCofre(), null);
});

test('sem resposta, a limpeza de outro servidor fica para a próxima abertura — até vencer em 30 dias', async () => {
  const t = montar();
  const pendente = { base: ANTIGO, instalacao: 'inst-velha', em: t.agora() - DIA_MS };
  t.gravarCofre(pendente);
  t.deleteResponde(ANTIGO, async () => {
    throw new Error('rede'); // sem resposta
  });
  await t.registro.preparar();
  await assentar();
  assert.deepEqual(t.lerCofre(), pendente, 'sem resposta, fica');

  // 30 dias depois do `em`: a faxina do servidor já levou o aparelho — sai sem ser tentada.
  t.passar(VALIDADE_DA_LIMPEZA_MS);
  t.saidas.length = 0;
  await t.registro.preparar();
  await assentar();
  assert.deepEqual(t.saidas, ['PUT token'], 'nenhum DELETE para o servidor que sumiu');
  assert.equal(t.lerCofre(), null);
});

test('a pendente de uma versão sem data ganha a data de agora (e passa a vencer)', async () => {
  const t = montar();
  t.gravarCofre({ base: ANTIGO, instalacao: 'inst-velha' });
  t.deleteResponde(ANTIGO, async () => {
    throw new Error('rede');
  });
  await t.registro.preparar();
  await assentar();
  assert.deepEqual(t.lerCofre(), { base: ANTIGO, instalacao: 'inst-velha', em: t.agora() });
  t.passar(VALIDADE_DA_LIMPEZA_MS + 1);
  await t.registro.tentarLimpezaPendente();
  assert.equal(t.lerCofre(), null);
});

test('a saída sem rede no meio guarda a sua pendente; a tentativa antiga que termina depois não a apaga', async () => {
  const t = montar();
  t.gravarCofre({ base: ANTIGO, instalacao: 'inst-velha', em: t.agora() - DIA_MS });
  const antigo = adiado<unknown>();
  t.deleteResponde(ANTIGO, () => antigo.promessa);
  t.deleteResponde(LOJA, async () => {
    throw new Error('rede'); // a saída de agora, sem rede
  });
  assert.notEqual(await aTempo(t.registro.preparar()), 'preso', 'o registro esperou o DELETE do outro servidor');
  await t.registro.esquecer({ timeout: 50 });
  const daSaida = t.lerCofre();
  assert.equal(daSaida?.base, LOJA);

  antigo.resolver(undefined); // o servidor antigo respondeu, enfim
  await assentar();
  assert.deepEqual(t.lerCofre(), daSaida, 'a pendente da saída de agora continua lá');
});

// ------------------------------------------------------------------ o que já valia (a ordem)

test('o esquecimento vai depois do registro que já estava no ar, e o registro do login seguinte depois dele', async () => {
  const put = adiado();
  let primeiro = true;
  const t = montar({
    registrar: async (corpo) => {
      t.saidas.push(`PUT ${corpo.token === null ? 'null' : 'token'}`);
      if (primeiro) {
        primeiro = false;
        await put.promessa;
      }
    },
  });
  const preparo = t.registro.preparar();
  await assentar();
  const esquecimento = t.registro.esquecer({ timeout: 2000 });
  await assentar();
  assert.deepEqual(t.saidas, ['PUT token'], 'o DELETE espera o PUT que já tinha saído');
  put.resolver();
  await Promise.all([preparo, esquecimento]);
  await t.registro.preparar(); // o próximo login
  assert.deepEqual(t.saidas, ['PUT token', `DELETE ${LOJA}`, 'PUT token']);
});

test('sem rede na saída, fica UMA limpeza pendente, com data', async () => {
  const t = montar();
  t.deleteResponde(LOJA, async () => {
    throw new Error('rede');
  });
  await t.registro.esquecer({ timeout: 50 });
  assert.deepEqual(t.lerCofre(), { base: LOJA, instalacao: 'inst-loja', em: t.agora() });
  // Com resposta (qualquer status), nada fica.
  const u = montar();
  u.deleteResponde(LOJA, async () => {
    throw new RespostaHttp(500);
  });
  await u.registro.esquecer({ timeout: 50 });
  assert.equal(u.lerCofre(), null);
});

test('o eco do token que o próprio registro provoca não registra de novo', async () => {
  const t = montar({
    token: async () => {
      // O iOS responde a cada pedido de token com o evento de troca: chega DURANTE o registro.
      t.registro.aoTrocarOToken('token-do-aparelho');
      return TOKEN;
    },
  });
  await t.registro.preparar();
  t.registro.aoTrocarOToken('token-do-aparelho'); // o mesmo de novo: nada
  await assentar();
  assert.deepEqual(t.saidas, ['PUT token']);
  t.registro.aoTrocarOToken('outro-token'); // o sistema trocou de verdade
  await assentar();
  assert.deepEqual(t.saidas, ['PUT token', 'PUT token']);
});
