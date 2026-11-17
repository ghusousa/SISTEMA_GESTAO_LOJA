/**
 * Cliente da API do App Store Connect.
 *
 * A autenticação é a chave de API (.p8) que o dono gera UMA vez em
 * Users and Access > Integrations > App Store Connect API. Com ela não existe senha
 * nem código de duas etapas no meio: o script assina um JWT ES256 e pronto.
 *
 * `ASC_BASE` existe para o teste apontar o cliente para um servidor falso, e
 * `ASC_REPETIR_MS` (padrão 2000) é a espera antes de repetir uma LEITURA que a Apple
 * devolveu com 429/5xx ou que caiu na rede — o teste encurta para não esperar à toa.
 * Escrita (POST/PATCH/DELETE) nunca é repetida aqui: repetir um POST pode criar duas vezes.
 */

import { sign } from 'node:crypto';

const b64url = (dado) => Buffer.from(dado).toString('base64url');
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const TENTATIVAS_DE_LEITURA = 3;

/**
 * Cada erro da Apple numa linha legível: código, título, detalhe, o campo apontado e os
 * erros associados (`meta.associatedErrors`, onde a Apple põe o motivo de verdade quando
 * recusa um envio para revisão — "falta X na versão Y").
 */
export function mensagensDaApple(json) {
  const linhas = [];
  const descrever = (e, prefixo = '') => {
    const onde = e?.source?.pointer ?? e?.source?.parameter;
    const partes = [e?.code, e?.title, e?.detail].filter(Boolean);
    // Título e detalhe às vezes repetem a mesma frase.
    const unicas = partes.filter((p, i) => partes.indexOf(p) === i);
    linhas.push(`${prefixo}${unicas.join(' — ')}${onde ? ` [${onde}]` : ''}`);
    const associados = e?.meta?.associatedErrors;
    if (associados && typeof associados === 'object') {
      for (const [recurso, lista] of Object.entries(associados)) {
        for (const a of Array.isArray(lista) ? lista : []) descrever(a, `${prefixo}  ↳ ${recurso}: `);
      }
    }
  };
  for (const e of json?.errors ?? []) descrever(e);
  return linhas;
}

export function criarCliente({ keyId, issuerId, p8 }) {
  const base = process.env.ASC_BASE || 'https://api.appstoreconnect.apple.com';
  const esperaBase = Number(process.env.ASC_REPETIR_MS ?? 2000);
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

  async function umaVez(metodo, caminho, corpo) {
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
      const mensagens = mensagensDaApple(json);
      if (!mensagens.length) mensagens.push(texto.slice(0, 300) || String(r.status));
      const erro = new Error(`${metodo} ${caminho} -> ${r.status} (${mensagens.join(' | ')})`);
      erro.status = r.status;
      erro.corpo = json;
      erro.mensagens = mensagens;
      erro.esperar = Number(r.headers.get('retry-after')) || 0;
      throw erro;
    }
    return json;
  }

  async function chamar(metodo, caminho, corpo) {
    for (let tentativa = 1; ; tentativa++) {
      try {
        return await umaVez(metodo, caminho, corpo);
      } catch (erro) {
        // Só leitura repete, e só o que é passageiro: 429, 5xx ou a rede (sem status).
        const passageiro = erro.status === undefined || erro.status === 429 || erro.status >= 500;
        if (metodo !== 'GET' || !passageiro || tentativa >= TENTATIVAS_DE_LEITURA) throw erro;
        const espera = Math.min(erro.esperar ? erro.esperar * 1000 : esperaBase * 2 ** (tentativa - 1), 60_000);
        await dormir(espera);
      }
    }
  }

  return {
    get: (caminho) => chamar('GET', caminho),
    post: (caminho, corpo) => chamar('POST', caminho, corpo),
    patch: (caminho, corpo) => chamar('PATCH', caminho, corpo),
    del: (caminho) => chamar('DELETE', caminho),

    /**
     * Sobe um arquivo pelas uploadOperations que a própria Apple devolve. Cada parte é um
     * PUT para um endereço reservado: repetir a MESMA parte é seguro, então uma queda
     * passageira tem mais uma chance antes de virar erro.
     */
    async subirArquivo(operacoes, buffer) {
      for (const op of operacoes) {
        const cabecalhos = {};
        for (const h of op.requestHeaders ?? []) cabecalhos[h.name] = h.value;
        const parte = buffer.subarray(op.offset, op.offset + op.length);
        for (let tentativa = 1; ; tentativa++) {
          let status = 0;
          try {
            const r = await fetch(op.url, { method: op.method, headers: cabecalhos, body: parte });
            if (r.ok) break;
            status = r.status;
          } catch {
            /* rede: status 0 */
          }
          const passageiro = status === 0 || status === 429 || status >= 500;
          if (!passageiro || tentativa >= 2) throw new Error(`upload de arquivo falhou: HTTP ${status || 'sem resposta'}`);
          await dormir(esperaBase);
        }
      }
    },
  };
}
