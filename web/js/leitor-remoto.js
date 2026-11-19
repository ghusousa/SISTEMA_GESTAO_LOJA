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
 * RECEBE, que só existe no computador — e, por último, do botão que chama o celular do
 * mesmo login sem QR (ADR-47): o estado e as frases da área acima do campo de leitura.
 *
 * Tudo aqui é texto e regex, de propósito: o `URL` do React Native não entende esquema
 * próprio (`gestaoloja:`), não baixa a caixa do host e não sabe IPv6. Com o mesmo código
 * rodando no Node (teste), no navegador e no Hermes, o resultado é um só.
 */

// Só o `plural` das frases do chamado (seção "só do web"): `ui.js` não importa nada e não toca
// o DOM ao carregar, então este arquivo continua rodando no node do teste.
import { plural } from './ui.js';

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

/** Do `/api` (ou da tela, `/app`) em diante é rota do sistema, não onde ele mora. */
const ROTA_DO_SISTEMA = /\/(?:app|api)(?:\/.*)?$/i;

/**
 * Esquema, host (IPv6 entre colchetes), porta (a escrita, ou a padrão) e raiz — o caminho
 * onde o sistema mora, sem a API e sem barra no fim: `""` na loja, `"/demo"` na
 * demonstração (ADR-46), que responde no MESMO host. Sem esquema, `null`.
 */
function partirEndereco(texto) {
  const achado =
    /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)(?::(\d*))?(\/[^?#]*)?(?:[?#]|$)/i.exec(
      String(texto ?? '').trim(),
    );
  if (!achado || !achado[2]) return null;
  const esquema = achado[1].toLowerCase();
  const host = achado[2].toLowerCase().replace(/\.$/, '');
  const porta = achado[3] || PORTA_PADRAO[esquema] || '';
  const raiz = (achado[4] ?? '')
    .replace(/\/{2,}/g, '/')
    .replace(ROTA_DO_SISTEMA, '')
    .replace(/\/+$/, '');
  return { esquema, host, porta, raiz };
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
 * O convite é do mesmo servidor em que o app está ligado? Compara a BASE inteira: host,
 * porta (a padrão do esquema preenchida) e a raiz — a demonstração mora em `/demo` no mesmo
 * host da loja (ADR-46), e um código da loja lido pelo celular da demonstração é de OUTRO
 * sistema. Sem diferenciar maiúsculas no host; o `/api/...` do fim e a barra final não
 * contam, então a base da API (`…/demo/api/v1`) e a do servidor (`…/demo`) se comparam.
 * Host de loopback no convite (`localhost`, `127.x`, `::1`) não acusa pelo host: o
 * computador que abriu a loja por `localhost` não sabe o próprio endereço na rede — mas a
 * raiz ele sabe, e ela ainda conta. Endereço ilegível de qualquer lado dá `true` — sem
 * saber, não se acusa.
 */
export function mesmoServidor(apiDoConvite, apiDoApp) {
  const convite = partirEndereco(apiDoConvite);
  const app = partirEndereco(apiDoApp);
  if (!convite || !app) return true;
  if (convite.raiz !== app.raiz) return false;
  if (ehLoopback(convite.host)) return true;
  return convite.host === app.host && convite.porta === app.porta;
}

/**
 * `"https://Loja.Exemplo:8443/demo/api/v1"` -> `"loja.exemplo:8443/demo"`, para mostrar na
 * dica: o que identifica o servidor, raiz incluída (loja e demonstração dividem o host).
 */
export function hostDoEndereco(texto) {
  const partes = partirEndereco(texto);
  if (!partes) return String(texto ?? '');
  const padrao = !partes.porta || partes.porta === PORTA_PADRAO[partes.esquema];
  return `${padrao ? partes.host : `${partes.host}:${partes.porta}`}${partes.raiz}`;
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

/**
 * Quanto um código já retirado espera a tela que pediu tempo (`'tela-ocupada'`: gravando, ou
 * alguém digitando na lista). Passou disso, não entra: avisa para bipar de novo — entrar
 * minutos depois numa lista que já foi gravada seria a surpresa que o prazo do servidor evita.
 */
export const ESPERA_DA_TELA_MS = 60_000;
/**
 * Quanto um código espera aparecer uma tela que lê código (`'sem-leitor'`): no F5 o leitor é
 * retomado antes de a tela terminar de carregar, e numa troca de tela há um instante sem
 * nenhuma. Passou disso, a tela aberta não lê código mesmo: avisa qual abrir.
 */
export const ESPERA_DO_LEITOR_MS = 3000;
/** De quanto em quanto a entrega tenta de novo enquanto um código espera. */
export const REENTREGA_MS = 250;

/** O aviso de um código que não entrou na tela, ou `null` se entrou. */
export function avisoDaEntrega(resultado, codigo) {
  if (resultado === 'janela-aberta') {
    return `Código ${codigo} recebido, mas há uma janela aberta — feche-a e bipe de novo.`;
  }
  if (resultado === 'sem-leitor') {
    return `Código ${codigo} recebido — abra o PDV, a Devolução, a Entrada, o Inventário ou a Condicional para usar o celular.`;
  }
  if (resultado === 'tela-ocupada') {
    return `Código ${codigo} do celular não entrou: a tela ficou ocupada por muito tempo. Bipe de novo.`;
  }
  return null;
}

/**
 * O aviso dos bipes que o servidor consumiu sem entregar (`descartados` do `retirar`), ou
 * `null`. O celular mostrou "enviado" para eles: sem o aviso, ninguém fica sabendo que não
 * entraram (o computador dormiu, a aba ficou fechada, o leitor foi desligado no meio).
 */
export function avisoDosDescartados(quantos, status) {
  if (!(quantos > 0)) return null;
  const um = quantos === 1;
  const leituras = um ? '1 leitura do celular' : `${quantos} leituras do celular`;
  if (status !== 'ATIVO') {
    return `${leituras} não ${um ? 'entrou' : 'entraram'}: o leitor foi desligado antes de chegar${um ? '' : 'em'} aqui.`;
  }
  return `${leituras} ${um ? 'chegou' : 'chegaram'} depois de 2 min e ${um ? 'foi descartada' : 'foram descartadas'} — bipe de novo.`;
}

/**
 * A fila do computador entre o `retirar` e a tela: o que o servidor já entregou (e não
 * entrega de novo) espera aqui a vez de cair no leitor da tela, em ordem.
 *
 * - `'entregue'`: segue para o próximo;
 * - `'tela-ocupada'`: o código ESPERA (até `ESPERA_DA_TELA_MS`) e a entrega tenta de novo a
 *   cada `REENTREGA_MS` — entregar no meio da gravação o poria numa lista que a tela limpa
 *   quando a resposta chega, e a peça sumiria sem aviso;
 * - `'sem-leitor'`: espera `ESPERA_DO_LEITOR_MS` (F5, troca de tela) antes de avisar;
 * - `'janela-aberta'`: avisa na hora ("feche-a e bipe de novo") e segue.
 *
 * Separada do `retirar` de propósito: código esperando aqui não segura a retirada, e a fila do
 * servidor não envelhece enquanto a tela está ocupada. `entregar(codigo)` é o
 * `entregarCodigoDeFora` de `leitor.js`; `avisar(texto)` mostra o aviso; `aoErro(erro)` recebe
 * a falha do `aoLer`; `agora()` e `agendar(fn, ms)` (devolve o cancelar) são o relógio — o teste
 * troca os dois.
 */
export function criarEntrega({
  entregar,
  avisar,
  aoErro = () => {},
  agora = () => Date.now(),
  agendar = (fn, ms) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
}) {
  let fila = [];
  let rodando = false;
  let cancelar = null;
  // `limpar` abre uma geração nova: o laço antigo, parado num `await`, acorda e sai quieto.
  let geracao = 0;

  async function esvaziar() {
    if (rodando) return;
    rodando = true;
    const minha = geracao;
    cancelar?.();
    cancelar = null;
    try {
      while (fila.length && minha === geracao) {
        const { codigo, desde } = fila[0];
        let resultado;
        try {
          resultado = await entregar(codigo);
        } catch (erro) {
          if (minha !== geracao) return;
          fila.shift();
          aoErro(erro);
          continue;
        }
        if (minha !== geracao) return;
        const esperou = agora() - desde;
        const esperar =
          (resultado === 'tela-ocupada' && esperou < ESPERA_DA_TELA_MS) ||
          (resultado === 'sem-leitor' && esperou < ESPERA_DO_LEITOR_MS);
        if (esperar) {
          cancelar = agendar(() => {
            cancelar = null;
            void esvaziar();
          }, REENTREGA_MS);
          return;
        }
        fila.shift();
        const texto = avisoDaEntrega(resultado, codigo);
        if (texto) avisar(texto);
      }
    } finally {
      if (minha === geracao) rodando = false;
    }
  }

  return {
    /** Os códigos de um `retirar`, na ordem: entram no fim da fila e a entrega começa. */
    receber(codigos) {
      const quando = agora();
      for (const codigo of codigos) fila.push({ codigo, desde: quando });
      return esvaziar();
    },
    /** Esquece o que esperava (a sessão saiu: não entra na tela de quem vier depois). */
    limpar() {
      geracao += 1;
      fila = [];
      rodando = false;
      cancelar?.();
      cancelar = null;
    },
    /** Quantos esperam a vez (para o teste). */
    esperando: () => fila.length,
  };
}

/** Quanto a aba que retoma um leitor espera a dona dele responder. */
export const ESPERA_DA_DONA_MS = 300;

/**
 * Um leitor, uma aba. "Duplicar aba" copia o `sessionStorage` — e, com ele, o id do leitor:
 * sem isto as duas abas retirariam a mesma fila e os bipes se dividiriam entre dois carrinhos,
 * um deles numa aba escondida. Antes de retomar um leitor, a aba pergunta no `canal` (um
 * `BroadcastChannel`, que não exige HTTPS: a loja na rede local é HTTP) se outra já cuida dele;
 * a que cuida (`meu()` devolve o id dela) responde, e quem perguntou não retoma.
 *
 * Sem `canal` (navegador muito antigo), a pergunta responde "ninguém" e nada muda.
 */
export function criarDonaDaAba({
  canal,
  meu,
  esperaMs = ESPERA_DA_DONA_MS,
  agendar = (fn, ms) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
}) {
  const perguntas = new Map();
  canal?.addEventListener('message', (evento) => {
    const { tipo, id } = evento?.data ?? {};
    if (!Number.isInteger(id)) return;
    if (tipo === 'quem-cuida' && meu() === id) canal.postMessage({ tipo: 'eu-cuido', id });
    else if (tipo === 'eu-cuido') perguntas.get(id)?.(true);
  });

  return {
    /** Resolve `true` se outra aba já cuida do leitor `id`. */
    outraCuida(id) {
      if (!canal) return Promise.resolve(false);
      return new Promise((resolve) => {
        let desistir = () => {};
        const responder = (sim) => {
          desistir();
          perguntas.delete(id);
          resolve(sim);
        };
        perguntas.set(id, responder);
        desistir = agendar(() => responder(false), esperaMs);
        canal.postMessage({ tipo: 'quem-cuida', id });
      });
    },
  };
}

// ------------------------------------------------------------- o chamado (ADR-47), só do web

/**
 * "Abrir no app o leitor de código" (ADR-47): o computador chama o celular do MESMO login, sem
 * QR. A área mora acima do campo de leitura das telas que leem código (`leitor-chamado.js` pinta;
 * `leitor-celular.js` guarda o estado). Daqui saem só o estado e as frases, para o teste.
 *
 * Os rótulos são o que a vendedora procura na tela (e o que o guia do revisor cita).
 */
export const ROTULOS_DO_CHAMADO = Object.freeze({
  chamar: 'Abrir no app o leitor de código',
  qrDeOutraPessoa: 'Celular de outra pessoa? Ler o QR',
  chamarDeNovo: 'Chamar de novo',
  cancelar: 'Cancelar',
  lerQr: 'Ler o QR',
  mostrarQr: 'Mostrar o QR',
  desligar: 'Desligar',
});

/**
 * Em que pé está o leitor desta aba, do ponto de vista da área do chamado:
 *
 * - `'pedindo'`: o POST do chamado está no ar — pintado no CLIQUE, antes da resposta (o envio
 *   da notificação pode segurar a resposta uns segundos);
 * - `'livre'`: nenhum pareamento vivo na aba (sem, ou o que havia venceu/terminou);
 * - `'chamando'`: um chamado AGUARDANDO o celular atender;
 * - `'qr'`: um código de QR AGUARDANDO (pareamento sem `chamado` também é QR);
 * - `'ligado'`: ATIVO, de chamado ou de QR — é o "aceito".
 */
export function estadoDoChamado({ pareamento, pedindo } = {}) {
  if (pedindo) return 'pedindo';
  if (pareamento?.status === 'ATIVO') return 'ligado';
  if (pareamento?.status === 'AGUARDANDO') return pareamento.chamado ? 'chamando' : 'qr';
  return 'livre';
}

/**
 * Por que o celular foi avisado, ou não — a dica debaixo do sinal, pela `notificacao` da resposta
 * do chamado. `null` (F5, reenvio da mesma chave: o servidor não conta de novo) cai na frase
 * geral. Nenhuma fala de dono nem de repositório: a chave da Apple é de quem publica o app, não
 * de cada loja. E a do push desligado — o padrão do servidor — não fala de chave nem de Apple.
 * @param {string | null | undefined} situacao
 * @param {{ celulares?: number }} [extra]
 */
export function avisoDaNotificacao(situacao, { celulares = 0 } = {}) {
  switch (situacao) {
    case 'ENVIADA':
      return `Notificação enviada a ${plural(celulares, 'celular', 'celulares')} com o seu login: toque nela — ou abra o app, o chamado aparece lá.`;
    case 'SEM_CELULAR':
      return 'Nenhum celular com o seu login tem o app atualizado. Atualize o app, entre com o MESMO login e abra-o — ou leia o QR.';
    case 'SEM_NOTIFICACAO':
      return 'O celular com o seu login não recebe notificações deste app: com o app aberto, o chamado aparece lá. Para receber com o app fechado: no celular, Mais → Leitor do computador.';
    case 'DESLIGADA':
      return 'Com o app aberto no celular, o chamado aparece lá. Ou leia o QR.';
    case 'SEM_CHAVE_DA_APPLE':
      return 'O iPhone ainda não recebe as notificações deste app (falta um passo de quem publica o app): com o app aberto, o chamado aparece lá — ou leia o QR.';
    case 'FALHOU':
      return 'A notificação não saiu agora: com o app aberto, o chamado aparece lá — ou leia o QR.';
    default:
      return 'Toque na notificação no celular — ou abra o app: o chamado aparece lá.';
  }
}

/**
 * O aviso do chamado que terminou sem ninguém atender, ou `null`. Cancelar foi a própria pessoa
 * (sem aviso); o SUBSTITUIDO pelo "Chamar de novo" ou pelo QR desta mesma aba nem chega aqui —
 * por fora, só o teto de 10 leitores vivos do login encerra o chamado de uma aba.
 */
export function avisoDoChamadoQueAcabou(pareamento) {
  if (pareamento?.status === 'EXPIRADO') {
    return 'O celular não atendeu em 5 min. Toque de novo em “Abrir no app o leitor de código” — ou leia o QR.';
  }
  if (pareamento?.status === 'ENCERRADO' && pareamento.motivo_encerramento === 'SUBSTITUIDO') {
    return 'Este chamado foi encerrado: há leitores demais abertos com o seu login.';
  }
  return null;
}

const acao = (nome, rotulo, jeito = 'botao') => ({ acao: nome, rotulo, jeito });

/**
 * O que a área mostra em cada estado. `trechos` é a frase em pedaços: texto, e o sinal à parte
 * (`{ sinal }`), que a tela destaca — tudo entra por `textContent`, nunca como HTML (o nome do
 * celular vem do servidor). `texto` é a frase inteira. `acoes` são os botões, na ordem, como
 * `{ acao, rotulo, jeito }`: `acao` vai no `data-acao`, e `jeito` é `'principal'`, `'botao'` ou
 * `'link'`. `travado`: um pedido no ar (o do chamado, cancelar, desligar, o QR nascendo) — os
 * botões ficam apagados até a resposta.
 *
 * O "ligado" pelo QR não oferece "Chamar de novo": pode ser o celular de OUTRA pessoa, e chamar
 * o do próprio login o desligaria.
 * @param {string} estado o de `estadoDoChamado`
 * @param {{ pareamento?: object | null, notificacao?: { situacao?: string | null, celulares?: number } | null, ocupado?: boolean }} [leitor]
 */
export function oQueMostrar(estado, { pareamento = null, notificacao = null, ocupado = false } = {}) {
  const sinal = pareamento?.sinal || null;
  let trechos = [];
  let dica = null;
  let acoes;

  if (estado === 'pedindo' || estado === 'chamando') {
    // "Chamando…" já no clique; o sinal entra quando a resposta chega. Os mesmos botões nos
    // dois: a resposta não mexe a área de lugar, só acende os botões.
    trechos =
      estado === 'chamando' && sinal
        ? ['Chamando o leitor no seu celular… Sinal ', { sinal }, ' — confira o mesmo no celular.']
        : ['Chamando o leitor no seu celular…'];
    if (estado === 'chamando') {
      dica = avisoDaNotificacao(notificacao?.situacao ?? null, { celulares: notificacao?.celulares ?? 0 });
    }
    acoes = [
      acao('chamar-de-novo', ROTULOS_DO_CHAMADO.chamarDeNovo),
      acao('cancelar', ROTULOS_DO_CHAMADO.cancelar),
      acao('qr', ROTULOS_DO_CHAMADO.lerQr, 'link'),
    ];
  } else if (estado === 'qr') {
    trechos = ['Esperando um celular ler o QR…'];
    acoes = [acao('mostrar-qr', ROTULOS_DO_CHAMADO.mostrarQr), acao('cancelar', ROTULOS_DO_CHAMADO.cancelar)];
  } else if (estado === 'ligado') {
    const quem = pareamento?.aparelho_nome || 'alguém';
    const doChamado = !!pareamento?.chamado;
    trechos =
      doChamado && sinal
        ? [`Celular de ${quem} ligado (sinal `, { sinal }, '): as leituras caem aqui.']
        : [`Celular de ${quem} ligado: as leituras caem aqui.`];
    acoes = doChamado
      ? [acao('chamar-de-novo', ROTULOS_DO_CHAMADO.chamarDeNovo), acao('desligar', ROTULOS_DO_CHAMADO.desligar)]
      : [acao('desligar', ROTULOS_DO_CHAMADO.desligar)];
  } else {
    acoes = [
      acao('chamar', ROTULOS_DO_CHAMADO.chamar, 'principal'),
      acao('qr', ROTULOS_DO_CHAMADO.qrDeOutraPessoa, 'link'),
    ];
  }
  const texto = trechos.map((t) => (typeof t === 'string' ? t : t.sinal)).join('');
  return { trechos, texto, dica, acoes, travado: estado === 'pedindo' || !!ocupado };
}
