/**
 * O id desta instalação do app (ADR-47): um UUID v4 sorteado uma vez e guardado no SecureStore.
 *
 * Vai no aceite, no atender, em cada bipe, no registro de notificação e no esquecimento. É o
 * que separa dois celulares com o MESMO login (normal numa loja): o reenvio de um atender só
 * vale para o aparelho que atendeu, o bipe de outro aparelho é recusado, e o "trocou de leitor"
 * vale por aparelho, não por login. Não identifica a pessoa — só o app neste aparelho, e só
 * para o servidor da loja: trocar de servidor sorteia outro (`novaInstalacao`), para servidores
 * diferentes não receberem o mesmo identificador.
 *
 * No export web não há SecureStore: o id vale uma carga da página.
 */

import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { gerarUuid } from './uuid';

const CHAVE = 'instalacao-do-app';
const FORMATO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let emMemoria: string | null = null;
let lendo: Promise<string> | null = null;
/** Sobe a cada `novaInstalacao`: a leitura do cofre que voltar depois não traz o id velho. */
let geracao = 0;

async function lerOuSortear(minha: number): Promise<string> {
  let salvo: string | null = null;
  try {
    salvo = await SecureStore.getItemAsync(CHAVE);
  } catch {
    // Cofre indisponível: um id novo vale para esta abertura do app.
  }
  if (minha !== geracao && emMemoria) return emMemoria;
  if (salvo && FORMATO.test(salvo)) {
    emMemoria = salvo;
    return salvo;
  }
  const novo = gerarUuid();
  emMemoria = novo;
  try {
    await SecureStore.setItemAsync(CHAVE, novo);
  } catch {
    // Sem gravar, o próximo aberto sorteia outro: o servidor esquece este em 30 dias.
  }
  return novo;
}

/** O id desta instalação. Lido do cofre uma vez; depois, da memória. Nunca falha. */
export function idDaInstalacao(): Promise<string> {
  if (emMemoria) return Promise.resolve(emMemoria);
  if (Platform.OS === 'web') {
    emMemoria = gerarUuid();
    return Promise.resolve(emMemoria);
  }
  lendo ??= lerOuSortear(geracao).finally(() => {
    lendo = null;
  });
  return lendo;
}

/**
 * Sorteia outro id: o app passou a falar com outro servidor. Quem sai do servidor anterior
 * (o `sair` de "Trocar de servidor") já pediu a ele que esquecesse o id velho.
 */
export async function novaInstalacao(): Promise<string> {
  geracao += 1;
  const novo = gerarUuid();
  emMemoria = novo;
  if (Platform.OS !== 'web') {
    try {
      await SecureStore.setItemAsync(CHAVE, novo);
    } catch {
      // Fica na memória: vale para esta abertura do app.
    }
  }
  return novo;
}
