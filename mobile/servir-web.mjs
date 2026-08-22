/**
 * Servidor estático do export web, com fallback para index.html.
 *
 * O expo-router faz o roteamento no cliente: sem o fallback, abrir /produtos direto
 * devolveria 404. Serve para conferir o app no navegador (`npm run web:build` antes).
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const RAIZ = process.argv[2] || 'dist-web';
const PORTA = Number(process.argv[3] || 8090);

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
};

createServer((req, res) => {
  const caminho = decodeURIComponent(new URL(req.url, 'http://local').pathname);
  // normalize + replace evita subir de diretório com "..".
  let arquivo = join(RAIZ, normalize(caminho).replace(/^(\.\.[/\\])+/, ''));

  if (!existsSync(arquivo) || statSync(arquivo).isDirectory()) {
    const indice = join(arquivo, 'index.html');
    arquivo = existsSync(indice) ? indice : join(RAIZ, 'index.html');
  }

  res.writeHead(200, {
    'Content-Type': TIPOS[extname(arquivo)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  createReadStream(arquivo).pipe(res);
}).listen(PORTA, () => console.log(`export web em http://127.0.0.1:${PORTA}`));
