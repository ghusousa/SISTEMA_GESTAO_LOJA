/**
 * Antes de mandar para a revisão, o publicador confere o servidor de demonstração do jeito que
 * o revisor vai usá-lo — só pela API pública do sistema, a mesma que o app chama:
 *
 *   - está no ar (GET /health);
 *   - a conta demo entra (POST /api/v1/auth/login) e é de DONO (o revisor precisa ver tudo,
 *     inclusive "Usuários", onde cria a conta de funcionário que vai excluir);
 *   - o código de barras das notas existe (o mesmo lookup do "Digitar código" do PDV);
 *   - a política de privacidade abre (a URL da ficha);
 *   - as duas coisas que as notas mandam testar têm rota lá: o leitor pelo celular (ADR-43) e
 *     a exclusão da própria conta (ADR-45). Servidor com deploy velho = revisor sem a tela.
 *
 * Antes, nada disso era conferido: senha trocada, código digitado errado ou banco recarregado
 * só apareciam dias depois, numa recusa por 2.1. Agora cada falha vira pendência e o envio não
 * sai. Nenhuma mensagem leva a senha.
 */

const ESPERA_MS = 20_000; // a Vercel acorda a função fria em alguns segundos

/** Junta a base (sem barra no fim) com o caminho. */
const em = (base, caminho) => `${base.replace(/\/+$/, '')}${caminho}`;

async function chamar(url, { metodo = 'GET', token, corpo, tempoMs = ESPERA_MS } = {}) {
  const cabecalhos = { Accept: 'application/json' };
  if (token) cabecalhos.Authorization = `Bearer ${token}`;
  if (corpo !== undefined) cabecalhos['Content-Type'] = 'application/json';
  let r;
  try {
    r = await fetch(url, {
      method: metodo,
      headers: cabecalhos,
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
      redirect: 'follow',
      signal: AbortSignal.timeout(tempoMs),
    });
  } catch (erro) {
    return { status: 0, json: null, tipo: '', erro: erro.cause?.code ?? erro.name ?? erro.message };
  }
  const texto = await r.text();
  let json = null;
  try {
    json = texto ? JSON.parse(texto) : null;
  } catch {
    /* página HTML */
  }
  return { status: r.status, json, tipo: r.headers.get('content-type') ?? '', erro: null };
}

const comoFalhou = (r) => (r.status ? `HTTP ${r.status}${r.json?.code ? ` ${r.json.code}` : ''}` : `sem resposta: ${r.erro}`);

/**
 * Confere tudo e devolve { problemas: [frases], conferidos: [frases] }. `base` é para onde as
 * chamadas vão (o próprio servidor da demo; o teste aponta para um servidor de mentira) e
 * `servidor`, o endereço que aparece nas frases.
 */
export async function conferirServidorDemo({ base, servidor = base, email, senha, codigo, urlPrivacidade, tempoMs = ESPERA_MS }) {
  const problemas = [];
  const conferidos = [];
  const opcoes = { tempoMs };

  const saude = await chamar(em(base, '/health'), opcoes);
  if (saude.status !== 200 || saude.json?.status !== 'ok') {
    problemas.push(
      `O servidor de demonstração (${servidor}) não respondeu ao /health (${comoFalhou(saude)}). ` +
        'O revisor não conseguiria nem conectar: confira o deploy e rode de novo.',
    );
    return { problemas, conferidos };
  }
  conferidos.push(`${servidor}/health no ar`);

  const login = await chamar(em(base, '/api/v1/auth/login'), { ...opcoes, metodo: 'POST', corpo: { email, senha } });
  if (login.status !== 200 || !login.json?.access_token) {
    const motivo =
      login.status === 401
        ? 'e-mail ou senha não conferem — veja a variável APPLE_EMAIL_DEMO e o segredo APPLE_DEMO_PASSWORD'
        : login.status === 429
          ? 'o login da conta está travado por tentativas erradas; espere 15 min'
          : comoFalhou(login);
    problemas.push(`A conta demo (${email}) não entra no servidor de demonstração: ${motivo}.`);
    return { problemas, conferidos };
  }
  const token = login.json.access_token;
  const papel = login.json.usuario?.papel;
  if (papel !== 'ADMIN') {
    problemas.push(
      `A conta demo (${email}) é de ${papel ?? 'papel desconhecido'}, não de dono: o revisor não veria o dinheiro ` +
        'nem "Usuários" (onde cria a conta de funcionário que exclui). Use uma conta de perfil dono.',
    );
  } else {
    conferidos.push(`conta demo ${email} entra e é de dono`);
  }

  try {
    const peca = await chamar(em(base, `/api/v1/variantes/codigo-barras/${encodeURIComponent(codigo)}`), { ...opcoes, token });
    if (peca.status === 200 && peca.json?.codigo_barras === codigo) {
      conferidos.push(`código de barras ${codigo} existe (${peca.json.produto ?? 'peça'})`);
    } else if (peca.status === 404) {
      problemas.push(
        `O código de barras demo ${codigo} não existe no servidor de demonstração — é o que as notas mandam digitar. ` +
          'Corrija APPLE_CODIGO_DEMO (Variables) com um código que exista lá.',
      );
    } else {
      problemas.push(`Não deu para conferir o código de barras demo ${codigo} (${comoFalhou(peca)}).`);
    }

    // Leitor pelo celular (ADR-43): um pareamento que não existe responde 404 COM o código do
    // sistema; sem o módulo no deploy, o 404 é o genérico do servidor, sem código.
    const leitor = await chamar(em(base, '/api/v1/leitor/pareamentos/0'), { ...opcoes, token });
    if (leitor.status === 404 && leitor.json?.code === 'NAO_ENCONTRADO') {
      conferidos.push('o leitor pelo celular tem rota no servidor');
    } else {
      problemas.push(
        `O servidor de demonstração não tem o leitor pelo celular (${comoFalhou(leitor)}), que as notas mandam testar: ` +
          'atualize o deploy da demo com o código deste commit.',
      );
    }

    // Exclusão da própria conta (ADR-45): corpo {} — sem senha a validação recusa ANTES de a
    // rota rodar, então isto nunca exclui nada; só diz se a rota existe. Sem ela no deploy,
    // "/usuarios/me" cai na rota do dono, /usuarios/{id}, e o erro é no id, não na senha.
    const exclusao = await chamar(em(base, '/api/v1/usuarios/me'), { ...opcoes, metodo: 'DELETE', token, corpo: {} });
    const campos = (exclusao.json?.detail?.campos ?? []).map((c) => c.campo);
    if (exclusao.status === 422 && exclusao.json?.code === 'VALIDACAO' && campos.includes('senha')) {
      conferidos.push('a exclusão da própria conta tem rota no servidor');
    } else {
      problemas.push(
        `O servidor de demonstração não tem a exclusão da própria conta (${comoFalhou(exclusao)}${
          campos.length ? `, campos: ${campos.join(', ')}` : ''
        }), que as notas mandam testar (5.1.1(v)): atualize o deploy da demo com o código deste commit.`,
      );
    }
  } finally {
    // A sessão aberta só para conferir não fica pendurada no servidor.
    if (login.json?.refresh_token) {
      await chamar(em(base, '/api/v1/auth/logout'), { ...opcoes, metodo: 'POST', token, corpo: { refresh_token: login.json.refresh_token } });
    }
  }

  if (urlPrivacidade) {
    const pagina = await chamar(urlPrivacidade, opcoes);
    if (pagina.status === 200 && /text\/html/i.test(pagina.tipo)) {
      conferidos.push('a política de privacidade abre');
    } else {
      problemas.push(
        `A política de privacidade da ficha não abre (${comoFalhou(pagina)}). A Apple exige a URL no ar (5.1.1(i)): ` +
          'confira APPLE_URL_PRIVACIDADE ou o servidor de demonstração, que a serve em /privacidade.',
      );
    }
  }
  return { problemas, conferidos };
}
