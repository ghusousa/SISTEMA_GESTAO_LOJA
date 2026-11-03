import assert from 'node:assert/strict';
import test from 'node:test';

import type { Relogio } from './avisos';
import {
  criarCanal,
  ESPERA_INICIAL,
  ESPERA_MAXIMA,
  esperaDaTentativa,
  type Ligacao,
  type Ouvidos,
} from './canal';

/** O servidor do outro lado, controlado pelo teste. */
class SocketFalso implements Ligacao {
  enviados: unknown[] = [];
  fechado = false;
  private estado: 'abrindo' | 'aberto' | 'fechado' = 'abrindo';

  constructor(private readonly ouvidos: Ouvidos) {}

  enviar(dados: string): void {
    this.enviados.push(JSON.parse(dados));
  }
  fechar(): void {
    this.fechado = true;
    this.estado = 'fechado';
  }
  aberta(): boolean {
    return this.estado === 'aberto';
  }

  abrir(): void {
    this.estado = 'aberto';
    this.ouvidos.aoAbrir();
  }
  mandar(assunto: string): void {
    this.ouvidos.aoReceber(JSON.stringify({ assunto, dados: {} }));
  }
  mandarCru(dados: unknown): void {
    this.ouvidos.aoReceber(dados);
  }
  /** O servidor fechou (o `maxDuration` da Vercel) ou a rede caiu. */
  cair(): void {
    this.estado = 'fechado';
    this.ouvidos.aoCair();
  }
}

/** Relógio de mentira: o tempo só anda quando o teste manda. */
function relogioDeTeste() {
  let agora = 0;
  let proximoId = 0;
  const pendentes = new Map<number, { quando: number; fn: () => void }>();
  const relogio: Pick<Relogio, 'agendar' | 'cancelar'> = {
    agendar: (fn, ms) => {
      proximoId += 1;
      pendentes.set(proximoId, { quando: agora + ms, fn });
      return proximoId;
    },
    cancelar: (id) => {
      pendentes.delete(id as number);
    },
  };
  function avancar(ms: number): void {
    const alvo = agora + ms;
    for (;;) {
      const vencidos = [...pendentes.entries()]
        .filter(([, t]) => t.quando <= alvo)
        .sort((a, b) => a[1].quando - b[1].quando);
      if (vencidos.length === 0) break;
      const [id, t] = vencidos[0];
      pendentes.delete(id);
      agora = t.quando;
      t.fn();
    }
    agora = alvo;
  }
  return { relogio, avancar };
}

/** O `abrir` espera o token (assíncrono, como o secure-store): deixa a promessa andar. */
const microtarefas = () => new Promise<void>((r) => setImmediate(r));

function montar(token: () => string | null = () => 'tok') {
  const { relogio, avancar } = relogioDeTeste();
  const sockets: SocketFalso[] = [];
  const avisos: string[] = [];
  let recargas = 0;
  const canal = criarCanal({
    abrirSocket(ouvidos) {
      const s = new SocketFalso(ouvidos);
      sockets.push(s);
      return s;
    },
    lerToken: async () => token(),
    relogio,
    aoConectar: () => {
      recargas += 1;
    },
    aoAvisar: (assunto) => avisos.push(assunto),
  });
  /** Anda o relógio e deixa o `abrir` assíncrono terminar. */
  async function esperar(ms: number): Promise<void> {
    avancar(ms);
    await microtarefas();
  }
  return { canal, sockets, avisos, recargas: () => recargas, esperar, ultimo: () => sockets.at(-1)! };
}

test('a espera dobra a cada falha e para em 30 s', () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6, 10].map(esperaDaTentativa),
    [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000],
  );
  assert.equal(esperaDaTentativa(0), ESPERA_INICIAL);
  assert.equal(esperaDaTentativa(99), ESPERA_MAXIMA);
});

test('liga, entrega o token no primeiro quadro e refaz a tela quando o servidor aceita', async () => {
  const t = montar();
  t.canal.ligar();
  await microtarefas();
  assert.equal(t.sockets.length, 1);

  t.ultimo().abrir();
  assert.deepEqual(t.ultimo().enviados, [{ tipo: 'entrar', token: 'tok' }]);
  assert.equal(t.recargas(), 0, 'socket aberto ainda não é aceito');

  t.ultimo().mandar('conectado');
  assert.equal(t.recargas(), 1);
  assert.ok(t.canal.aberto());
});

test('a Vercel fecha o socket no maxDuration: religa em 1 s e refaz as consultas de novo', async () => {
  const t = montar();
  t.canal.ligar();
  await microtarefas();
  t.ultimo().abrir();
  t.ultimo().mandar('conectado');

  // Várias vezes seguidas, como numa tarde de loja aberta: a espera não cresce, porque
  // cada religação foi aceita.
  for (let volta = 1; volta <= 3; volta += 1) {
    t.ultimo().cair();
    assert.equal(t.canal.aberto(), false);
    await t.esperar(ESPERA_INICIAL - 1);
    assert.equal(t.sockets.length, volta, 'ainda esperando');
    await t.esperar(1);
    assert.equal(t.sockets.length, volta + 1, 'religou em 1 s');

    t.ultimo().abrir();
    t.ultimo().mandar('conectado');
    // O que mudou no buraco não chegou por aviso: o "conectado" manda refazer a tela.
    assert.equal(t.recargas(), volta + 1);
  }
});

test('servidor fora do ar: a espera cresce até o teto e só zera quando ele aceita', async () => {
  const t = montar();
  t.canal.ligar();
  await microtarefas();

  const esperas = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
  for (const espera of esperas) {
    const antes = t.sockets.length;
    t.ultimo().cair(); // nem chega a abrir
    await t.esperar(espera - 1);
    assert.equal(t.sockets.length, antes, `não religa antes de ${espera} ms`);
    await t.esperar(1);
    assert.equal(t.sockets.length, antes + 1, `religa em ${espera} ms`);
  }

  // Socket que abre e é recusado (sem "conectado") não zera a espera…
  t.ultimo().abrir();
  t.ultimo().cair();
  await t.esperar(ESPERA_INICIAL);
  assert.equal(t.sockets.length, esperas.length + 1, 'continua no teto');
  await t.esperar(ESPERA_MAXIMA - ESPERA_INICIAL);
  // …o "conectado" zera.
  t.ultimo().abrir();
  t.ultimo().mandar('conectado');
  t.ultimo().cair();
  const antes = t.sockets.length;
  await t.esperar(ESPERA_INICIAL);
  assert.equal(t.sockets.length, antes + 1);
});

test('close e error juntos religam uma vez só', async () => {
  const t = montar();
  t.canal.ligar();
  await microtarefas();
  t.ultimo().cair();
  t.ultimo().cair();
  await t.esperar(ESPERA_MAXIMA);
  assert.equal(t.sockets.length, 2);
});

test('ping é só sinal de vida; assunto vira aviso; lixo não derruba o canal', async () => {
  const t = montar();
  t.canal.ligar();
  await microtarefas();
  t.ultimo().abrir();
  t.ultimo().mandar('conectado');

  t.ultimo().mandar('ping');
  t.ultimo().mandarCru('isto não é json');
  t.ultimo().mandarCru(JSON.stringify({ sem: 'assunto' }));
  t.ultimo().mandar('estoque');
  t.ultimo().mandar('vendas');

  assert.deepEqual(t.avisos, ['estoque', 'vendas']);
  assert.ok(t.canal.aberto());
  assert.equal(t.sockets.length, 1);
});

test('logout fecha e não religa mais', async () => {
  const t = montar();
  t.canal.ligar();
  await microtarefas();
  t.ultimo().abrir();
  t.canal.desligar();
  assert.ok(t.ultimo().fechado);

  t.ultimo().cair(); // o close chega depois do logout
  t.ultimo().mandar('estoque'); // e uma mensagem atrasada também
  await t.esperar(ESPERA_MAXIMA * 2);
  assert.equal(t.sockets.length, 1);
  assert.deepEqual(t.avisos, []);
});

test('sem token ainda (entre o F5 e a renovação): tenta de novo depois, sem abrir socket', async () => {
  let token: string | null = null;
  const t = montar(() => token);
  t.canal.ligar();
  await microtarefas();
  assert.equal(t.sockets.length, 0);

  token = 'chegou';
  await t.esperar(ESPERA_INICIAL);
  assert.equal(t.sockets.length, 1);
  t.ultimo().abrir();
  assert.deepEqual(t.ultimo().enviados, [{ tipo: 'entrar', token: 'chegou' }]);
});

test('o app voltou do fundo: reabre já, sem esperar a espera crescente', async () => {
  const t = montar();
  t.canal.ligar();
  await microtarefas();
  for (let i = 0; i < 5; i += 1) {
    t.ultimo().cair();
    await t.esperar(esperaDaTentativa(i));
  }
  t.ultimo().cair(); // agora a próxima tentativa seria só daqui a 30 s
  const antes = t.sockets.length;
  t.canal.reabrirJa();
  await microtarefas();
  assert.equal(t.sockets.length, antes + 1);
  // E o religar que estava agendado não abre um segundo socket por cima.
  await t.esperar(ESPERA_MAXIMA);
  assert.equal(t.sockets.length, antes + 1);
});

test('ligar duas vezes, ou reabrir enquanto o token chega, não abre dois sockets', async () => {
  const t = montar();
  t.canal.ligar();
  t.canal.ligar();
  t.canal.reabrirJa();
  await microtarefas();
  assert.equal(t.sockets.length, 1);
});
