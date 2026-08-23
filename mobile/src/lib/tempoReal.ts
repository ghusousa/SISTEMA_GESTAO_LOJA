/**
 * A ligação que mantém o app em dia com o resto da loja.
 *
 * Sem isto, cada aparelho vivia da própria cópia dos dados: cadastrava-se uma peça no
 * computador do balcão e o celular só a via depois de fechar e abrir o app. Agora o
 * servidor avisa, e a tela aberta refaz a consulta sozinha.
 *
 * O que chega é um AVISO ("estoque mudou"), nunca o dado. Quem busca é a rota REST de
 * sempre, com o filtro por papel inteiro — é isso que impede uma vendedora de receber
 * custo por um caminho lateral.
 *
 * Reconectar é a regra, não a exceção: celular entra no elevador, troca de Wi-Fi para
 * 4G, dorme no bolso. A queda é rotina e a volta é automática, com espera crescente para
 * não martelar um servidor que caiu.
 */

import { baseAtual } from '@/api/client';
import { lerAccessToken } from '@/api/sessao';
import { chaves, queryClient } from '@/lib/queryClient';

/** Os mesmos assuntos de `api/app/core/eventos.py`. Mudou lá, mude aqui. */
export type Assunto =
  | 'catalogo'
  | 'estoque'
  | 'vendas'
  | 'despesas'
  | 'caixa'
  | 'usuarios'
  | 'conectado'
  | 'ping';

const ESPERA_INICIAL = 1000;
const ESPERA_MAXIMA = 30_000;

let socket: WebSocket | null = null;
let tentativas = 0;
let religar: ReturnType<typeof setTimeout> | null = null;
/** Enquanto for false, qualquer queda é definitiva: ninguém está logado. */
let ligado = false;

/** O que recarregar quando cada assunto chega. */
function aoReceber(assunto: Assunto): void {
  switch (assunto) {
    case 'catalogo':
      queryClient.invalidateQueries({ queryKey: chaves.produtos });
      queryClient.invalidateQueries({ queryKey: chaves.categorias });
      // O lookup por código de barras guarda a peça bipada: preço editado no balcão
      // precisa valer no próximo bipe, não no próximo login.
      queryClient.invalidateQueries({ queryKey: ['variante-codigo'] });
      break;
    case 'estoque':
      queryClient.invalidateQueries({ queryKey: chaves.saldos });
      queryClient.invalidateQueries({ queryKey: chaves.movimentacoes });
      queryClient.invalidateQueries({ queryKey: chaves.produtos });
      queryClient.invalidateQueries({ queryKey: chaves.estoqueBaixo });
      queryClient.invalidateQueries({ queryKey: ['variante-codigo'] });
      break;
    case 'vendas':
      queryClient.invalidateQueries({ queryKey: chaves.vendas });
      queryClient.invalidateQueries({ queryKey: ['caixa-dia'] });
      invalidarRelatorios();
      break;
    case 'despesas':
      queryClient.invalidateQueries({ queryKey: chaves.despesas });
      queryClient.invalidateQueries({ queryKey: chaves.categoriasDespesa });
      invalidarRelatorios();
      break;
    case 'caixa':
      queryClient.invalidateQueries({ queryKey: ['caixa-dia'] });
      queryClient.invalidateQueries({ queryKey: chaves.fechamentos });
      break;
    case 'usuarios':
      queryClient.invalidateQueries({ queryKey: chaves.usuarios });
      break;
    default:
      break; // 'conectado' e 'ping' são só sinal de vida
  }
}

function invalidarRelatorios(): void {
  for (const chave of [
    ['relatorio-resumo'],
    ['relatorio-vendas-dia'],
    ['relatorio-mais-vendidos'],
    ['relatorio-despesas'],
  ]) {
    queryClient.invalidateQueries({ queryKey: chave });
  }
}

function urlDoCanal(): string {
  // ws:// para http://, wss:// para https:// — a conexão segue o mesmo endereço da API,
  // então não há um segundo lugar para configurar quando a loja muda de servidor.
  return `${baseAtual().replace(/^http/i, 'ws')}/api/v1/tempo-real`;
}

function agendarReconexao(): void {
  if (!ligado || religar) return;
  // Espera crescente com teto: servidor fora do ar não pode receber uma tentativa por
  // segundo de cada celular da loja.
  const espera = Math.min(ESPERA_INICIAL * 2 ** tentativas, ESPERA_MAXIMA);
  tentativas += 1;
  religar = setTimeout(() => {
    religar = null;
    void abrir();
  }, espera);
}

async function abrir(): Promise<void> {
  if (!ligado || socket) return;

  const token = await lerAccessToken();
  if (!token) {
    // Sem sessão não há o que ouvir. Não é erro: acontece entre o logout e o login.
    agendarReconexao();
    return;
  }

  const ws = new WebSocket(urlDoCanal());
  socket = ws;

  ws.onopen = () => {
    // O token vai no primeiro quadro, e não na URL: em query string ele entraria no log
    // de acesso do servidor e no de qualquer proxy do caminho.
    ws.send(JSON.stringify({ tipo: 'entrar', token }));
  };

  ws.onmessage = (evento) => {
    try {
      const { assunto } = JSON.parse(String(evento.data)) as { assunto: Assunto };
      if (assunto === 'conectado') {
        tentativas = 0; // só zera depois de o servidor aceitar, não ao abrir o socket
        // Ficamos um tempo sem ouvir: o que mudou nesse meio-tempo não gerou aviso para
        // este aparelho. Recarregar tudo agora é o que fecha o buraco da reconexão.
        void queryClient.invalidateQueries();
        return;
      }
      aoReceber(assunto);
    } catch {
      // Mensagem estranha não derruba o canal: ignorar é melhor do que reconectar.
    }
  };

  const encerrar = () => {
    if (socket === ws) socket = null;
    agendarReconexao();
  };
  ws.onclose = encerrar;
  ws.onerror = encerrar;
}

/** Liga o canal. Chamado quando a sessão abre. */
export function conectarTempoReal(): void {
  if (ligado) return;
  ligado = true;
  tentativas = 0;
  void abrir();
}

/** Desliga de vez: logout, ou troca de servidor. */
export function desconectarTempoReal(): void {
  ligado = false;
  if (religar) {
    clearTimeout(religar);
    religar = null;
  }
  const atual = socket;
  socket = null;
  atual?.close();
}

/** O app voltou do fundo: reconecta na hora, sem esperar a próxima tentativa. */
export function acordarTempoReal(): void {
  if (!ligado) return;
  if (socket && socket.readyState === WebSocket.OPEN) {
    // Conexão de pé, mas o aparelho pode ter passado horas dormindo e perdido avisos.
    void queryClient.invalidateQueries();
    return;
  }
  if (religar) {
    clearTimeout(religar);
    religar = null;
  }
  tentativas = 0;
  void abrir();
}
