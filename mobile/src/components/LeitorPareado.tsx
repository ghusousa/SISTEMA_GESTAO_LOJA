/**
 * O celular ligado como leitor de um computador (ADR-43): câmera lendo etiqueta sem parar,
 * cada leitura vai para a fila (`stores/leitorStore.ts`) e de lá para o campo do leitor
 * do computador, como se fosse o leitor USB.
 *
 * A câmera é o `Scanner` de sempre, com as mesmas travas de `lib/leitura.ts` (e a vibração
 * de sucesso dele a cada leitura aceita). A tela confere o pareamento a cada 15 s enquanto
 * está na frente de alguém: o computador pode ter desligado, ou as 12 h passado — e na hora,
 * quando o tempo real avisa que um pareamento mudou (`leitor_pareamento`).
 *
 * Ligado pelo chamado do computador (ADR-47), mostra o sinal ("Lendo para o computador do
 * sinal 7K3"). Outro computador chamando este login aparece numa linha com [Trocar]: a faixa
 * do topo só avisa, e trocar é aqui, onde se vê para quem as leituras vão agora. Sem diálogo:
 * a câmera segue lendo, e o que não tiver saído para o computador anterior fica na lista como
 * "não enviado" (`leitorStore.ligar`).
 *
 * Entre o cabeçalho e a câmera (42% da tela) não entra nada que cresça: as linhas dos outros
 * chamados (até 10 por login), o alerta, os bipes e o "Desligar" moram na rolagem de baixo.
 * Com três chamados abertos no iPhone SE, as linhas lá em cima espremiam a lista e empurravam
 * o "Desligar" para fora da tela — e a câmera pulava para baixo a cada chamado novo.
 */

import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { format } from 'date-fns';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';

import { leitor } from '@/api/endpoints';
import type { Pareamento } from '@/api/tipos';
import { ROTULOS_DO_CHAMADO } from '@/components/FaixaDoChamado';
import { Scanner, type ScannerRef } from '@/components/Scanner';
import { Botao, Cartao, useRespiroDeBaixo } from '@/components/ui';
import { useChamadosDoLeitor, type AtenderChamado } from '@/hooks/useChamadosDoLeitor';
import { useLoja } from '@/hooks/useLoja';
import { sinalValido } from '@/lib/notificacoes';
import { chaves } from '@/lib/queryClient';
import { cores, espaco, fonte, raio } from '@/lib/tema';
import {
  HISTORICO_DE_BIPES,
  useLeitorStore,
  type BipeDaFila,
  type EstadoDoBipe,
} from '@/stores/leitorStore';

const CONSULTA_A_CADA_MS = 15_000;

const ROTULO: Record<EstadoDoBipe, { texto: string; cor: string; fundo: string }> = {
  enviando: { texto: 'enviando…', cor: cores.alerta, fundo: cores.alertaFraco },
  enviado: { texto: 'enviado', cor: cores.acaoEscura, fundo: cores.sucessoFraco },
  'nao-enviado': { texto: 'não enviado', cor: cores.perigo, fundo: cores.perigoFraco },
  // A rede não respondeu: pode ter chegado. Bipar de novo sem conferir põe a peça duas vezes.
  'sem-confirmacao': { texto: 'confira no computador', cor: cores.alerta, fundo: cores.alertaFraco },
};

/** A lista de bipes com o estado de cada um (mais novo em cima), e o que cada rótulo quer dizer. */
export function ListaDeBipes({ bipes }: { bipes: readonly BipeDaFila[] }) {
  const incertos = bipes.some((b) => b.estado === 'sem-confirmacao');
  return (
    <Cartao estilo={s.lista}>
      {bipes.map((bipe) => {
        const rotulo = ROTULO[bipe.estado];
        return (
          <View key={bipe.uuid} style={s.linha}>
            <Text style={s.codigo} numberOfLines={1}>
              {bipe.codigo}
            </Text>
            <Text style={[s.estado, { color: rotulo.cor, backgroundColor: rotulo.fundo }]}>
              {rotulo.texto}
            </Text>
          </View>
        );
      })}
      <Text style={s.legenda}>
        “Enviado” é chegou ao servidor: se o computador não pegar a leitura em 2 min, é ele
        quem avisa que ela não entrou.
        {incertos
          ? ' “Confira no computador”: a rede não respondeu e a leitura pode ter chegado — olhe a tela de lá antes de bipar de novo.'
          : ''}
      </Text>
    </Cartao>
  );
}

/** Hora no fuso da LOJA (vem de `GET /configuracao`), nunca no do aparelho. */
function horaNaLoja(iso: string | null, fuso: string | undefined): string {
  if (!iso) return '';
  const instante = new Date(iso);
  if (Number.isNaN(instante.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: fuso || 'America/Sao_Paulo',
    }).format(instante);
  } catch {
    // Fuso desconhecido ou Intl sem fusos: a hora do aparelho é melhor que nenhuma.
    return format(instante, 'HH:mm');
  }
}

interface Props {
  pareamento: Pareamento;
  /** Tela em foco e app na frente: só assim a câmera e a consulta ligam. */
  visivel: boolean;
  /** O atender da tela do leitor (o Trocar). */
  atendimento: AtenderChamado;
  /** O sinal do chamado que a pessoa tocou na notificação com o leitor ligado: em destaque. */
  destaque: string | null;
  /** O toque numa notificação cujo chamado já acabou (ou a busca que não respondeu). */
  avisoDoToque: string | null;
}

/**
 * Outro computador chamando este login, com o leitor ligado: uma linha por chamado que ainda
 * vale, cada uma com o seu sinal e o [Trocar]. O que a pessoa tocou na notificação vem em
 * destaque. Mora no topo da rolagem, logo abaixo da câmera (ver o cabeçalho do arquivo).
 */
function OutrosChamando({
  atendimento,
  destaque,
  avisoDoToque,
}: {
  atendimento: AtenderChamado;
  destaque: string | null;
  avisoDoToque: string | null;
}) {
  const { vivos } = useChamadosDoLeitor();
  const chamados = vivos.filter((c) => sinalValido(c.sinal));
  const aviso = atendimento.aviso ?? avisoDoToque;
  if (chamados.length === 0 && !aviso) return null;
  return (
    <Cartao estilo={s.outros}>
      {chamados.map((chamado) => (
        <View key={chamado.id} style={[s.outro, chamado.sinal === destaque && s.outroDestaque]}>
          <Text style={s.outroTexto}>
            {ROTULOS_DO_CHAMADO.outro} (sinal <Text style={s.outroSinal}>{chamado.sinal}</Text>)
          </Text>
          <Botao
            titulo={ROTULOS_DO_CHAMADO.trocar}
            variante="secundario"
            carregando={atendimento.atendendoId === chamado.id}
            desabilitado={atendimento.atendendo && atendimento.atendendoId !== chamado.id}
            // Sem pedir a permissão de notificação aqui: a câmera está montada (5.1.1).
            onPress={() => atendimento.atender(chamado.id, { pedirPermissao: false })}
          />
        </View>
      ))}
      {!!aviso && <Text style={s.outroAviso}>{aviso}</Text>}
    </Cartao>
  );
}

export function LeitorPareado({ pareamento, visivel, atendimento, destaque, avisoDoToque }: Props) {
  const loja = useLoja();
  const bipes = useLeitorStore((e) => e.bipes);
  const ler = useLeitorStore((e) => e.ler);
  const atualizar = useLeitorStore((e) => e.atualizar);
  const encerrar = useLeitorStore((e) => e.encerrar);
  const desligar = useLeitorStore((e) => e.desligar);
  const alerta = useLeitorStore((e) => e.alerta);
  const scanner = useRef<ScannerRef | null>(null);
  // "Desligar" é o fim da lista, que vai até a base da tela: acima do indicador de início.
  const respiroDeBaixo = useRespiroDeBaixo();
  const [desligando, setDesligando] = useState(false);
  // Em estado da TELA, não só na pausa de dentro do Scanner: o celular que bloqueia com o
  // diálogo aberto desmonta a câmera, e a que volta nasceria lendo por baixo dele.
  const [perguntando, setPerguntando] = useState(false);

  const consulta = useQuery({
    queryKey: chaves.leitor(pareamento.id),
    queryFn: () => leitor.consultar(pareamento.id),
    enabled: visivel,
    refetchInterval: CONSULTA_A_CADA_MS,
    // Voltou para a frente: confere na hora, sem esperar a próxima volta do relógio.
    staleTime: 0,
    retry: false,
  });

  useEffect(() => {
    if (consulta.data) atualizar(consulta.data);
  }, [consulta.data, atualizar]);

  useEffect(() => {
    // 404: o pareamento não existe mais para este usuário. Rede caída não desliga nada —
    // a fila segura os bipes e a próxima consulta tenta de novo.
    const erro = consulta.error;
    if (axios.isAxiosError(erro) && erro.response?.status === 404) {
      encerrar('O computador desligou o leitor.');
    }
  }, [consulta.error, encerrar]);

  const aoLer = useCallback((codigo: string) => ler(codigo), [ler]);

  function confirmarDesligar() {
    // Diálogo na frente da câmera: ela para, senão segue lendo por baixo (CLAUDE.md).
    scanner.current?.pausar();
    setPerguntando(true);
    const retomar = () => {
      setPerguntando(false);
      scanner.current?.retomar();
    };
    Alert.alert(
      'Desligar o leitor?',
      'O computador para de receber os bipes deste celular.',
      [
        { text: 'Continuar bipando', style: 'cancel', onPress: retomar },
        {
          text: 'Desligar',
          style: 'destructive',
          onPress: () => {
            setDesligando(true);
            void desligar();
          },
        },
      ],
      { cancelable: true, onDismiss: retomar },
    );
  }

  const ultimos = bipes.slice(-HISTORICO_DE_BIPES).reverse();
  const ate = horaNaLoja(pareamento.expira_em, loja.timezone);

  return (
    <View style={s.tela}>
      <View style={s.cabecalho}>
        <Text style={s.titulo} numberOfLines={2}>
          Ligado ao computador de {pareamento.computador_nome}
        </Text>
        {pareamento.chamado && sinalValido(pareamento.sinal) && (
          <Text style={s.sinal}>Lendo para o computador do sinal {pareamento.sinal}</Text>
        )}
        {!!ate && <Text style={s.ate}>até {ate}</Text>}
      </View>

      <View style={s.cameraArea}>
        {visivel ? (
          <Scanner
            aoLer={aoLer}
            modo="continuo"
            ativo={!perguntando && !desligando}
            controle={scanner}
            dica="Bipe as peças: cada uma vai para o computador"
          />
        ) : (
          <View style={s.cameraParada} />
        )}
      </View>

      <ScrollView contentContainerStyle={[s.conteudo, { paddingBottom: respiroDeBaixo }]}>
        {/* Na rolagem, e não acima da câmera: quantos forem, o "Desligar" continua ao alcance. */}
        <OutrosChamando atendimento={atendimento} destaque={destaque} avisoDoToque={avisoDoToque} />
        {!!alerta && (
          <Cartao estilo={s.alerta}>
            <Text style={s.alertaTexto}>{alerta}</Text>
          </Cartao>
        )}
        {ultimos.length === 0 ? (
          <Text style={s.vazio}>
            Nenhuma peça bipada ainda. O que você bipar aparece aqui e no computador.
          </Text>
        ) : (
          <ListaDeBipes bipes={ultimos} />
        )}

        <Botao
          titulo="Desligar"
          variante="perigo"
          carregando={desligando}
          onPress={confirmarDesligar}
        />
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  tela: { flex: 1, backgroundColor: cores.fundo },
  cabecalho: {
    paddingHorizontal: espaco.lg,
    paddingVertical: espaco.md,
    backgroundColor: cores.primariaFraca,
    gap: espaco.xs,
  },
  titulo: { fontSize: fonte.media, fontWeight: '700', color: cores.primaria },
  // `primariaClara`, e não o azul da faixa: sobre o fundo claro do cabeçalho ele não dá 4,5:1.
  sinal: { fontSize: fonte.base, fontWeight: '700', color: cores.primariaClara },
  ate: { fontSize: fonte.pequena, color: cores.textoSuave },
  outros: { gap: espaco.sm },
  outro: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: espaco.sm,
    borderRadius: raio.sm,
    paddingHorizontal: espaco.sm,
    paddingVertical: espaco.xs,
  },
  outroDestaque: { borderWidth: 2, borderColor: cores.chamadoDoLeitor, backgroundColor: cores.primariaFraca },
  outroTexto: { flex: 1, minWidth: 160, fontSize: fonte.base, color: cores.texto, fontWeight: '600' },
  outroSinal: { fontWeight: '800', color: cores.primariaClara, letterSpacing: 1 },
  outroAviso: { fontSize: fonte.pequena, color: cores.perigo },
  cameraArea: { height: '42%', backgroundColor: '#000' },
  cameraParada: { flex: 1, backgroundColor: '#000' },
  conteudo: { padding: espaco.lg, gap: espaco.md },
  vazio: { color: cores.textoSuave, fontSize: fonte.base, textAlign: 'center' },
  lista: { gap: espaco.sm },
  linha: { flexDirection: 'row', alignItems: 'center', gap: espaco.md },
  codigo: { flex: 1, fontSize: fonte.base, fontWeight: '600', color: cores.texto },
  estado: {
    fontSize: fonte.pequena,
    fontWeight: '700',
    paddingHorizontal: espaco.sm,
    paddingVertical: 2,
    borderRadius: raio.sm,
    overflow: 'hidden',
  },
  legenda: { fontSize: fonte.pequena, color: cores.textoSuave, lineHeight: 18 },
  alerta: { backgroundColor: cores.alertaFraco, borderColor: cores.alerta, borderWidth: 1 },
  alertaTexto: { fontSize: fonte.base, color: cores.texto, fontWeight: '600' },
});
