import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decidirLeitura,
  ESPERA_MESMO_CODIGO,
  ESPERA_QUALQUER,
  type EstadoLeitura,
} from './leitura';

const LIVRE: EstadoLeitura = {
  ultimoCodigo: null,
  instanteUltimoCodigo: 0,
  instanteQualquer: 0,
  pausado: false,
  ocupado: false,
};

/** Estado logo depois de aceitar `codigo` no instante `quando`. */
function apos(codigo: string, quando: number): EstadoLeitura {
  return { ...LIVRE, ultimoCodigo: codigo, instanteUltimoCodigo: quando, instanteQualquer: quando };
}

test('primeira leitura passa', () => {
  assert.equal(decidirLeitura(LIVRE, '7890000000000', 10_000), 'ler');
});

test('quadros seguidos da mesma etiqueta viram uma leitura só', () => {
  const estado = apos('7890000000000', 10_000);
  for (let ms = 1; ms < ESPERA_MESMO_CODIGO; ms += 33) {
    assert.equal(decidirLeitura(estado, '7890000000000', 10_000 + ms), 'ignorar');
  }
});

test('a mesma etiqueta volta a valer depois da espera', () => {
  const estado = apos('7890000000000', 10_000);
  assert.equal(decidirLeitura(estado, '7890000000000', 10_000 + ESPERA_MESMO_CODIGO), 'ler');
});

test('outra peça precisa esperar só o intervalo curto', () => {
  const estado = apos('7890000000000', 10_000);
  assert.equal(decidirLeitura(estado, '7890001000009', 10_000 + ESPERA_QUALQUER - 1), 'ignorar');
  assert.equal(decidirLeitura(estado, '7890001000009', 10_000 + ESPERA_QUALQUER), 'ler');
});

test('pausado não lê nada, nem depois da espera', () => {
  // É o caso do diálogo "Peça não cadastrada": a câmera continua enxergando a etiqueta
  // por trás dele. Sem esta trava, o alerta se empilhava a cada 1,5 s.
  const estado = { ...apos('7890000000000', 10_000), pausado: true };
  assert.equal(decidirLeitura(estado, '7890000000000', 10_000 + ESPERA_MESMO_CODIGO * 10), 'ignorar');
  assert.equal(decidirLeitura(estado, '7890001000009', 10_000 + ESPERA_MESMO_CODIGO * 10), 'ignorar');
});

test('retomar com as travas reiniciadas segura a etiqueta que ainda está na frente', () => {
  // `retomar()` marca os dois instantes com o horário do fechamento do diálogo. Isso dá
  // ao operador os 1,5 s para afastar o celular sem o aviso voltar na cara dele.
  const fechou = 12_000;
  const estado = apos('7890000000000', fechou);
  assert.equal(decidirLeitura(estado, '7890000000000', fechou + 100), 'ignorar');
  assert.equal(decidirLeitura(estado, '7890000000000', fechou + ESPERA_MESMO_CODIGO - 1), 'ignorar');
});

test('ocupado avisa uma vez por intervalo, não a cada quadro', () => {
  const estado: EstadoLeitura = { ...apos('7890000000000', 10_000), ocupado: true };
  assert.equal(decidirLeitura(estado, '7890001000009', 10_000 + 33), 'ignorar');
  assert.equal(decidirLeitura(estado, '7890001000009', 10_000 + 66), 'ignorar');
  assert.equal(decidirLeitura(estado, '7890001000009', 10_000 + ESPERA_QUALQUER), 'avisar-ocupado');
});

test('pausado tem prioridade sobre ocupado', () => {
  const estado: EstadoLeitura = { ...LIVRE, pausado: true, ocupado: true };
  assert.equal(decidirLeitura(estado, '7890000000000', 99_000), 'ignorar');
});
