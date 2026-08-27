/**
 * Cliente da API do App Store Connect.
 *
 * A autenticação é a chave de API (.p8) que o dono gera UMA vez em
 * Users and Access > Integrations > App Store Connect API. Com ela não existe senha
 * nem código de duas etapas no meio: o script assina um JWT ES256 e pronto.
 *
 * `ASC_BASE` existe para o teste apontar o cliente para um servidor falso.
 */

import { sign } from 'node:crypto';

const b64url = (dado) => Buffer.from(dado).toString('base64url');

export function criarCliente({ keyId, issuerId, p8 }) {
  const base = process.env.ASC_BASE || 'https://api.appstoreconnect.apple.com';
  let token = null;
  let validoAte = 0;

  // A Apple aceita JWT de até 20 min; renovamos com folga de 1 min.
  function jwt() {
    const agora = Math.floor(Date.now() / 1000);
    if (token && agora < validoAte - 60) return token;
    const cabecalho = b64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
    const corpo = b64url(
      JSON.stringify({ iss: issuerId, iat: agora, exp: agora + 1200, aud: 'appstoreconnect-v1' }),
    );
    const assinatura = sign('sha256', Buffer.from(`${cabecalho}.${corpo}`), {
      key: p8,
      dsaEncoding: 'ieee-p1363',
    });
    token = `${cabecalho}.${corpo}.${b64url(assinatura)}`;
    validoAte = agora + 1200;
    return token;
  }

  async function chamar(metodo, caminho, corpo) {
    const r = await fetch(`${base}${caminho}`, {
      method: metodo,
      headers: { Authorization: `Bearer ${jwt()}`, 'Content-Type': 'application/json' },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    if (r.status === 204) return null;
    const texto = await r.text();
    let json = null;
    try {
      json = texto ? JSON.parse(texto) : null;
    } catch {
      /* resposta sem JSON */
    }
    if (!r.ok) {
      const detalhe =
        json?.errors?.map((e) => `${e.title}${e.detail ? `: ${e.detail}` : ''}`).join(' | ') ||
        texto.slice(0, 300) ||
        String(r.status);
      const erro = new Error(`${metodo} ${caminho} -> ${r.status} (${detalhe})`);
      erro.status = r.status;
      erro.corpo = json;
      throw erro;
    }
    return json;
  }

  return {
    get: (caminho) => chamar('GET', caminho),
    post: (caminho, corpo) => chamar('POST', caminho, corpo),
    patch: (caminho, corpo) => chamar('PATCH', caminho, corpo),
    del: (caminho) => chamar('DELETE', caminho),

    /** Sobe um arquivo pelas uploadOperations que a própria Apple devolve. */
    async subirArquivo(operacoes, buffer) {
      for (const op of operacoes) {
        const cabecalhos = {};
        for (const h of op.requestHeaders ?? []) cabecalhos[h.name] = h.value;
        const parte = buffer.subarray(op.offset, op.offset + op.length);
        const r = await fetch(op.url, { method: op.method, headers: cabecalhos, body: parte });
        if (!r.ok) throw new Error(`upload de arquivo falhou: HTTP ${r.status}`);
      }
    },
  };
}
