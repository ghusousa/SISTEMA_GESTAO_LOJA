/**
 * O registro deste aparelho no servidor da loja (ADR-47) — a ORDEM das coisas, sem sistema nem
 * rede, para dar para testar. Quem fala com o iOS, com o cofre e com a API é
 * `lib/pushDoLeitor.ts`, que entrega as dependências; as regras de cada decisão moram em
 * `lib/notificacoes.ts`.
 *
 * - REGISTRAR (`PUT /notificacoes/aparelho`) a cada sessão, com o token só se o servidor manda
 *   push e o iPhone deixou. De novo só quando há motivo: o sistema trocou o token, a permissão
 *   mudou, a volta ao app depois de 1 h, a configuração recém-chegada com OUTRO modo do push
 *   (o dono religou: sem isso o token só voltava na próxima ida ao fundo), e o toque em "Abrir
 *   o leitor" quando o último registro não bate com o que o aparelho pode agora. Nunca a cada
 *   religação do tempo real.
 * - ESQUECER na saída (`DELETE` sem sessão). Sem rede, fica UMA limpeza pendente, com data:
 *   vale 30 dias (a faxina do servidor). A do servidor de agora vai antes do registro; a de
 *   outro servidor corre ao lado, sem segurar o registro deste.
 *
 * Nenhum erro daqui sobe: o chamado continua chegando pela faixa, com o app aberto.
 */

import {
  comoRegistrar,
  destinoDaLimpeza,
  podeReceberPush,
  precisaRegistrarDeNovo,
  registrarPelaConfiguracao,
  trocaDoTokenDoAparelho,
  type Permissao,
  type UltimoRegistro,
} from './notificacoes';

/** A limpeza que a saída sem rede deixou: de qual servidor, qual instalação, e desde quando. */
export interface Limpeza {
  base: string;
  instalacao: string;
  em: number;
}

/** O teto da limpeza que ficou para trás (a da saída usa o tempo que a saída tem). */
export const TETO_DA_LIMPEZA_MS = 10_000;
/** O mínimo que o DELETE da saída tem para responder, mesmo depois de esperar um registro. */
const MINIMO_DO_ESQUECIMENTO_MS = 1000;

export interface DependenciasDoRegistro {
  /** `Platform.OS`: no web não há o que registrar (não é o app de ninguém). */
  plataforma: string;
  /** No Expo Go o push deste app não existe. */
  expoGo: boolean;
  /** Há sessão? Sem ela, o PUT daria 401 e o interceptor "encerraria" o que nem existe. */
  temSessao(): Promise<boolean>;
  /** O modo do push (pode ir à rede, com o frescor do app). `null`: não deu para saber agora. */
  pushNoServidor(): Promise<boolean | null>;
  /** O mesmo, só do que já está no cache (a volta ao app não espera a rede). */
  pushEmCache(): boolean | null;
  base(): string;
  instalacao(): Promise<string>;
  /** A permissão do sistema, sem perguntar (só chamada onde o push pode existir). */
  permissao(): Promise<Permissao | null>;
  /** O token da Expo; `undefined`: não veio agora (o registro sai SEM o campo). */
  token(): Promise<string | undefined>;
  registrar(corpo: { instalacao: string; plataforma: 'ios' | 'android'; token?: string | null }): Promise<unknown>;
  esquecer(base: string, instalacao: string, opcoes: { timeout: number }): Promise<unknown>;
  /** O servidor respondeu (qualquer status)? Sem resposta é rede, tempo esgotado ou servidor fora. */
  respondeu(erro: unknown): boolean;
  /** Onde a limpeza pendente mora (o SecureStore, no app). */
  cofre: {
    ler(): Promise<string | null>;
    gravar(texto: string): Promise<void>;
    apagar(): Promise<void>;
  };
  agora(): number;
  esperar(ms: number): Promise<void>;
}

export interface RegistroDoAparelho {
  /** Registra esta instalação para o login da sessão (o que chega no meio vira UMA rodada a mais). */
  registrar(): Promise<void>;
  /** A sessão abriu: a limpeza pendente do MESMO servidor antes, depois o registro. */
  preparar(): Promise<void>;
  /** O app voltou ao ativo, com sessão: registra de novo só quando há motivo. */
  naVolta(): Promise<void>;
  /** A configuração do servidor acabou de chegar com este modo do push. */
  aoMudarAConfiguracao(push: boolean | null): void;
  /** O que o aparelho pode agora (o toque em "Abrir o leitor", a tela do leitor): registra se não bate. */
  conferir(agora: { push: boolean; permissao: Permissao | null }): void;
  /** O sistema entregou um token do aparelho (`addPushTokenListener`). */
  aoTrocarOToken(recebido: unknown): void;
  /** A sessão acabou: o servidor esquece esta instalação. Nunca falha nem passa de `timeout`. */
  esquecer(opcoes?: { timeout?: number }): Promise<void>;
  /** A limpeza que ficou para trás, tentada a cada abertura do app. */
  tentarLimpezaPendente(): Promise<void>;
}

export function criarRegistroDoAparelho(dep: DependenciasDoRegistro): RegistroDoAparelho {
  const naoRegistra = dep.plataforma === 'web';
  const aparelho = { plataforma: dep.plataforma, expoGo: dep.expoGo };

  /** O último registro que deu certo nesta sessão (só na memória, sem o token). */
  let ultimo: UltimoRegistro | null = null;
  let emAndamento: Promise<void> | null = null;
  let deNovo = false;
  /**
   * A rodada no ar, e o modo do push que ela leu (`undefined`: ainda não leu — e vai ler a
   * configuração que acabou de chegar).
   */
  let noAr: { push?: boolean } | null = null;
  /** Sobe a cada esquecimento: o registro que começou antes da saída não grava depois dela. */
  let rodada = 0;
  /**
   * O esquecimento (ou a limpeza do MESMO servidor) que ainda está no ar. O registro de um login
   * novo espera por ele: um DELETE que chegasse ao servidor DEPOIS do PUT apagaria o registro
   * novo (a sessão que caiu esquece sem esperar, e a pessoa pode entrar de novo em seguida).
   */
  let esquecendo: Promise<void> | null = null;
  let limpando: Promise<void> | null = null;
  /** A limpeza de OUTRO servidor: corre ao lado, e nada espera por ela. */
  let limpandoOutro: Promise<void> | null = null;
  /** O último token do APARELHO (o da Apple) que o sistema entregou — só para ver se mudou. */
  let tokenDoAparelho: string | null = null;

  async function registrarUmaVez(): Promise<void> {
    const minha = rodada;
    const estaRodada: { push?: boolean } = {};
    noAr = estaRodada;
    try {
      if (!(await dep.temSessao())) return;
      const push = await dep.pushNoServidor();
      if (push === null) return; // sem servidor agora: a volta ao app tenta de novo
      estaRodada.push = push;
      const base = dep.base();
      const instalacao = await dep.instalacao();
      const daqui = { ...aparelho, pushNoServidor: push };
      // A API de permissão só é tocada quando o push pode existir aqui (o servidor manda e é iPhone).
      const permissao = podeReceberPush(daqui) ? await dep.permissao() : null;
      const como = comoRegistrar({ ...daqui, permissao });
      if (como === 'nao-registra') return;
      // `null`: este aparelho não recebe push (o servidor apaga o que tinha). `undefined`: o
      // token não veio agora — o campo sai do corpo e o servidor fica com o que já tinha.
      const token = como === 'com-token' ? await dep.token() : null;
      // A sessão saiu no meio: vale o esquecimento (e ele pode estar esperando este registro).
      if (minha !== rodada) return;
      // O esquecimento de ANTES deste registro ainda no ar: o PUT vai depois do DELETE.
      await Promise.all([esquecendo, limpando]);
      if (minha !== rodada) return;
      await dep.registrar({ instalacao, plataforma: dep.plataforma === 'ios' ? 'ios' : 'android', token });
      if (minha === rodada) ultimo = { base, push, permissao, hora: dep.agora() };
    } catch {
      // 404 (servidor de antes da ADR-47), rede, 5xx: em silêncio. A volta ao app tenta de novo.
    } finally {
      if (noAr === estaRodada) noAr = null;
    }
  }

  function registrar(): Promise<void> {
    if (naoRegistra) return Promise.resolve();
    if (emAndamento) {
      deNovo = true;
      return emAndamento;
    }
    emAndamento = (async () => {
      do {
        deNovo = false;
        await registrarUmaVez();
      } while (deNovo);
    })().finally(() => {
      emAndamento = null;
    });
    return emAndamento;
  }

  async function preparar(): Promise<void> {
    // Na ordem: a limpeza pendente pode ser desta mesma instalação neste mesmo servidor, e
    // chegando depois do registro apagaria o registro novo. A de outro servidor não segura nada.
    await tentarLimpezaPendente();
    await registrar();
  }

  async function naVolta(): Promise<void> {
    if (naoRegistra || emAndamento) return;
    try {
      const push = dep.pushEmCache();
      const permissao =
        push !== null && podeReceberPush({ ...aparelho, pushNoServidor: push }) ? await dep.permissao() : null;
      if (precisaRegistrarDeNovo({ ultimo, agora: dep.agora(), base: dep.base(), push, permissao })) {
        await registrar();
      }
    } catch {
      // Fica para a próxima volta.
    }
  }

  function aoMudarAConfiguracao(push: boolean | null): void {
    if (naoRegistra) return;
    // A rodada no ar que ainda não leu a configuração vai ler esta: ela mesma leva o modo novo.
    if (noAr && noAr.push === undefined) return;
    const registrado = noAr ? (noAr.push ?? null) : (ultimo?.push ?? null);
    if (registrarPelaConfiguracao({ ...aparelho, registrado, push })) void registrar();
  }

  function conferir({ push, permissao }: { push: boolean; permissao: Permissao | null }): void {
    // Com uma rodada no ar, ela (e a configuração que chegar depois dela) responde por isto.
    if (naoRegistra || emAndamento) return;
    // Onde o push não existe (Android sem FCM, Expo Go), o modo do servidor não muda o registro.
    const pushQueConta = podeReceberPush({ ...aparelho, pushNoServidor: true }) ? push : null;
    if (precisaRegistrarDeNovo({ ultimo, agora: dep.agora(), base: dep.base(), push: pushQueConta, permissao })) {
      void registrar();
    }
  }

  function aoTrocarOToken(recebido: unknown): void {
    const { valor, registrar: precisa } = trocaDoTokenDoAparelho({
      anterior: tokenDoAparelho,
      recebido,
      registrando: emAndamento !== null,
    });
    tokenDoAparelho = valor;
    if (precisa) void registrar();
  }

  // ---------------------------------------------------------------- esquecer

  /** A pendente como está no cofre; `em` falta na de uma versão sem data. Ilegível: `null`. */
  function lerLimpezaGuardada(texto: string | null): (Omit<Limpeza, 'em'> & { em?: number }) | null {
    if (!texto) return null;
    let lida: Partial<Limpeza> | null;
    try {
      lida = JSON.parse(texto) as Partial<Limpeza> | null;
    } catch {
      return null;
    }
    if (typeof lida?.base !== 'string' || typeof lida.instalacao !== 'string') return null;
    const em = typeof lida.em === 'number' && Number.isFinite(lida.em) ? lida.em : undefined;
    return { base: lida.base, instalacao: lida.instalacao, em };
  }

  async function guardarLimpeza(limpeza: Limpeza): Promise<void> {
    try {
      await dep.cofre.gravar(JSON.stringify(limpeza));
    } catch {
      // Sem cofre, sobra a faxina de 30 dias do servidor.
    }
  }

  async function lerLimpeza(): Promise<Limpeza | null> {
    try {
      const lida = lerLimpezaGuardada(await dep.cofre.ler());
      if (!lida) return null;
      if (lida.em !== undefined) return { base: lida.base, instalacao: lida.instalacao, em: lida.em };
      // A pendente de uma versão sem data: o prazo conta de agora (senão nunca venceria).
      const carimbada = { base: lida.base, instalacao: lida.instalacao, em: dep.agora() };
      await guardarLimpeza(carimbada);
      return carimbada;
    } catch {
      return null;
    }
  }

  /** Apaga a pendente — se ainda for ESTA: uma saída sem rede no meio guarda outra no lugar. */
  async function apagarLimpeza(limpeza: Limpeza): Promise<void> {
    try {
      const guardada = lerLimpezaGuardada(await dep.cofre.ler());
      if (
        guardada &&
        (guardada.base !== limpeza.base || guardada.instalacao !== limpeza.instalacao || guardada.em !== limpeza.em)
      ) {
        return;
      }
      await dep.cofre.apagar();
    } catch {
      // Na próxima abertura tenta de novo: o DELETE repetido é inofensivo (204 sempre).
    }
  }

  async function mandarLimpeza(limpeza: Limpeza): Promise<void> {
    try {
      await dep.esquecer(limpeza.base, limpeza.instalacao, { timeout: TETO_DA_LIMPEZA_MS });
      await apagarLimpeza(limpeza);
    } catch (erro) {
      // Qualquer resposta HTTP encerra — até o 404 de um servidor de antes da ADR-47, que nunca
      // soube deste aparelho. Sem resposta, fica para a próxima abertura (até vencer).
      if (dep.respondeu(erro)) await apagarLimpeza(limpeza);
    }
  }

  function tentarLimpezaPendente(): Promise<void> {
    if (naoRegistra) return Promise.resolve();
    limpando ??= (async () => {
      const pendente = await lerLimpeza();
      if (!pendente) return;
      const destino = destinoDaLimpeza({ pendente, base: dep.base(), agora: dep.agora() });
      if (destino === 'descartar') {
        await apagarLimpeza(pendente);
      } else if (destino === 'antes-do-registro') {
        await mandarLimpeza(pendente);
      } else {
        // Outro servidor (o de antes da troca de endereço, que pode nem existir mais): o registro
        // no servidor de agora não espera por ele.
        limpandoOutro ??= mandarLimpeza(pendente).finally(() => {
          limpandoOutro = null;
        });
      }
    })().finally(() => {
      limpando = null;
    });
    return limpando;
  }

  function esquecer({ timeout = 10_000 }: { timeout?: number } = {}): Promise<void> {
    if (naoRegistra) return Promise.resolve();
    rodada += 1;
    ultimo = null;
    // A rodada a mais que estava na fila era da sessão que acabou.
    deNovo = false;
    const fim = dep.agora() + timeout;
    const base = dep.base();
    const esta = (async () => {
      try {
        const instalacao = await dep.instalacao();
        // Um registro que já estava no ar chega ANTES do esquecimento, não depois dele.
        const registroNoAr = emAndamento;
        if (registroNoAr) await Promise.race([registroNoAr, dep.esperar(Math.max(0, fim - dep.agora()))]);
        try {
          await dep.esquecer(base, instalacao, { timeout: Math.max(MINIMO_DO_ESQUECIMENTO_MS, fim - dep.agora()) });
        } catch (erro) {
          if (!dep.respondeu(erro)) await guardarLimpeza({ base, instalacao, em: dep.agora() });
        }
      } catch {
        // Melhor esforço: o servidor esquece sozinho em 30 dias sem uso.
      }
    })().finally(() => {
      if (esquecendo === esta) esquecendo = null;
    });
    esquecendo = esta;
    return esta;
  }

  return {
    registrar,
    preparar,
    naVolta,
    aoMudarAConfiguracao,
    conferir,
    aoTrocarOToken,
    esquecer,
    tentarLimpezaPendente,
  };
}
