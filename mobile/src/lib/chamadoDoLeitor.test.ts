/**
 * A faixa do chamado do computador (ADR-47), a parte sem tela: o que ela mostra em cada caso,
 * e a cor dela, que fica debaixo da barra de status clara OU escura.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  chamadosVivos,
  chamadoVivo,
  CONFERENCIA_DOS_CHAMADOS_MS,
  fimDoChamado,
  haQuantoTempo,
  instrucaoDoLeitor,
  intervaloDaConferencia,
  naTelaDoLeitor,
  oQueAFaixaMostra,
  proximoFim,
  razaoDeContraste,
  ROTA_DO_LEITOR,
  servidorGanhouOChamado,
  VIDA_DO_CHAMADO_MS,
} from './chamadoDoLeitor';
import { cores } from './tema';

const UM = { id: 41, sinal: '7K3' };
const OUTRO = { id: 42, sinal: '2B9' };
const LIVRE = { dispensados: [], leitorLigado: false, naTelaDoLeitor: false };

test('um chamado: "O computador está chamando", com o sinal e o atender', () => {
  assert.deepEqual(oQueAFaixaMostra({ ...LIVRE, chamados: [UM] }), { tipo: 'um', chamado: UM, ids: [41] });
});

test('nenhum chamado: sem faixa', () => {
  assert.equal(oQueAFaixaMostra({ ...LIVRE, chamados: [] }), null);
});

test('na tela do leitor, quem mostra é ela: sem faixa', () => {
  assert.equal(oQueAFaixaMostra({ ...LIVRE, chamados: [UM], naTelaDoLeitor: true }), null);
  assert.equal(naTelaDoLeitor(ROTA_DO_LEITOR), true);
  assert.equal(naTelaDoLeitor('/mais/leitor'), true);
  assert.equal(naTelaDoLeitor('/'), false);
  assert.equal(naTelaDoLeitor('/mais/conta'), false);
  assert.equal(naTelaDoLeitor(null), false);
});

test('✕ dispensa os que estavam na faixa; um chamado novo aparece de novo', () => {
  assert.equal(oQueAFaixaMostra({ ...LIVRE, chamados: [UM], dispensados: [41] }), null);
  assert.deepEqual(oQueAFaixaMostra({ ...LIVRE, chamados: [UM, OUTRO], dispensados: [41] }), {
    tipo: 'um',
    chamado: OUTRO,
    ids: [42],
  });
});

test('com o leitor ligado neste celular, a faixa só avisa e leva à tela do leitor', () => {
  assert.deepEqual(oQueAFaixaMostra({ ...LIVRE, chamados: [UM], leitorLigado: true }), {
    tipo: 'leitor-ligado',
    ids: [41],
  });
  assert.deepEqual(oQueAFaixaMostra({ ...LIVRE, chamados: [UM, OUTRO], leitorLigado: true }), {
    tipo: 'leitor-ligado',
    ids: [41, 42],
  });
});

test('mais de um computador chamando (o mesmo login em dois caixas): "N computadores", e a tela escolhe', () => {
  assert.deepEqual(oQueAFaixaMostra({ ...LIVRE, chamados: [UM, OUTRO] }), {
    tipo: 'varios',
    quantidade: 2,
    ids: [41, 42],
  });
});

test('chamado com sinal fora do formato não aparece (não há como conferir com o computador)', () => {
  assert.equal(oQueAFaixaMostra({ ...LIVRE, chamados: [{ id: 9, sinal: '' }] }), null);
  assert.deepEqual(oQueAFaixaMostra({ ...LIVRE, chamados: [{ id: 9, sinal: 'ABC' }, UM] }), {
    tipo: 'um',
    chamado: UM,
    ids: [41],
  });
});

test('há quanto tempo o computador chamou', () => {
  const criado = '2026-11-19T18:00:00.000Z';
  const t0 = Date.parse(criado);
  assert.equal(haQuantoTempo(criado, t0 + 2_000), 'agora mesmo');
  assert.equal(haQuantoTempo(criado, t0 + 20_000), 'há 20 s');
  assert.equal(haQuantoTempo(criado, t0 + 59_999), 'há 59 s');
  assert.equal(haQuantoTempo(criado, t0 + 60_000), 'há 1 min');
  assert.equal(haQuantoTempo(criado, t0 + 4 * 60_000 + 30_000), 'há 4 min');
  assert.equal(haQuantoTempo(criado, t0 - 3_000), 'agora mesmo', 'relógio do celular atrás do servidor');
  assert.equal(haQuantoTempo('ontem', t0), '');
  assert.equal(haQuantoTempo(null, t0), '');
});

test('a cor da faixa lê com a hora PRETA e com a BRANCA da barra de status (≥ 4:1)', () => {
  // A faixa, quando é a primeira, fica debaixo da barra de status; a tela de baixo pede a barra
  // clara (cabeçalho azul) ou a escura (Vender, entrada): as duas têm de ler.
  assert.ok(razaoDeContraste(cores.chamadoDoLeitor, '#000000') >= 4, 'hora preta');
  assert.ok(razaoDeContraste(cores.chamadoDoLeitor, '#FFFFFF') >= 4, 'hora branca');
  // E o texto da própria faixa, branco, no mínimo do texto comum (AA).
  assert.ok(razaoDeContraste(cores.chamadoDoLeitor, cores.aoFundoEscuro) >= 4.5, 'texto da faixa');
});

test('a medida de contraste confere com os casos conhecidos', () => {
  assert.equal(razaoDeContraste('#000000', '#FFFFFF'), 21);
  assert.equal(razaoDeContraste('#FFFFFF', '#000000'), 21, 'a ordem não importa');
  assert.equal(razaoDeContraste('#777777', '#777777'), 1);
  // A da demonstração, cujos números estão escritos em tema.ts.
  assert.equal(razaoDeContraste(cores.demonstracao, '#FFFFFF').toFixed(1), '5.0');
  assert.equal(razaoDeContraste(cores.demonstracao, '#000000').toFixed(1), '4.2');
  assert.throws(() => razaoDeContraste('azul', '#FFFFFF'));
});

// ------------------------------------------------------------------ o chamado que vence

/** Um chamado de verdade: o servidor dá 5 min (`vence_em`), e vencer não avisa ninguém. */
const CRIADO = Date.parse('2026-11-19T12:00:00.000Z');
const VENCE = CRIADO + VIDA_DO_CHAMADO_MS;
const DE_VERDADE = {
  id: 41,
  sinal: '7K3',
  criado_em: new Date(CRIADO).toISOString(),
  vence_em: new Date(VENCE).toISOString(),
};

test('o chamado que venceu sai da faixa, sem esperar aviso do servidor (vencer não muda linha)', () => {
  const buscadoEm = CRIADO + 2_000; // a lista chegou 2 s depois do chamado
  assert.deepEqual(oQueAFaixaMostra({ ...LIVRE, chamados: [DE_VERDADE], agora: VENCE - 1, buscadoEm }), {
    tipo: 'um',
    chamado: UM,
    ids: [41],
  });
  assert.equal(oQueAFaixaMostra({ ...LIVRE, chamados: [DE_VERDADE], agora: VENCE, buscadoEm }), null, 'no instante do vencimento');
  assert.equal(oQueAFaixaMostra({ ...LIVRE, chamados: [DE_VERDADE], agora: VENCE + 10_000, buscadoEm }), null);
  // Sem `buscadoEm`, o relógio daqui é tido por certo.
  assert.equal(oQueAFaixaMostra({ ...LIVRE, chamados: [DE_VERDADE], agora: VENCE + 1 }), null);
});

test('com um chamado vencido e outro valendo, a faixa mostra só o que vale (e o ✕ dispensa só ele)', () => {
  const novo = {
    id: 42,
    sinal: '2B9',
    criado_em: new Date(CRIADO + 4 * 60_000).toISOString(),
    vence_em: new Date(VENCE + 4 * 60_000).toISOString(),
  };
  assert.deepEqual(
    oQueAFaixaMostra({ ...LIVRE, chamados: [DE_VERDADE, novo], agora: VENCE + 1_000, buscadoEm: CRIADO + 4 * 60_000 + 500 }),
    { tipo: 'um', chamado: OUTRO, ids: [42] },
  );
  // Com o leitor ligado, o "Outro computador está chamando" também não conta o vencido.
  assert.equal(
    oQueAFaixaMostra({ ...LIVRE, chamados: [DE_VERDADE], leitorLigado: true, agora: VENCE + 1_000, buscadoEm: CRIADO }),
    null,
  );
});

test('relógio do celular adiantado: o `vence_em` não serve, e vale a vida do chamado desde a busca', () => {
  // O servidor listou o chamado, mas o relógio daqui já o dava por vencido na hora da busca:
  // está adiantado. Esconder pelo `vence_em` sumiria com um chamado que ainda vale.
  const buscadoEm = VENCE + 10 * 60_000; // relógio 10 min adiantado
  assert.equal(chamadoVivo(DE_VERDADE, { agora: buscadoEm + 1_000, buscadoEm }), true);
  assert.equal(fimDoChamado(DE_VERDADE, buscadoEm), buscadoEm + VIDA_DO_CHAMADO_MS);
  // Passada a vida inteira desde a busca, venceu de certeza — com qualquer relógio.
  assert.equal(chamadoVivo(DE_VERDADE, { agora: buscadoEm + VIDA_DO_CHAMADO_MS, buscadoEm }), false);
});

test('chamado sem prazo legível fica: quem decide é a próxima conferência do servidor', () => {
  assert.equal(chamadoVivo({ vence_em: 'amanhã' }, { agora: VENCE * 2 }), true);
  assert.equal(chamadoVivo({}, { agora: VENCE * 2 }), true);
  assert.equal(fimDoChamado({ vence_em: null }), null);
  // Sem `criado_em`, a vida é a do servidor (5 min).
  assert.equal(fimDoChamado({ vence_em: DE_VERDADE.vence_em }, VENCE + 1), VENCE + 1 + VIDA_DO_CHAMADO_MS);
});

test('os cartões e a linha do leitor ligado usam só os que valem', () => {
  const vivo = { ...DE_VERDADE, id: 50, vence_em: new Date(VENCE + 60_000).toISOString() };
  assert.deepEqual(
    chamadosVivos([DE_VERDADE, vivo], { agora: VENCE + 1, buscadoEm: CRIADO }).map((c) => c.id),
    [50],
  );
});

test('o relógio da tela anda no vencimento do próximo que vale (um timer só, sem tique por segundo)', () => {
  const depois = { ...DE_VERDADE, id: 51, vence_em: new Date(VENCE + 90_000).toISOString() };
  assert.equal(proximoFim([depois, DE_VERDADE], { agora: CRIADO + 1_000, buscadoEm: CRIADO }), VENCE);
  assert.equal(proximoFim([depois, DE_VERDADE], { agora: VENCE, buscadoEm: CRIADO }), VENCE + 90_000, 'o que já venceu não conta');
  assert.equal(proximoFim([DE_VERDADE], { agora: VENCE + 1, buscadoEm: CRIADO }), null);
  assert.equal(proximoFim([], { agora: CRIADO }), null);
});

test('com chamado na lista, o servidor reconfirma de 30 em 30 s; sem chamado, só os avisos', () => {
  assert.equal(CONFERENCIA_DOS_CHAMADOS_MS, 30_000);
  assert.equal(intervaloDaConferencia([DE_VERDADE]), 30_000);
  assert.equal(intervaloDaConferencia([]), false);
  assert.equal(intervaloDaConferencia(undefined), false);
  assert.equal(intervaloDaConferencia(null), false);
});

test('a lista dos chamados liga a reconferência e devolve o relógio (a faixa decide com ele)', () => {
  // A regra acima só vale se o hook a usar: sem o refetchInterval, o chamado vencido volta a
  // ficar na faixa até o próximo aviso — e o resto da suíte e o tsc seguem verdes.
  const gancho = readFileSync(join(__dirname, '..', 'hooks', 'useChamadosDoLeitor.ts'), 'utf8');
  assert.match(gancho, /refetchInterval:\s*\(\s*(\w+)\s*\)\s*=>\s*intervaloDaConferencia\(\s*\1\.state\.data\s*\)/);
  const faixa = readFileSync(join(__dirname, '..', 'components', 'FaixaDoChamado.tsx'), 'utf8');
  const chamada = /oQueAFaixaMostra\(\{([\s\S]*?)\}\)/.exec(faixa);
  assert.ok(chamada, 'a faixa não chama mais oQueAFaixaMostra: a guarda não provaria nada');
  assert.match(chamada[1], /\bagora\b/, 'a faixa decide sem o relógio: o vencido fica nela');
  assert.match(chamada[1], /\bbuscadoEm\b/);
});

// ------------------------------------------------------------------ servidor antigo

test('servidor antigo (sem a rota dos chamados): a tela do leitor ensina o QR, não o botão que lá não existe', () => {
  const antigo = instrucaoDoLeitor({ servidorComChamado: false });
  assert.match(antigo, /QR/);
  assert.match(antigo, /código de 6 letras e números/);
  assert.doesNotMatch(antigo, /Abrir no app o leitor de código|chamado|sinal/i);
  const novo = instrucaoDoLeitor({ servidorComChamado: true });
  assert.match(novo, /“Abrir no app o leitor de código”/);
  assert.match(novo, /mesmo sinal/);
  assert.match(novo, /QR/, 'o celular de outra pessoa continua pelo QR');
});

test('a tela do leitor escolhe o texto pelo servidor e esconde a linha das notificações no antigo', () => {
  const tela = readFileSync(join(__dirname, '..', 'app', '(app)', 'mais', 'leitor.tsx'), 'utf8');
  assert.match(tela, /instrucaoDoLeitor\(\{\s*servidorComChamado:\s*!servidorSemChamados\s*\}\)/);
  assert.match(tela, /\{!servidorSemChamados && linhaDasNotificacoes && \(/);
  assert.match(tela, /const servidorSemChamados = useLeitorStore\(\(e\) => e\.servidorSemChamados\)/);
});

// ------------------------------------------------------------------ o leitor ligado no iPhone SE

/** O JSX que `LeitorPareado` devolve: do `return (` da função até o fim dela. */
function retornoDoLeitorPareado(fonte: string): string {
  const inicio = fonte.indexOf('export function LeitorPareado(');
  assert.ok(inicio >= 0, 'LeitorPareado sumiu: a guarda não provaria nada');
  const corpo = fonte.slice(inicio);
  const ret = corpo.indexOf('return (');
  return corpo.slice(ret, corpo.indexOf('\n}\n', ret));
}

test('leitor ligado: entre o cabeçalho e a câmera não entra nada que cresça; os outros chamados ficam na rolagem', () => {
  // No SE (375 × 667), com 3 chamados abertos do mesmo login, as linhas acima da câmera de 42%
  // espremiam a lista e mandavam o "Desligar" para fora da tela. Na rolagem, quantos forem, ele
  // continua ao alcance — e a câmera não pula a cada chamado novo.
  const jsx = retornoDoLeitorPareado(
    readFileSync(join(__dirname, '..', 'components', 'LeitorPareado.tsx'), 'utf8'),
  );
  const fimDoCabecalho = jsx.indexOf('{!!ate &&');
  const camera = jsx.indexOf('style={s.cameraArea}');
  const rolagem = jsx.indexOf('<ScrollView');
  assert.ok(fimDoCabecalho > 0 && camera > fimDoCabecalho && rolagem > camera, 'a ordem cabeçalho → câmera → rolagem mudou');
  const entre = jsx.slice(jsx.indexOf('</View>', fimDoCabecalho) + '</View>'.length, jsx.lastIndexOf('<View', camera));
  assert.doesNotMatch(entre, /<[A-Z]/, `há um componente entre o cabeçalho e a câmera:\n${entre}`);
  const dentro = jsx.slice(rolagem, jsx.indexOf('</ScrollView>'));
  assert.match(dentro, /<OutrosChamando\b/, 'os outros chamados não estão na rolagem');
  assert.match(dentro, /titulo="Desligar"/, 'o "Desligar" saiu da rolagem');
});

test('servidor atualizado com o app aberto: a configuração com notificacoes_push apaga a marca de servidor antigo', () => {
  // A loja atualizou o servidor (ADR-47) com o app aberto: a configuração relida traz o campo.
  assert.equal(servidorGanhouOChamado(true, { notificacoes_push: false }), true);
  assert.equal(servidorGanhouOChamado(true, { notificacoes_push: true }), true);
  // Ainda o servidor antigo (sem o campo), ou configuração que não chegou: a marca fica.
  assert.equal(servidorGanhouOChamado(true, {}), false);
  assert.equal(servidorGanhouOChamado(true, null), false);
  assert.equal(servidorGanhouOChamado(true, undefined), false);
  // Sem marca, nada a apagar.
  assert.equal(servidorGanhouOChamado(false, { notificacoes_push: false }), false);
});

test('a marca de servidor antigo tem quem a apague com o app aberto (não só a saída da conta)', () => {
  // O vigia mora na raiz do app, em toda plataforma (não só onde há expo-notifications).
  const raiz = readFileSync(join(__dirname, '..', 'app', '_layout.tsx'), 'utf8');
  assert.match(raiz, /vigiarServidorNovo\(\)/, 'a raiz do app não liga o vigia do servidor novo');
  const hook = readFileSync(join(__dirname, '..', 'hooks', 'useChamadosDoLeitor.ts'), 'utf8');
  assert.match(hook, /servidorGanhouOChamado\(/);
  assert.match(hook, /desmarcarServidorSemChamados\(\)/);
  assert.match(hook, /invalidateQueries\(\{ queryKey: chaves\.chamadosDoLeitor \}\)/);
});
