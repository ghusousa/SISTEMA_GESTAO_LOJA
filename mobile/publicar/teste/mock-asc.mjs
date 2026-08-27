/**
 * Uma App Store Connect de mentira, na memória, para testar o publicador de ponta
 * a ponta sem tocar na conta de verdade. Implementa só o que o publicar.mjs chama
 * e anota tudo o que recebeu em `estado`, que o teste lê em GET /_estado.
 */

import { createServer } from 'node:http';

export function subirMock() {
  const estado = {
    app: { primaryLocale: 'en-US' },
    infoLoc: null,
    categorias: null,
    idade: null,
    versao: null,
    versaoLoc: null,
    capturas: {}, // id -> {nome, bytesRecebidos, confirmada}
    ordem: null,
    revisao: null,
    preco: null,
    buildPreso: null,
    envio: null,
  };
  let sequencia = 0;
  const id = (prefixo) => `${prefixo}${++sequencia}`;

  const servidor = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const rota = `${req.method} ${url.pathname}`;
    const pedacos = [];
    req.on('data', (p) => pedacos.push(p));
    req.on('end', () => {
      const bruto = Buffer.concat(pedacos);
      const corpo = bruto.length && req.headers['content-type']?.includes('json')
        ? JSON.parse(bruto.toString())
        : null;
      const json = (codigo, dado) => {
        res.writeHead(codigo, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(dado));
      };

      if (rota !== 'GET /_estado' && !url.pathname.startsWith('/_upload/')) {
        if (!/^Bearer ey/.test(req.headers.authorization ?? '')) return json(401, { errors: [{ title: 'sem JWT' }] });
      }

      // --- consultas do teste ---
      if (rota === 'GET /_estado') return json(200, estado);

      // --- app ---
      if (rota === 'GET /v1/apps')
        return json(200, { data: [{ type: 'apps', id: 'APP1', attributes: { name: 'Gestão de Loja', ...estado.app } }] });
      if (rota === 'PATCH /v1/apps/APP1') {
        Object.assign(estado.app, corpo.data.attributes);
        return json(200, { data: { id: 'APP1' } });
      }

      // --- appInfo, nome/subtítulo, categoria, idade ---
      if (rota === 'GET /v1/apps/APP1/appInfos')
        return json(200, { data: [{ id: 'INFO1', attributes: { appStoreState: 'PREPARE_FOR_SUBMISSION' } }] });
      if (rota === 'GET /v1/appInfos/INFO1/appInfoLocalizations')
        return json(200, { data: estado.infoLoc ? [{ id: 'ILOC1', attributes: estado.infoLoc }] : [] });
      if (rota === 'POST /v1/appInfoLocalizations') {
        estado.infoLoc = corpo.data.attributes;
        return json(201, { data: { id: 'ILOC1', attributes: estado.infoLoc } });
      }
      if (rota === 'PATCH /v1/appInfoLocalizations/ILOC1') {
        Object.assign(estado.infoLoc, corpo.data.attributes);
        return json(200, { data: { id: 'ILOC1' } });
      }
      if (rota === 'PATCH /v1/appInfos/INFO1') {
        estado.categorias = {
          principal: corpo.data.relationships.primaryCategory.data.id,
          secundaria: corpo.data.relationships.secondaryCategory.data.id,
        };
        return json(200, { data: { id: 'INFO1' } });
      }
      if (rota === 'GET /v1/appInfos/INFO1/ageRatingDeclaration')
        return json(200, { data: { id: 'AGE1' } });
      if (rota === 'PATCH /v1/ageRatingDeclarations/AGE1') {
        estado.idade = corpo.data.attributes;
        return json(200, { data: { id: 'AGE1' } });
      }

      // --- versão e textos ---
      if (rota === 'GET /v1/apps/APP1/appStoreVersions')
        return json(200, { data: estado.versao ? [{ id: 'VER1', attributes: estado.versao }] : [] });
      if (rota === 'POST /v1/appStoreVersions') {
        estado.versao = { ...corpo.data.attributes, appStoreState: 'PREPARE_FOR_SUBMISSION' };
        return json(201, { data: { id: 'VER1', attributes: estado.versao } });
      }
      if (rota === 'PATCH /v1/appStoreVersions/VER1') {
        Object.assign(estado.versao, corpo.data.attributes);
        return json(200, { data: { id: 'VER1' } });
      }
      if (rota === 'GET /v1/appStoreVersions/VER1/appStoreVersionLocalizations')
        return json(200, { data: estado.versaoLoc ? [{ id: 'VLOC1', attributes: estado.versaoLoc }] : [] });
      if (rota === 'POST /v1/appStoreVersionLocalizations') {
        estado.versaoLoc = corpo.data.attributes;
        return json(201, { data: { id: 'VLOC1', attributes: estado.versaoLoc } });
      }
      if (rota === 'PATCH /v1/appStoreVersionLocalizations/VLOC1') {
        Object.assign(estado.versaoLoc, corpo.data.attributes);
        return json(200, { data: { id: 'VLOC1' } });
      }

      // --- capturas ---
      if (rota === 'GET /v1/appStoreVersionLocalizations/VLOC1/appScreenshotSets')
        return json(200, { data: [] });
      if (rota === 'POST /v1/appScreenshotSets') return json(201, { data: { id: 'SET1' } });
      if (rota === 'GET /v1/appScreenshotSets/SET1/appScreenshots')
        return json(200, { data: [] });
      if (rota === 'POST /v1/appScreenshots') {
        const nova = id('SHOT');
        estado.capturas[nova] = {
          nome: corpo.data.attributes.fileName,
          esperado: corpo.data.attributes.fileSize,
          bytesRecebidos: 0,
          confirmada: false,
        };
        return json(201, {
          data: {
            id: nova,
            attributes: {
              uploadOperations: [
                {
                  method: 'PUT',
                  url: `http://127.0.0.1:${servidor.address().port}/_upload/${nova}`,
                  offset: 0,
                  length: corpo.data.attributes.fileSize,
                  requestHeaders: [{ name: 'Content-Type', value: 'image/png' }],
                },
              ],
            },
          },
        });
      }
      if (req.method === 'PUT' && url.pathname.startsWith('/_upload/')) {
        estado.capturas[url.pathname.split('/').pop()].bytesRecebidos = bruto.length;
        return json(200, {});
      }
      if (req.method === 'PATCH' && /^\/v1\/appScreenshots\/SHOT/.test(url.pathname)) {
        const c = estado.capturas[url.pathname.split('/').pop()];
        c.confirmada = corpo.data.attributes.uploaded === true && !!corpo.data.attributes.sourceFileChecksum;
        return json(200, { data: {} });
      }
      if (rota === 'PATCH /v1/appScreenshotSets/SET1/relationships/appScreenshots') {
        estado.ordem = corpo.data.map((d) => d.id);
        return json(204, null);
      }

      // --- revisão, preço, build, envio ---
      if (rota === 'GET /v1/appStoreVersions/VER1/appStoreReviewDetail')
        return json(404, { errors: [{ title: 'ainda não existe' }] });
      if (rota === 'POST /v1/appStoreReviewDetails') {
        estado.revisao = corpo.data.attributes;
        return json(201, { data: { id: 'REV1' } });
      }
      if (rota === 'GET /v1/apps/APP1/appPricePoints')
        return json(200, { data: [{ id: 'PP0', attributes: { customerPrice: '0.0' } }] });
      if (rota === 'POST /v1/appPriceSchedules') {
        estado.preco = corpo.included[0].relationships.appPricePoint.data.id;
        return json(201, { data: { id: 'PS1' } });
      }
      if (rota === 'GET /v1/builds')
        return json(200, { data: [{ id: 'B1', attributes: { version: '7', processingState: 'VALID' } }] });
      if (rota === 'PATCH /v1/appStoreVersions/VER1/relationships/build') {
        estado.buildPreso = corpo.data.id;
        return json(204, null);
      }
      if (rota === 'POST /v1/reviewSubmissions') {
        estado.envio = { itens: 0, enviado: false };
        return json(201, { data: { id: 'RS1' } });
      }
      if (rota === 'POST /v1/reviewSubmissionItems') {
        estado.envio.itens += 1;
        return json(201, { data: { id: 'RSI1' } });
      }
      if (rota === 'PATCH /v1/reviewSubmissions/RS1') {
        estado.envio.enviado = corpo.data.attributes.submitted === true;
        return json(200, { data: { id: 'RS1' } });
      }

      json(500, { errors: [{ title: `rota não prevista no mock: ${rota}` }] });
    });
  });

  return new Promise((resolver) => {
    servidor.listen(0, '127.0.0.1', () => resolver({ porta: servidor.address().port, fechar: () => servidor.close() }));
  });
}
