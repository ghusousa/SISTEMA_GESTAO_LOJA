/**
 * Celular como leitor de código de barras do computador (ADR-43) — a parte sem câmera,
 * sem rede e sem tela, para dar para testar.
 *
 * O computador mostra um QR (o "convite") e um código de 6 caracteres; o celular lê um
 * ou outro, aceita o pareamento na API e passa a mandar cada bipe da câmera, que cai no
 * campo do leitor do computador como se fosse o leitor USB.
 *
 * ESPELHO de `web/js/leitor-remoto.js` (teste em `testes/web/leitor-remoto.test.mjs`):
 * as funções do convite, do código e do prazo têm de se comportar IGUAL nas duas pontas —
 * o web monta o convite que o app lê. Mudou um, mude o outro. A seção do fim ("só do
 * app": espera entre tentativas, destino da falha, frase do fim) trata do lado que ENVIA
 * bipe, que só existe no celular; o web tem a sua ("só do web") para o lado que RECEBE.
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

/** O esquema do app (`app.json`): é ele que faz a câmera do aparelho abrir o app. */
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
 */
export function normalizarCodigo(texto: string | null | undefined): string | null {
  const limpo = String(texto ?? '')
    .toUpperCase()
    .replace(/[\s-]+/g, '');
  return FORMATO_DO_CODIGO.test(limpo) ? limpo : null;
}

/** `"ABC234"` -> `"ABC 234"`, para ler em voz alta. O que não é código volta como veio. */
export function formatarCodigo(codigo: string | null | undefined): string {
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
 */
export function montarConvite(codigo: string, api?: string | null): string {
  const base = `${ESQUEMA_DO_CONVITE}://leitor?v=1&c=${codigo}`;
  return api ? `${base}&api=${encodeURIComponent(api)}` : base;
}

export interface Convite {
  codigo: string;
  /** Base da API de quem gerou o convite; `null` quando foi digitado ou veio sem. */
  api: string | null;
}

/** `gestaoloja://leitor?…`, `gestaoloja:///leitor?…` ou `gestaoloja://leitor/?…`. */
const FORMATO_DO_CONVITE = /^gestaoloja:(?:\/\/)?\/?leitor\/?(?:\?([^#]*))?(?:#.*)?$/i;

function decodificar(valor: string): string | null {
  try {
    // `+` é espaço na query, como no URLSearchParams.
    return decodeURIComponent(valor.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

function parametros(query: string): Map<string, string> {
  const mapa = new Map<string, string>();
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
 */
export function lerConvite(texto: string | null | undefined): Convite | null {
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

interface Endereco {
  esquema: string;
  host: string;
  /** A porta que vale: a escrita, ou a padrão do esquema. */
  porta: string;
}

const PORTA_PADRAO: Record<string, string> = { http: '80', https: '443', ws: '80', wss: '443' };

/** Esquema, host (IPv6 entre colchetes) e porta. Sem esquema conhecido, `null`. */
function partirEndereco(texto: string | null | undefined): Endereco | null {
  const achado = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)(?::(\d*))?(?:[/?#]|$)/i.exec(
    String(texto ?? '').trim(),
  );
  if (!achado || !achado[2]) return null;
  const esquema = achado[1].toLowerCase();
  const host = achado[2].toLowerCase().replace(/\.$/, '');
  const porta = achado[3] || PORTA_PADRAO[esquema] || '';
  return { esquema, host, porta };
}

function ehLoopback(host: string): boolean {
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
export function mesmoServidor(
  apiDoConvite: string | null | undefined,
  apiDoApp: string | null | undefined,
): boolean {
  const convite = partirEndereco(apiDoConvite);
  const app = partirEndereco(apiDoApp);
  if (!convite || !app) return true;
  if (ehLoopback(convite.host)) return true;
  return convite.host === app.host && convite.porta === app.porta;
}

/** `"https://Loja.Exemplo:8443/api/v1"` -> `"loja.exemplo:8443"`, para mostrar na dica. */
export function hostDoEndereco(texto: string | null | undefined): string {
  const partes = partirEndereco(texto);
  if (!partes) return String(texto ?? '');
  const padrao = !partes.porta || partes.porta === PORTA_PADRAO[partes.esquema];
  return padrao ? partes.host : `${partes.host}:${partes.porta}`;
}

/** O bipe passou do prazo sem sair? `lidoEm` e `agora` em milissegundos. */
export function venceu(bipe: { lidoEm: number }, agora: number): boolean {
  return agora - bipe.lidoEm > PRAZO_DO_BIPE_MS;
}

// ------------------------------------------------------------------ só do app

/**
 * O link do convite (`gestaoloja://leitor?v=…&c=…&api=…`, aberto pela câmera do aparelho)
 * remontado como texto a partir dos parâmetros da rota, para passar pela MESMA `lerConvite`
 * da câmera do app: versão desconhecida, código torto e `api` que não é http(s) são tratados
 * igual nos dois caminhos.
 */
export function conviteDoLink(params: { v?: string; c?: string; api?: string }): string {
  const partes = (['v', 'c', 'api'] as const)
    .filter((k) => typeof params[k] === 'string')
    .map((k) => `${k}=${encodeURIComponent(params[k] as string)}`);
  return `${ESQUEMA_DO_CONVITE}://leitor?${partes.join('&')}`;
}

/** Primeira espera entre tentativas de envio; dobra a cada falha. */
export const ESPERA_INICIAL_MS = 1000;

/** Teto da espera: com a rede de volta, o bipe sai em no máximo 10 s. */
export const ESPERA_MAXIMA_MS = 10_000;

/** Espera antes da tentativa `n` (1, 2, 3…): 1 s, 2 s, 4 s, 8 s, e daí 10 s. */
export function esperaDaTentativa(n: number): number {
  // NaN conta como a primeira; o expoente para em 30 só para a conta não virar Infinity.
  const tentativa = Number.isNaN(n) ? 1 : Math.min(n, 31);
  const expoente = Math.max(0, Math.floor(tentativa) - 1);
  return Math.min(ESPERA_MAXIMA_MS, ESPERA_INICIAL_MS * 2 ** expoente);
}

/**
 * O que fazer com um bipe cujo envio falhou.
 *
 * - `tentar-de-novo`: sem resposta (rede caída, timeout), 5xx, 408, 429 e fila cheia — o
 *   computador vai esvaziar a fila; o prazo do bipe decide quando desistir.
 * - `leitor-desligado`: o pareamento acabou (409 `LEITOR_DESLIGADO`) ou não é mais deste
 *   celular (404). Nada da fila sai mais.
 * - `descartar`: o servidor recusou ESTE bipe (422, 409 `DUPLICADO`, sessão perdida).
 *   Reenviar daria a mesma recusa; o próximo da fila segue.
 */
export type DestinoDaFalha = 'tentar-de-novo' | 'leitor-desligado' | 'descartar';

export function destinoDaFalha(
  status: number | null | undefined,
  codigo: string | null | undefined,
): DestinoDaFalha {
  if (!status) return 'tentar-de-novo';
  if (status >= 500 || status === 408 || status === 429) return 'tentar-de-novo';
  if (status === 409 && codigo === 'LEITOR_FILA_CHEIA') return 'tentar-de-novo';
  if (status === 409 && codigo === 'LEITOR_DESLIGADO') return 'leitor-desligado';
  if (status === 404) return 'leitor-desligado';
  return 'descartar';
}

type StatusDoLeitor = 'AGUARDANDO' | 'ATIVO' | 'EXPIRADO' | 'ENCERRADO';
type MotivoDoFim = 'COMPUTADOR' | 'CELULAR' | 'TROCOU' | 'SUBSTITUIDO';

/** A frase que o celular mostra quando o leitor deixa de valer. */
export function avisoDoFim(pareamento: {
  status: StatusDoLeitor;
  motivo_encerramento?: MotivoDoFim | null;
} | null): string {
  if (pareamento?.status === 'EXPIRADO') {
    return 'O leitor desligou sozinho: passaram as 12 horas. Ligue de novo pelo computador.';
  }
  if (pareamento?.status === 'ENCERRADO') {
    if (pareamento.motivo_encerramento === 'CELULAR') return 'O leitor foi desligado neste celular.';
    if (pareamento.motivo_encerramento === 'TROCOU') {
      // "Um celular, um computador" vale por LOGIN: com a mesma conta em dois aparelhos, o
      // outro computador pode ter sido ligado no outro aparelho — a frase não afirma qual.
      return 'O seu login ligou o leitor de outro computador (neste ou em outro aparelho).';
    }
  }
  return 'O computador desligou o leitor.';
}
