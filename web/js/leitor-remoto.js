/**
 * Celular como leitor de código de barras do computador (ADR-43) — a parte sem DOM, sem
 * rede e sem tela, para dar para testar (`testes/web/leitor-remoto.test.mjs`).
 *
 * O computador mostra um QR (o "convite") e um código de 6 caracteres; o celular lê um
 * ou outro, aceita o pareamento na API e passa a mandar cada bipe da câmera, que cai no
 * campo do leitor do computador como se fosse o leitor USB.
 *
 * ESPELHO de `mobile/src/lib/leitorRemoto.ts`: as funções do convite, do código, do
 * servidor e do prazo têm de se comportar IGUAL nas duas pontas — o web monta o convite
 * que o app lê. Mudou um, mude o outro. A fila de envio do bipe (espera entre tentativas,
 * destino da falha) só existe no app; a seção do fim ("só do web") trata do lado que
 * RECEBE, que só existe no computador.
 *
 * Tudo aqui é texto e regex, de propósito: o `URL` do React Native não entende esquema
 * próprio (`gestaoloja:`), não baixa a caixa do host e não sabe IPv6. Com o mesmo código
 * rodando no Node (teste), no navegador e no Hermes, o resultado é um só.
 */

/** Sem 0, O, 1 e I: ninguém confunde ao ler da tela e digitar no celular. */
export const ALFABETO = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export const TAMANHO_DO_CODIGO = 6;

/** O mesmo conjunto do `ALFABETO`, escrito em faixas. */
const FORMATO_DO_CODIGO = /^[2-9A-HJ-NP-Z]{6}$/;

/** O esquema do app (`mobile/app.json`): é ele que faz a câmera do aparelho abrir o app. */
export const ESQUEMA_DO_CONVITE = 'gestaoloja';

/**
 * Bipe que não chegou ao servidor neste prazo não vai mais: a pessoa já seguiu adiante, e
 * uma peça bipada há dois minutos caindo no carrinho de surpresa é pior que um "não
 * enviado" na lista. O servidor aplica o mesmo prazo na entrega ao computador.
 */
export const PRAZO_DO_BIPE_MS = 120_000;

// ------------------------------------------------------------------ código e convite

/**
 * O código como o servidor espera: maiúsculas, sem espaço nem hífen. `"abc-234"`,
 * `" ABC 234 "` e `"ABC234"` dão `"ABC234"`. Fora do formato, `null`.
 * @param {string | null | undefined} texto
 * @returns {string | null}
 */
export function normalizarCodigo(texto) {
  const limpo = String(texto ?? '')
    .toUpperCase()
    .replace(/[\s-]+/g, '');
  return FORMATO_DO_CODIGO.test(limpo) ? limpo : null;
}

/** `"ABC234"` -> `"ABC 234"`, para ler em voz alta. O que não é código volta como veio. */
export function formatarCodigo(codigo) {
  const normal = normalizarCodigo(codigo);
  if (!normal) return String(codigo ?? '');
  return `${normal.slice(0, 3)} ${normal.slice(3)}`;
}

/**
 * O texto do QR: `gestaoloja://leitor?v=1&c=ABC234&api=<base da API, codificada>`.
 *
 * O `api` vai junto só para o celular poder dizer "este código é de outro servidor" — o
 * app NUNCA troca de servidor por causa de um QR: aceita sempre no servidor em que já
 * está ligado. Sem `api`, o parâmetro sai do texto.
 * @param {string} codigo
 * @param {string | null} [api]
 */
export function montarConvite(codigo, api) {
  const base = `${ESQUEMA_DO_CONVITE}://leitor?v=1&c=${codigo}`;
  return api ? `${base}&api=${encodeURIComponent(api)}` : base;
}

/** `gestaoloja://leitor?…`, `gestaoloja:///leitor?…` ou `gestaoloja://leitor/?…`. */
const FORMATO_DO_CONVITE = /^gestaoloja:(?:\/\/)?\/?leitor\/?(?:\?([^#]*))?(?:#.*)?$/i;

function decodificar(valor) {
  try {
    // `+` é espaço na query, como no URLSearchParams.
    return decodeURIComponent(valor.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

function parametros(query) {
  const mapa = new Map();
  for (const par of query.split('&')) {
    if (!par) continue;
    const igual = par.indexOf('=');
    const chave = decodificar(igual < 0 ? par : par.slice(0, igual));
    const valor = decodificar(igual < 0 ? '' : par.slice(igual + 1));
    // Chave repetida: vale a primeira, como no `URLSearchParams.get`.
    if (chave !== null && valor !== null && !mapa.has(chave)) mapa.set(chave, valor);
  }
  return mapa;
}

/**
 * Lê o que a câmera (ou a pessoa) entregou: o texto do convite OU o código solto.
 *
 * Qualquer outra coisa é `null` — inclusive a etiqueta de uma peça lida por engano e o QR
 * de outro esquema (um link de site, um Pix). Convite de versão desconhecida (`v=2`)
 * também: melhor recusar do que ler pela metade um formato que ainda não existe.
 * @returns {{ codigo: string, api: string | null } | null}
 */
export function lerConvite(texto) {
  const bruto = String(texto ?? '').trim();
  if (!bruto) return null;

  const solto = normalizarCodigo(bruto);
  if (solto) return { codigo: solto, api: null };

  const achado = FORMATO_DO_CONVITE.exec(bruto);
  if (!achado) return null;

  const params = parametros(achado[1] ?? '');
  const versao = params.get('v');
  if (versao !== undefined && versao !== '1') return null;

  const codigo = normalizarCodigo(params.get('c'));
  if (!codigo) return null;

  const api = (params.get('api') ?? '').trim();
  return { codigo, api: /^https?:\/\/\S+$/i.test(api) ? api : null };
}

// ------------------------------------------------------------------ servidor

const PORTA_PADRAO = { http: '80', https: '443', ws: '80', wss: '443' };

/** Esquema, host (IPv6 entre colchetes) e porta (a escrita, ou a padrão). Sem esquema, `null`. */
function partirEndereco(texto) {
  const achado = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)(?::(\d*))?(?:[/?#]|$)/i.exec(
    String(texto ?? '').trim(),
  );
  if (!achado || !achado[2]) return null;
  const esquema = achado[1].toLowerCase();
  const host = achado[2].toLowerCase().replace(/\.$/, '');
  const porta = achado[3] || PORTA_PADRAO[esquema] || '';
  return { esquema, host, porta };
}

function ehLoopback(host) {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    /^127(?:\.\d{1,3}){3}$/.test(host) ||
    host === '[::1]' ||
    host === '::1'
  );
}

/**
 * O convite é do mesmo servidor em que o app está ligado? Compara host e porta (porta
 * padrão do esquema preenchida; sem diferenciar maiúsculas; caminho e barra final não
 * contam). Host de loopback no convite (`localhost`, `127.x`, `::1`) dá `true`: o
 * computador que abriu a loja por `localhost` não sabe o próprio endereço na rede, e
 * quem decide é o servidor. Endereço ilegível de qualquer lado também dá `true` — sem
 * saber, não se acusa.
 */
export function mesmoServidor(apiDoConvite, apiDoApp) {
  const convite = partirEndereco(apiDoConvite);
  const app = partirEndereco(apiDoApp);
  if (!convite || !app) return true;
  if (ehLoopback(convite.host)) return true;
  return convite.host === app.host && convite.porta === app.porta;
}

/** `"https://Loja.Exemplo:8443/api/v1"` -> `"loja.exemplo:8443"`, para mostrar na dica. */
export function hostDoEndereco(texto) {
  const partes = partirEndereco(texto);
  if (!partes) return String(texto ?? '');
  const padrao = !partes.porta || partes.porta === PORTA_PADRAO[partes.esquema];
  return padrao ? partes.host : `${partes.host}:${partes.porta}`;
}

/** O bipe passou do prazo sem sair? `lidoEm` e `agora` em milissegundos. */
export function venceu(bipe, agora) {
  return agora - bipe.lidoEm > PRAZO_DO_BIPE_MS;
}

// ------------------------------------------------------------------ só do web

/** Sem canal de tempo real, o computador pergunta a cada 2 s se chegou bipe. */
export const BUSCA_SEM_CANAL_MS = 2000;
/** Com o canal de pé o aviso "leitor" chama na hora; isto é só a rede de segurança. */
export const BUSCA_COM_CANAL_MS = 10_000;

export const intervaloDaBusca = (canalConectado) =>
  canalConectado ? BUSCA_COM_CANAL_MS : BUSCA_SEM_CANAL_MS;

/** A frase que o computador mostra quando o leitor que estava ligado deixa de valer. */
export function avisoDoFimNoComputador(pareamento) {
  if (pareamento?.status === 'EXPIRADO') {
    return 'O leitor venceu (12 h). Ligue o celular de novo se precisar.';
  }
  const motivo = pareamento?.status === 'ENCERRADO' ? pareamento.motivo_encerramento : null;
  if (motivo === 'CELULAR') return 'O celular desligou o leitor.';
  if (motivo === 'TROCOU') return 'O celular passou a ser o leitor de outro computador.';
  // COMPUTADOR (outra aba deste login), SUBSTITUIDO (o teto de 10) ou sumiu: sem detalhe.
  return 'O leitor do celular foi desligado.';
}

/**
 * Uma chamada por vez, sem perder pedido: chamar enquanto uma está em curso NÃO abre
 * outra — marca uma rodada a mais, que roda quando a atual termina (quantos pedidos
 * vierem no meio, uma rodada só). Assim o aviso que chega no meio de um `retirar` não
 * se perde (o bipe dele pode ter sido gravado depois do SELECT da rodada atual) e dois
 * avisos juntos não viram dois `retirar` paralelos.
 *
 * Devolve `pedir()`, que resolve quando não houver mais rodada pendente. Erro numa
 * rodada não trava as próximas (`aoErro` decide o que fazer com ele).
 */
export function umaPorVez(rodada, { aoErro = () => {} } = {}) {
  let girando = false;
  let denovo = false;
  let promessa = Promise.resolve();

  return function pedir() {
    if (girando) {
      denovo = true;
      return promessa;
    }
    // A bandeira desce no MESMO passo em que o laço vê que não há mais pedido: um pedido
    // que chegue depois disso abre rodada nova, nunca cai num laço que já terminou.
    girando = true;
    promessa = (async () => {
      try {
        do {
          denovo = false;
          try {
            await rodada();
          } catch (erro) {
            aoErro(erro);
          }
        } while (denovo);
      } finally {
        girando = false;
      }
    })();
    return promessa;
  };
}
