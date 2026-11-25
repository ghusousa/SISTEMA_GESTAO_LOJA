/**
 * "O computador está chamando · Sinal 7K3" (ADR-47): o chamado do computador dentro do app.
 *
 * No computador, "Abrir no app o leitor de código" chama o leitor no celular do MESMO login.
 * Com o app aberto, em qualquer tela, desce esta faixa no topo (`ComFaixasNoTopo`, depois do
 * aviso de sem conexão e da faixa da demonstração), com [Abrir o leitor] e [✕]. É faixa, não
 * janela: não bloqueia a venda em andamento, não pausa câmera nenhuma e não depende de o iOS
 * conseguir abrir um Modal por cima de outro (a cobrança é `presentation: 'modal'`).
 *
 * Com o leitor já ligado neste celular, a faixa só avisa ("Outro computador está chamando" +
 * [Ver]): trocar fica na tela do leitor, onde se vê para quem as leituras vão agora. Lá
 * (Mais → Leitor do computador) a faixa some — a própria tela mostra os chamados, em cartões.
 *
 * Os rótulos moram aqui (a ficha da Apple os cita, e o publicador confere neste arquivo); as
 * regras do que mostrar, em `lib/chamadoDoLeitor.ts`, com teste.
 */

import { usePathname, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { ChamadoAberto } from '@/api/tipos';
import { Botao, Cartao } from '@/components/ui';
import { useChamadosDoLeitor, type AtenderChamado } from '@/hooks/useChamadosDoLeitor';
import { respiroDeCima } from '@/lib/areaSegura';
import {
  haQuantoTempo,
  naTelaDoLeitor,
  oQueAFaixaMostra,
  ROTA_DO_LEITOR,
  type OQueAFaixaMostra,
} from '@/lib/chamadoDoLeitor';
import { sinalValido } from '@/lib/notificacoes';
import { cores, espaco, fonte, raio } from '@/lib/tema';
import { useAuthStore } from '@/stores/authStore';
import { useLeitorStore } from '@/stores/leitorStore';

export const ROTULOS_DO_CHAMADO = {
  chamando: 'O computador está chamando',
  outro: 'Outro computador está chamando',
  varios: (n: number) => `${n} computadores estão chamando`,
  abrir: 'Abrir o leitor',
  ver: 'Ver',
  agoraNao: 'Agora não',
  trocar: 'Trocar',
  sinal: (sinal: string) => `Sinal ${sinal}`,
} as const;

/** O que a faixa desenha agora; sem ela (`null`), a navegação ganha a barra de status. */
export interface Faixa {
  conteudo: OQueAFaixaMostra;
  /**
   * [Abrir o leitor]: vai para a tela do leitor com o "sim" a este chamado. É lá — numa tela
   * sem câmera — que o sistema pergunta a notificação (1ª vez) e o chamado é atendido: a
   * faixa aparece por cima da câmera do Vender, e o alerta do iOS não para câmera nenhuma.
   */
  abrir: () => void;
  /** [Ver]: a tela do leitor, que lista os sinais e tem o Trocar. */
  ver: () => void;
  /** [✕]: esconde os chamados que estão na faixa; um novo aparece de novo. */
  dispensar: () => void;
}

/**
 * Chamado em `ComFaixasNoTopo`, e não dentro da faixa: o bloco do topo precisa saber se ela
 * existe antes de desenhar, para dar (ou não) a barra de status à navegação.
 */
export function useFaixaDoChamado(): Faixa | null {
  const caminho = usePathname();
  const router = useRouter();
  const logado = useAuthStore((e) => !!e.usuario);
  const leitorLigado = useLeitorStore((e) => !!e.pareamento);
  const dispensados = useLeitorStore((e) => e.chamadosDispensados);
  // Com o relógio: o chamado que venceu (sem aviso nenhum do servidor) sai da faixa na hora.
  const { chamados, agora, buscadoEm } = useChamadosDoLeitor();

  if (!logado) return null;
  const conteudo = oQueAFaixaMostra({
    chamados,
    dispensados,
    leitorLigado,
    naTelaDoLeitor: naTelaDoLeitor(caminho),
    agora,
    buscadoEm,
  });
  if (!conteudo) return null;
  const irParaOLeitor = () => router.navigate(ROTA_DO_LEITOR as never);
  return {
    conteudo,
    abrir: () => {
      if (conteudo.tipo !== 'um') return;
      const { id, sinal } = conteudo.chamado;
      useLeitorStore.getState().pedirAtendimento(sinal, { id, pedirPermissao: true });
      irParaOLeitor();
    },
    ver: irParaOLeitor,
    dispensar: () => useLeitorStore.getState().dispensarChamados(conteudo.ids),
  };
}

function tituloDa(conteudo: OQueAFaixaMostra): string {
  if (conteudo.tipo === 'um') return ROTULOS_DO_CHAMADO.chamando;
  if (conteudo.tipo === 'leitor-ligado') return ROTULOS_DO_CHAMADO.outro;
  return ROTULOS_DO_CHAMADO.varios(conteudo.quantidade);
}

/**
 * A faixa. `areaDeCima`: a barra de status, quando ela é a primeira faixa do topo (a cor lê
 * com a hora clara e com a escura — `lib/chamadoDoLeitor.test.ts`). Sem altura fixa: com o
 * Texto Maior do iOS a frase quebra e a faixa cresce.
 */
export function FaixaDoChamado({ faixa, areaDeCima }: { faixa: Faixa; areaDeCima: number }) {
  const { conteudo } = faixa;
  return (
    <View style={[s.faixa, { paddingTop: respiroDeCima(areaDeCima, espaco.xs) }]}>
      <View style={s.linha}>
        <View style={s.textos}>
          <Text style={s.titulo}>{tituloDa(conteudo)}</Text>
          {conteudo.tipo === 'um' && (
            <Text style={s.sinal}>{ROTULOS_DO_CHAMADO.sinal(conteudo.chamado.sinal)}</Text>
          )}
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={conteudo.tipo === 'um' ? faixa.abrir : faixa.ver}
          style={({ pressed }) => [s.botao, pressed && { opacity: 0.85 }]}
        >
          <Text style={s.botaoTexto}>
            {conteudo.tipo === 'um' ? ROTULOS_DO_CHAMADO.abrir : ROTULOS_DO_CHAMADO.ver}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={ROTULOS_DO_CHAMADO.agoraNao}
          onPress={faixa.dispensar}
          hitSlop={espaco.sm}
          style={({ pressed }) => [s.fechar, pressed && { opacity: 0.7 }]}
        >
          <Text style={s.fecharTexto}>✕</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** "há 20 s" anda sozinho enquanto há cartão na tela. */
function useAgora(intervaloMs: number, ligado: boolean): number {
  const [agora, setAgora] = useState(() => Date.now());
  useEffect(() => {
    if (!ligado) return undefined;
    setAgora(Date.now());
    const relogio = setInterval(() => setAgora(Date.now()), intervaloMs);
    return () => clearInterval(relogio);
  }, [intervaloMs, ligado]);
  return agora;
}

/**
 * Na tela do leitor sem leitor ligado: um cartão por chamado aberto, cada um com o seu sinal
 * (o mesmo login em dois caixas chama duas vezes; a pessoa escolhe o da tela dela). `chamados`
 * são os que ainda valem (`useChamadosDoLeitor().vivos`): o vencido não fica pedindo toque.
 */
export function CartoesDoChamado({
  chamados,
  atendimento,
}: {
  chamados: readonly ChamadoAberto[];
  atendimento: AtenderChamado;
}) {
  const visiveis = chamados.filter((c) => sinalValido(c.sinal));
  const agora = useAgora(5000, visiveis.length > 0);
  return (
    <>
      {visiveis.map((chamado) => (
        <Cartao key={chamado.id} estilo={s.cartao}>
          <Text style={s.cartaoTitulo}>{ROTULOS_DO_CHAMADO.chamando}</Text>
          <View style={s.cartaoLinha}>
            <Text style={s.cartaoSinal}>{ROTULOS_DO_CHAMADO.sinal(chamado.sinal)}</Text>
            <Text style={s.cartaoHora}>{haQuantoTempo(chamado.criado_em, agora)}</Text>
          </View>
          <Text style={s.cartaoDica}>Confira se o computador mostra o mesmo sinal.</Text>
          <Botao
            titulo={ROTULOS_DO_CHAMADO.abrir}
            grande
            carregando={atendimento.atendendoId === chamado.id}
            desabilitado={atendimento.atendendo && atendimento.atendendoId !== chamado.id}
            onPress={() => atendimento.atender(chamado.id, { pedirPermissao: true })}
          />
        </Cartao>
      ))}
    </>
  );
}

const s = StyleSheet.create({
  faixa: {
    backgroundColor: cores.chamadoDoLeitor,
    paddingHorizontal: espaco.lg,
    paddingBottom: espaco.sm,
  },
  linha: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: espaco.sm },
  textos: { flex: 1, minWidth: 140 },
  titulo: { color: cores.aoFundoEscuro, fontSize: fonte.base, fontWeight: '700' },
  sinal: { color: cores.aoFundoEscuro, fontSize: fonte.base, fontWeight: '800', letterSpacing: 1 },
  botao: {
    backgroundColor: cores.superficie,
    borderRadius: raio.sm,
    paddingHorizontal: espaco.md,
    minHeight: 44,
    justifyContent: 'center',
  },
  botaoTexto: { color: cores.chamadoDoLeitor, fontSize: fonte.base, fontWeight: '700' },
  fechar: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  fecharTexto: { color: cores.aoFundoEscuro, fontSize: fonte.media, fontWeight: '700' },
  cartao: { gap: espaco.sm, borderColor: cores.chamadoDoLeitor, borderWidth: 2 },
  cartaoTitulo: { fontSize: fonte.media, fontWeight: '700', color: cores.texto },
  cartaoLinha: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: espaco.md },
  cartaoSinal: { fontSize: fonte.titulo, fontWeight: '800', letterSpacing: 2, color: cores.chamadoDoLeitor },
  cartaoHora: { fontSize: fonte.pequena, color: cores.textoSuave },
  cartaoDica: { fontSize: fonte.pequena, color: cores.textoSuave },
});
