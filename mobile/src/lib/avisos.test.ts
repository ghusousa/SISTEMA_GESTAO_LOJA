import assert from 'node:assert/strict';
import test from 'node:test';

import { QueryClient, QueryObserver, type QueryKey } from '@tanstack/react-query';

import {
  aplicarRodada,
  chavesDosAssuntos,
  criarAgrupador,
  JANELA_RAJADA,
  TETO_RAJADA,
  type Assunto,
  type Relogio,
} from './avisos';

/** Relógio de mentira: o tempo só anda quando o teste manda. */
function relogioDeTeste() {
  let agora = 0;
  let proximoId = 0;
  const pendentes = new Map<number, { quando: number; fn: () => void }>();
  const relogio: Relogio = {
    agora: () => agora,
    agendar: (fn, ms) => {
      proximoId += 1;
      pendentes.set(proximoId, { quando: agora + ms, fn });
      return proximoId;
    },
    cancelar: (id) => {
      pendentes.delete(id as number);
    },
  };
  /** Anda `ms` milissegundos, disparando na ordem os timers que vencerem no caminho. */
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

function agrupadorDeTeste(segurar?: () => boolean) {
  const { relogio, avancar } = relogioDeTeste();
  const rodadas: Assunto[][] = [];
  const rajada = criarAgrupador<Assunto>((itens) => rodadas.push([...itens].sort()), {
    relogio,
    segurar,
  });
  return { rajada, rodadas, avancar };
}

test('os assuntos de uma venda chegam juntos e viram uma rodada só', () => {
  const { rajada, rodadas, avancar } = agrupadorDeTeste();
  rajada.avisar('vendas');
  avancar(3);
  rajada.avisar('estoque');
  avancar(JANELA_RAJADA - 1);
  assert.equal(rodadas.length, 0, 'ainda dentro da janela: nada disparou');
  avancar(1);
  assert.deepEqual(rodadas, [['estoque', 'vendas']]);
});

test('vinte avisos de dez vendas em rajada: uma rodada, cada assunto uma vez', () => {
  const { rajada, rodadas, avancar } = agrupadorDeTeste();
  for (let venda = 0; venda < 10; venda += 1) {
    rajada.avisar('vendas');
    rajada.avisar('estoque');
    avancar(50);
  }
  avancar(TETO_RAJADA);
  assert.deepEqual(rodadas, [['estoque', 'vendas']]);
});

test('a janela conta do último aviso', () => {
  const { rajada, rodadas, avancar } = agrupadorDeTeste();
  rajada.avisar('vendas');
  avancar(800);
  rajada.avisar('caixa');
  avancar(JANELA_RAJADA - 1); // 1799 ms do primeiro, 999 do último
  assert.equal(rodadas.length, 0);
  avancar(1);
  assert.deepEqual(rodadas, [['caixa', 'vendas']]);
});

test('fluxo contínuo não adia a tela para sempre: o teto dispara', () => {
  const { rajada, rodadas, avancar } = agrupadorDeTeste();
  // Uma venda a cada meio segundo: sem teto, a janela nunca fecharia.
  rajada.avisar('vendas');
  for (let ms = 500; ms < TETO_RAJADA; ms += 500) {
    avancar(500);
    rajada.avisar('vendas');
  }
  avancar(TETO_RAJADA - 1500 - 1); // 1999 ms do primeiro aviso
  assert.equal(rodadas.length, 0);
  avancar(1);
  assert.equal(rodadas.length, 1, 'o teto fechou a rodada');
  // O aviso seguinte abre outra rodada, com janela própria.
  rajada.avisar('estoque');
  avancar(JANELA_RAJADA);
  assert.deepEqual(rodadas, [['vendas'], ['estoque']]);
});

test('aviso isolado espera só a janela', () => {
  const { rajada, rodadas, avancar } = agrupadorDeTeste();
  rajada.avisar('catalogo');
  avancar(JANELA_RAJADA);
  assert.deepEqual(rodadas, [['catalogo']]);
});

test('app no fundo segura a rodada até alguém acordar a tela', () => {
  let noFundo = true;
  const { rajada, rodadas, avancar } = agrupadorDeTeste(() => noFundo);
  rajada.avisar('vendas');
  avancar(TETO_RAJADA * 5);
  rajada.avisar('despesas');
  avancar(TETO_RAJADA * 5);
  assert.equal(rodadas.length, 0, 'ninguém olhando: nada recarrega');
  noFundo = false;
  rajada.descarregar();
  assert.deepEqual(rodadas, [['despesas', 'vendas']], 'na volta, uma rodada com tudo');
});

test('descartar esquece a rodada: a reconexão vai recarregar tudo de qualquer jeito', () => {
  const { rajada, rodadas, avancar } = agrupadorDeTeste();
  rajada.avisar('vendas');
  rajada.descartar();
  avancar(TETO_RAJADA * 2);
  rajada.descarregar();
  assert.equal(rodadas.length, 0);
  assert.equal(rajada.pendentes().size, 0);
});

test('catálogo e estoque juntos derrubam a lista de produtos uma vez só', () => {
  const chaves = chavesDosAssuntos(['catalogo', 'estoque', 'vendas', 'despesas']).map((c) =>
    JSON.stringify(c),
  );
  assert.equal(chaves.filter((c) => c === '["produtos"]').length, 1);
  assert.equal(chaves.filter((c) => c === '["relatorio-resumo"]').length, 1);
  assert.equal(new Set(chaves).size, chaves.length, 'nenhuma chave repetida');
});

test('clientes, que o servidor manda, derruba a lista de clientes', () => {
  assert.deepEqual(chavesDosAssuntos(['clientes']), [['clientes']]);
});

test('assunto desconhecido e sinais de vida não derrubam nada', () => {
  assert.deepEqual(chavesDosAssuntos(['ping', 'conectado', 'novidade' as Assunto]), []);
});

/** Consulta com tela montada: um observador inscrito, contando quantas vezes buscou. */
function consultaNaTela(cliente: QueryClient, queryKey: QueryKey) {
  const contagem = { buscas: 0 };
  const observador = new QueryObserver(cliente, {
    queryKey,
    queryFn: async () => {
      contagem.buscas += 1;
      return contagem.buscas;
    },
    staleTime: Infinity,
  });
  const sair = observador.subscribe(() => {});
  return { contagem, sair };
}

const respirar = () => new Promise((r) => setTimeout(r, 5));

test('a rodada refaz o que está na tela uma vez e só marca o resto como velho', async () => {
  const cliente = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  const produtos = consultaNaTela(cliente, ['produtos', { q: '' }]);
  const resumo = consultaNaTela(cliente, ['relatorio-resumo', '2026-11-01', '2026-11-30']);
  // Relatório que já foi aberto e cuja tela saiu: está no cache, sem observador.
  await cliente.prefetchQuery({
    queryKey: ['relatorio-mais-vendidos', '2026-11-01', '2026-11-30'],
    queryFn: async () => 'antes',
  });
  await respirar();
  assert.equal(produtos.contagem.buscas, 1);
  assert.equal(resumo.contagem.buscas, 1);

  // Dez vendas em rajada (vinte avisos) com o agrupador de verdade e relógio de teste.
  const { relogio, avancar } = relogioDeTeste();
  let rodadas = 0;
  const rajada = criarAgrupador<Assunto>(
    (assuntos) => {
      rodadas += 1;
      aplicarRodada(assuntos, cliente);
    },
    { relogio },
  );
  for (let venda = 0; venda < 10; venda += 1) {
    rajada.avisar('vendas');
    rajada.avisar('estoque');
    avancar(30);
  }
  avancar(TETO_RAJADA);
  await respirar();

  assert.equal(rodadas, 1);
  assert.equal(produtos.contagem.buscas, 2, 'produtos: uma busca a mais, não dez');
  assert.equal(resumo.contagem.buscas, 2, 'resumo: uma busca a mais, não dez');
  const semTela = cliente
    .getQueryCache()
    .find({ queryKey: ['relatorio-mais-vendidos', '2026-11-01', '2026-11-30'] });
  assert.equal(semTela?.state.isInvalidated, true, 'sem tela: fica velho para a próxima abertura');
  assert.equal(semTela?.state.dataUpdateCount, 1, 'sem tela: não buscou de novo');

  produtos.sair();
  resumo.sair();
  cliente.clear();
});
