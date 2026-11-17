import assert from 'node:assert/strict';
import test from 'node:test';

import { criarFila, type BipeDaFila, type Falha } from './filaDoLeitor';
import { PRAZO_DO_BIPE_MS } from './leitorRemoto';

const T0 = 1_000_000;
const REDE_CAIU: Falha = {};

type Resposta = 'ok' | Falha;

/**
 * Uma fila com tudo de mentira: relógio que só anda quando a fila dorme, envio que responde
 * pelo roteiro, e a "store" num objeto simples.
 */
function montar({
  responder = () => 'ok',
  dormir,
}: {
  responder?: (bipe: BipeDaFila, agora: number) => Resposta;
  dormir?: (ms: number, registrar: (acordar: () => void) => void) => Promise<void>;
} = {}) {
  const ctx = {
    agora: T0,
    estado: { pareamentoId: 7 as number | null, bipes: [] as BipeDaFila[] },
    envios: [] as string[],
    esperas: [] as number[],
    desligou: [] as (string | null)[],
    emVoo: 0,
    maxEmVoo: 0,
  };
  const fila = criarFila({
    estado: () => ctx.estado,
    marcar: (uuid, mudanca) => {
      ctx.estado.bipes = ctx.estado.bipes.map((b) => (b.uuid === uuid ? { ...b, ...mudanca } : b));
    },
    enviar: async (bipe, pareamentoId) => {
      ctx.emVoo += 1;
      ctx.maxEmVoo = Math.max(ctx.maxEmVoo, ctx.emVoo);
      ctx.envios.push(`${bipe.uuid}@${pareamentoId}`);
      await Promise.resolve();
      ctx.emVoo -= 1;
      const resposta = responder(bipe, ctx.agora);
      if (resposta !== 'ok') throw resposta;
    },
    lerFalha: (erro) => erro as Falha,
    aoDesligar: (status) => {
      ctx.desligou.push(status);
      ctx.estado.pareamentoId = null;
    },
    agora: () => ctx.agora,
    dormir:
      dormir ??
      (async (ms) => {
        ctx.esperas.push(ms);
        ctx.agora += ms;
      }),
  });
  function ler(uuid: string, lidoEm = ctx.agora): void {
    ctx.estado.bipes.push({ uuid, codigo: `cod-${uuid}`, lidoEm, estado: 'enviando', tentativas: 0 });
  }
  const estados = () => ctx.estado.bipes.map((b) => `${b.uuid}:${b.estado}`);
  return { ctx, fila, ler, estados };
}

test('manda um por vez, na ordem da leitura', async () => {
  const { ctx, fila, ler, estados } = montar();
  ler('a');
  ler('b');
  ler('c');
  await Promise.all([fila.esvaziar(), fila.esvaziar()]);
  assert.deepEqual(ctx.envios, ['a@7', 'b@7', 'c@7']);
  assert.equal(ctx.maxEmVoo, 1, 'nunca dois envios ao mesmo tempo');
  assert.deepEqual(estados(), ['a:enviado', 'b:enviado', 'c:enviado']);
});

test('sem pareamento, nada sai', async () => {
  const { ctx, fila, ler } = montar();
  ctx.estado.pareamentoId = null;
  ler('a');
  await fila.esvaziar();
  assert.deepEqual(ctx.envios, []);
});

test('rede caída e 5xx: reenvia o MESMO bipe, com espera crescente, e o seguinte espera', async () => {
  const roteiro: Resposta[] = [REDE_CAIU, { status: 503 }, { status: 409, codigo: 'LEITOR_FILA_CHEIA' }];
  const { ctx, fila, ler, estados } = montar({ responder: () => roteiro.shift() ?? 'ok' });
  ler('a');
  ler('b');
  await fila.esvaziar();
  assert.deepEqual(ctx.envios, ['a@7', 'a@7', 'a@7', 'a@7', 'b@7']);
  assert.deepEqual(ctx.esperas, [1000, 2000, 4000]);
  assert.deepEqual(estados(), ['a:enviado', 'b:enviado']);
  assert.equal(ctx.estado.bipes[0].tentativas, 3);
});

test('passou do prazo sem sair: "não enviado", e o próximo dentro do prazo segue', async () => {
  // A rede volta só 125 s depois da primeira leitura.
  const { ctx, fila, ler, estados } = montar({
    responder: (_bipe, agora) => (agora - T0 < 125_000 ? REDE_CAIU : 'ok'),
  });
  ler('a', T0);
  ler('b', T0 + 100_000);
  await fila.esvaziar();
  assert.deepEqual(estados(), ['a:nao-enviado', 'b:enviado']);
  assert.ok(ctx.agora - T0 > PRAZO_DO_BIPE_MS);
  assert.ok(ctx.esperas.every((ms) => ms <= 10_000), 'teto de 10 s entre tentativas');
  assert.equal(ctx.envios.at(-1), 'b@7');
});

test('bipe já vencido nem tenta sair', async () => {
  const { ctx, fila, ler, estados } = montar();
  ler('a', T0 - PRAZO_DO_BIPE_MS - 1);
  ler('b');
  await fila.esvaziar();
  assert.deepEqual(ctx.envios, ['b@7']);
  assert.deepEqual(estados(), ['a:nao-enviado', 'b:enviado']);
});

test('recusa deste bipe (422) descarta só ele', async () => {
  const roteiro: Resposta[] = [{ status: 422, codigo: 'VALIDACAO' }];
  const { ctx, fila, ler, estados } = montar({ responder: () => roteiro.shift() ?? 'ok' });
  ler('a');
  ler('b');
  await fila.esvaziar();
  assert.deepEqual(ctx.envios, ['a@7', 'b@7']);
  assert.deepEqual(estados(), ['a:nao-enviado', 'b:enviado']);
  assert.deepEqual(ctx.esperas, []);
});

test('leitor desligado do outro lado (409): para tudo e avisa com o status', async () => {
  const { ctx, fila, ler } = montar({
    responder: () => ({ status: 409, codigo: 'LEITOR_DESLIGADO', statusDoLeitor: 'EXPIRADO' }),
  });
  ler('a');
  ler('b');
  await fila.esvaziar();
  assert.deepEqual(ctx.envios, ['a@7']);
  assert.deepEqual(ctx.desligou, ['EXPIRADO']);
});

test('pareamento sumido (404) também desliga', async () => {
  const { ctx, fila, ler } = montar({ responder: () => ({ status: 404, codigo: 'NAO_ENCONTRADO' }) });
  ler('a');
  await fila.esvaziar();
  assert.deepEqual(ctx.desligou, [null]);
});

test('interromper no meio da espera: o laço sai sem mandar mais nada', async () => {
  let registrado: (() => void) | null = null;
  const { ctx, fila, ler, estados } = montar({
    responder: () => REDE_CAIU,
    dormir: (_ms, registrar) =>
      new Promise<void>((resolve) => {
        registrado = resolve;
        registrar(resolve);
      }),
  });
  ler('a');
  const laco = fila.esvaziar();
  // Deixa o primeiro envio falhar e a fila entrar na espera.
  for (let i = 0; i < 10 && !registrado; i += 1) await Promise.resolve();
  assert.ok(registrado, 'a fila está esperando');
  fila.interromper();
  await laco;
  assert.deepEqual(ctx.envios, ['a@7']);
  assert.deepEqual(estados(), ['a:enviando'], 'quem decide o fim dos pendentes é a store');
});

test('acordar encurta a espera: bipe novo tenta já', async () => {
  let falhas = 1;
  const { ctx, fila, ler, estados } = montar({
    responder: () => (falhas-- > 0 ? REDE_CAIU : 'ok'),
    // Espera que nunca acaba sozinha: só sai se alguém acordar.
    dormir: (_ms, registrar) => new Promise<void>((resolve) => registrar(resolve)),
  });
  ler('a');
  const laco = fila.esvaziar();
  for (let i = 0; i < 10 && ctx.envios.length < 1; i += 1) await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  ler('b');
  fila.acordar();
  await laco;
  assert.deepEqual(ctx.envios, ['a@7', 'a@7', 'b@7']);
  assert.deepEqual(estados(), ['a:enviado', 'b:enviado']);
});

test('depois de interromper, um laço novo começa limpo', async () => {
  const { ctx, fila, ler, estados } = montar();
  fila.interromper();
  ler('a');
  await fila.esvaziar();
  assert.deepEqual(ctx.envios, ['a@7']);
  assert.deepEqual(estados(), ['a:enviado']);
});
