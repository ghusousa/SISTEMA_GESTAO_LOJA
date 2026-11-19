/**
 * O endereço do servidor da loja, como o aparelho guarda e como cada pedaço do app o usa.
 *
 * A base é `esquema://host[:porta][/caminho]`. O caminho existe desde a ADR-46: a loja
 * responde em `https://loja.x.com.br` e a demonstração, no MESMO domínio, em
 * `https://loja.x.com.br/demo`. Tudo o que o app pede sai daqui — a API, a renovação da
 * sessão, o canal de tempo real, a foto, o teste de saúde e a política de privacidade —,
 * sempre juntando TEXTO à base. Nunca `new URL('/api/v1', base)`: a barra do começo apaga o
 * caminho, e o celular ligado na demonstração passaria a falar com a loja de verdade.
 *
 * Tudo aqui é texto e regex, de propósito, como em `lib/leitorRemoto.ts`: o `URL` do React
 * Native não baixa a caixa do host, não sabe IPv6 e não recusa nada. O teste roda no Node,
 * que tem o `URL` completo — com o mesmo código no Node e no Hermes, o resultado é um só.
 */

/**
 * O que vem depois disto é rota do sistema, nunca parte do endereço: `/app` é a tela do
 * navegador (`/app/#/pdv`) e `/api`, a API. A partir do primeiro segmento assim, sai tudo.
 */
const ROTA_DO_SISTEMA = /\/(?:app|api)(?:\/.*)?$/i;

const PORTA_PADRAO = { http: '80', https: '443' } as const;

type Esquema = keyof typeof PORTA_PADRAO;

/** `192.168.0.10`, com cada número até 255 (os zeros da frente não contam). */
function lerIpv4(host: string): string | null {
  const numeros = host.split('.');
  if (numeros.length !== 4 || !numeros.every((n) => /^\d{1,3}$/.test(n) && Number(n) <= 255)) {
    return null;
  }
  return numeros.map(Number).join('.');
}

/**
 * Host em minúsculas e sem o ponto final; `null` se não serve. Um host que termina em
 * número só vale como IPv4 inteiro: `192.168.0.300` e `192.168.0` são dígito errado, e a
 * tela diz "confira os números" em vez de testar um endereço que não existe.
 */
function lerHost(texto: string): string | null {
  const host = texto.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[')) return /^\[[0-9a-f:.]*:[0-9a-f:.]*\]$/.test(host) ? host : null;
  if (!/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/.test(host)) return null;
  const ultimo = host.slice(host.lastIndexOf('.') + 1);
  return /^\d+$/.test(ultimo) ? lerIpv4(host) : host;
}

/**
 * Endereço de rede local: IP, nome sem ponto (`localhost`, `servidor`) ou `*.local`. É o que
 * o ATS do iOS deixa falar por `http://` (`NSAllowsLocalNetworking`, no `app.json`); domínio
 * da internet, o iPhone só abre por `https://`.
 */
export function ehRedeLocal(host: string): boolean {
  const nome = host.toLowerCase().replace(/\.$/, '');
  return (
    nome.startsWith('[') ||
    lerIpv4(nome) !== null ||
    !nome.includes('.') ||
    nome.endsWith('.local')
  );
}

/**
 * Arruma o que a pessoa digitou (ou colou) na tela "Conectar à loja".
 *
 * O caso mais comum não é digitar o endereço "certo": é repetir o que está na barra do
 * navegador do computador do balcão — algo como `http://192.168.0.10/app/#/pdv`, ou
 * `https://loja.x.com.br/demo/app/#/pdv` na demonstração. Fica a BASE: esquema, host em
 * minúsculas, a porta que não for a padrão e o caminho até a tela do navegador ou a API,
 * sem barra no fim, sem `?` e sem `#`. Usuário e senha de dentro do endereço caem fora.
 *
 * Sem esquema: `http://` para a rede local (IP, nome sem ponto, `*.local`), que é a loja
 * típica rodando sem certificado; `https://` para domínio, que é o único que o iPhone abre
 * na internet. Esquema digitado é respeitado.
 *
 * Devolve `null` quando não dá para aproveitar nada.
 */
export function normalizarEndereco(bruto: string | null | undefined): string | null {
  const texto = String(bruto ?? '').trim();
  if (!texto || /\s/.test(texto)) return null;

  let esquema: Esquema | null = null;
  let resto = texto;
  const comEsquema = /^([a-z][a-z0-9+.-]*):\/\//i.exec(texto);
  if (comEsquema) {
    const nome = comEsquema[1].toLowerCase();
    if (nome !== 'http' && nome !== 'https') return null;
    esquema = nome;
    resto = texto.slice(comEsquema[0].length);
  }

  // Autoridade (`usuario@host:porta`) vai até a primeira barra, `?` ou `#`.
  const corte = resto.search(/[/?#]/);
  const autoridade = (corte < 0 ? resto : resto.slice(0, corte)).replace(/^.*@/, '');
  const caminho = corte < 0 ? '' : resto.slice(corte).split(/[?#]/, 1)[0];

  const partes = /^(\[[^\]]*\]|[^:]*)(?::(\d*))?$/.exec(autoridade);
  if (!partes) return null;
  const host = lerHost(partes[1]);
  if (!host) return null;

  const esquemaFinal: Esquema = esquema ?? (ehRedeLocal(host) ? 'http' : 'https');

  let porta = '';
  if (partes[2]) {
    const numero = Number(partes[2]);
    if (!Number.isInteger(numero) || numero < 1 || numero > 65535) return null;
    porta = String(numero) === PORTA_PADRAO[esquemaFinal] ? '' : `:${numero}`;
  }

  const raiz = caminho.replace(/\/{2,}/g, '/').replace(ROTA_DO_SISTEMA, '').replace(/\/+$/, '');
  return `${esquemaFinal}://${host}${porta}${raiz}`;
}

// ------------------------------------------------------------------ junções com a base

/** A API: `https://loja.x.com.br/demo` -> `https://loja.x.com.br/demo/api/v1`. */
export function urlDaApi(base: string): string {
  return `${base}/api/v1`;
}

/**
 * O canal de tempo real: `ws://` para `http://`, `wss://` para `https://`, com a porta e o
 * caminho da base. O token vai no primeiro quadro, nunca na URL.
 */
export function urlDoTempoReal(base: string): string {
  return `${urlDaApi(base.replace(/^http/i, 'ws'))}/tempo-real`;
}

/** O teste de "há mesmo um sistema da loja aqui?", antes de guardar o endereço. */
export function urlDeSaude(base: string): string {
  return `${base}/health`;
}

/**
 * A frase do teste de endereço quando o servidor respondeu, mas com erro.
 *
 * 502, 503 e 504 são o proxy dizendo que o sistema atrás dele está desligado ou começando —
 * a demonstração depois da renovação da madrugada, a loja no meio de uma atualização —, e
 * não endereço errado: "erro 503" faria a pessoa redigitar um endereço que está certo. Se o
 * servidor explicou (`message` no JSON, como o `DEMONSTRACAO_FORA_DO_AR` do proxy), vale a
 * explicação dele.
 */
export function mensagemDoTesteRecusado(status: number, corpo?: unknown): string {
  const explicacao =
    corpo && typeof corpo === 'object' ? (corpo as { message?: unknown }).message : undefined;
  if (typeof explicacao === 'string' && explicacao.trim()) return explicacao.trim();
  if (status === 502 || status === 503 || status === 504) {
    return 'O servidor está desligado ou começando. Tente de novo em um minuto.';
  }
  return `O servidor respondeu com erro ${status}.`;
}

/** A política de privacidade, servida pelo próprio servidor da loja (ou da demonstração). */
export function urlDaPrivacidade(base: string): string {
  return `${base}/privacidade`;
}
