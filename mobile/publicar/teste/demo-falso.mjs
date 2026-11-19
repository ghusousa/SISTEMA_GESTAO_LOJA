/**
 * Um servidor de demonstração de mentira: só as rotas da API da loja que o publicador confere
 * antes de mandar para a revisão (servidor-demo.mjs), respondendo no formato do sistema
 * ({code, message, detail}; 404 genérico do FastAPI quando a rota não existe no deploy).
 *
 * `opcoes` liga as falhas: senha errada, conta que não é de dono, código que não existe ou
 * sem estoque, deploy sem o leitor, sem a exclusão da própria conta ou sem a proteção da conta
 * demo, privacidade ou suporte fora, servidor fora. `chamadas` guarda o que chegou — o teste confere que
 * ninguém mandou a senha DA DEMO para a rota de excluir a própria conta (e que nada saiu).
 *
 * `prefixo: '/demo'` é a demonstração que sobe com a loja (ADR-46): tudo dela mora debaixo do
 * caminho, e fora dele responde a LOJA DE VERDADE (no ar, sem a conta da demo) — como no proxy
 * da instalação. Cada chamada guarda `caminho` (o de dentro do prefixo), `cheio` (o que chegou)
 * e `naLoja` (foi à loja da raiz: o publicador perdeu o caminho).
 */

import { createServer } from 'node:http';

const PADRAO = {
  email: 'revisao@teste.dev',
  senha: 'segredo-demo',
  papel: 'ADMIN',
  codigos: ['7890000000000'],
  semLeitor: false, // deploy anterior ao ADR-43
  semExclusao: false, // deploy anterior ao ADR-45: /usuarios/me cai na rota /usuarios/{id}
  protegida: true, // a conta demo não se exclui (CONTA_DE_DEMONSTRACAO antes da senha)
  saldo: 12, // peças do código demo em estoque
  privacidade: 200,
  suporte: 200, // /suporte: a página de suporte, quando a ficha usa outra que não a privacidade
  fora: false, // /health devolve 503
  prefixo: '', // '/demo': a demo mora debaixo dele, e a loja de verdade na raiz
};

export function subirDemoFalso(opcoes = {}) {
  const o = { ...PADRAO, ...opcoes };
  const chamadas = [];
  const json = (res, codigo, corpo) => {
    res.writeHead(codigo, { 'Content-Type': 'application/json' });
    res.end(corpo === undefined ? '' : JSON.stringify(corpo));
  };
  const servidor = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const pedacos = [];
    req.on('data', (p) => pedacos.push(p));
    req.on('end', () => {
      const texto = Buffer.concat(pedacos).toString();
      let corpo = null;
      try {
        corpo = texto ? JSON.parse(texto) : null;
      } catch {
        /* sem JSON */
      }
      const cheio = url.pathname;
      const dentro = !o.prefixo || cheio === o.prefixo || cheio.startsWith(`${o.prefixo}/`);
      const caminho = dentro ? cheio.slice(o.prefixo.length) || '/' : cheio;
      chamadas.push({ metodo: req.method, caminho, cheio, corpo, naLoja: !dentro });

      if (!dentro) {
        // A loja de verdade, na raiz do mesmo domínio: está no ar, mas a conta da demo não
        // existe nela — e nenhuma rota dela pode valer como a demonstração.
        if (caminho === '/health') return json(res, 200, { status: 'ok', ambiente: 'producao' });
        if (caminho === '/api/v1/auth/login') {
          return json(res, 401, { code: 'CREDENCIAIS_INVALIDAS', message: 'E-mail ou senha incorretos.', detail: {} });
        }
        return json(res, 404, { detail: 'Not Found' });
      }
      if (caminho === '/health') return o.fora ? json(res, 503, { detail: 'fora' }) : json(res, 200, { status: 'ok', ambiente: 'producao' });
      if (caminho === '/privacidade' && req.method === 'GET') {
        res.writeHead(o.privacidade, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<!doctype html><title>Política de privacidade</title>');
      }
      if (caminho === '/suporte' && req.method === 'GET') {
        res.writeHead(o.suporte, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<!doctype html><title>Suporte</title>');
      }
      if (caminho === '/api/v1/auth/login' && req.method === 'POST') {
        if (corpo?.email !== o.email || corpo?.senha !== o.senha) {
          return json(res, 401, { code: 'CREDENCIAIS_INVALIDAS', message: 'E-mail ou senha incorretos.', detail: {} });
        }
        return json(res, 200, {
          access_token: 'token-da-demo',
          refresh_token: 'refresh-da-demo',
          token_type: 'bearer',
          expires_in: 900,
          usuario: { id: 1, nome: 'Revisão Apple', email: o.email, papel: o.papel, ativo: true },
        });
      }
      if (req.headers.authorization !== 'Bearer token-da-demo') {
        return json(res, 401, { code: 'TOKEN_INVALIDO', message: 'Sessão expirada.', detail: {} });
      }
      if (caminho === '/api/v1/auth/logout' && req.method === 'POST') {
        res.writeHead(204);
        return res.end();
      }
      const codigo = /^\/api\/v1\/variantes\/codigo-barras\/([^/]+)$/.exec(caminho);
      if (codigo && req.method === 'GET') {
        const pedido = decodeURIComponent(codigo[1]);
        return o.codigos.includes(pedido)
          ? json(res, 200, { variante_id: 1, produto: 'Camiseta Básica', codigo_barras: pedido, preco_venda: '49.90', saldo: o.saldo })
          : json(res, 404, { code: 'NAO_ENCONTRADO', message: 'Código não encontrado.', detail: {} });
      }
      if (/^\/api\/v1\/leitor\/pareamentos\/\d+$/.test(caminho) && req.method === 'GET') {
        return o.semLeitor
          ? json(res, 404, { detail: 'Not Found' })
          : json(res, 404, { code: 'NAO_ENCONTRADO', message: 'Leitor não encontrado.', detail: {} });
      }
      if (caminho === '/api/v1/usuarios/me' && req.method === 'DELETE') {
        if (o.semExclusao) {
          return json(res, 422, { code: 'VALIDACAO', message: 'Dados inválidos.', detail: { campos: [{ campo: 'user_id', erro: 'Input should be a valid integer' }] } });
        }
        if (!corpo?.senha) {
          return json(res, 422, { code: 'VALIDACAO', message: 'Dados inválidos.', detail: { campos: [{ campo: 'senha', erro: 'Field required' }] } });
        }
        if (o.protegida) {
          return json(res, 409, { code: 'CONTA_DE_DEMONSTRACAO', message: 'Esta é a conta da demonstração…', detail: {} });
        }
        if (corpo.senha !== o.senha) {
          return json(res, 422, { code: 'SENHA_INCORRETA', message: 'Senha incorreta. A conta continua como estava.', detail: {} });
        }
        // Com a senha certa, a demo de verdade excluiria: o publicador NUNCA pode chegar aqui.
        chamadas.push({ metodo: 'EXCLUIU A CONTA', caminho, corpo: null });
        res.writeHead(204);
        return res.end();
      }
      return json(res, 404, { detail: 'Not Found' });
    });
  });
  return new Promise((resolver) => {
    servidor.listen(0, '127.0.0.1', () =>
      resolver({
        base: `http://127.0.0.1:${servidor.address().port}`,
        chamadas,
        fechar: () => new Promise((r) => servidor.close(r)),
      }),
    );
  });
}
