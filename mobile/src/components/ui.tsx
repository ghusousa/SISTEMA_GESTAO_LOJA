/**
 * Peças de interface compartilhadas. Nada de biblioteca de componentes: o app tem poucas
 * formas e o controle do tamanho de toque importa mais que variedade visual.
 */

import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  type StyleProp,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  type TextStyle,
  View,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { respiroDeBaixo, respiroDeCima } from '@/lib/areaSegura';
import { ALVO_TOQUE, cores, espaco, fonte, raio, sombra } from '@/lib/tema';

// ------------------------------------------------------------------ Área segura
/**
 * Respiro de baixo para o que encosta na base da tela: rodapé de botões, botão flutuante,
 * o pé de um Modal de tela cheia. No iPhone de Face ID vira a área do indicador de início;
 * no SE, o respiro de sempre. A conta (e o teste) mora em `lib/areaSegura.ts`.
 */
export function useRespiroDeBaixo(minimo: number = espaco.lg): number {
  return respiroDeBaixo(useSafeAreaInsets().bottom, minimo);
}

/**
 * Respiro de cima para o que começa no topo da tela SEM cabeçalho: o Modal de tela cheia
 * desenha a partir do zero, debaixo da barra de status e da ilha.
 */
export function useRespiroDeCima(folga: number = espaco.md): number {
  return respiroDeCima(useSafeAreaInsets().top, folga);
}

// ------------------------------------------------------------------ Botão
type Variante = 'primario' | 'acao' | 'secundario' | 'perigo' | 'texto';

interface BotaoProps {
  titulo: string;
  onPress: () => void;
  variante?: Variante;
  desabilitado?: boolean;
  carregando?: boolean;
  grande?: boolean;
  estilo?: StyleProp<ViewStyle>;
}

const FUNDOS: Record<Variante, string> = {
  primario: cores.primaria,
  acao: cores.acao,
  secundario: cores.superficie,
  perigo: cores.perigo,
  texto: 'transparent',
};

const TEXTOS: Record<Variante, string> = {
  primario: cores.aoFundoEscuro,
  acao: cores.aoFundoEscuro,
  secundario: cores.primaria,
  perigo: cores.aoFundoEscuro,
  texto: cores.primaria,
};

export function Botao({
  titulo,
  onPress,
  variante = 'primario',
  desabilitado = false,
  carregando = false,
  grande = false,
  estilo,
}: BotaoProps) {
  const inativo = desabilitado || carregando;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: inativo, busy: carregando }}
      onPress={onPress}
      disabled={inativo}
      style={({ pressed }) => [
        s.botao,
        {
          backgroundColor: FUNDOS[variante],
          minHeight: grande ? 56 : ALVO_TOQUE,
          opacity: inativo ? 0.5 : pressed ? 0.85 : 1,
          borderWidth: variante === 'secundario' ? 1 : 0,
          borderColor: cores.bordaForte,
        },
        estilo,
      ]}
    >
      {carregando ? (
        <ActivityIndicator color={TEXTOS[variante]} />
      ) : (
        <Text
          style={[
            s.botaoTexto,
            { color: TEXTOS[variante], fontSize: grande ? fonte.media : fonte.base },
          ]}
        >
          {titulo}
        </Text>
      )}
    </Pressable>
  );
}

// ------------------------------------------------------------------ Campo
interface CampoProps extends TextInputProps {
  rotulo: string;
  erro?: string;
  ajuda?: string;
}

export function Campo({ rotulo, erro, ajuda, style, ...props }: CampoProps) {
  return (
    <View style={s.campo}>
      <Text style={s.rotulo}>{rotulo}</Text>
      <TextInput
        placeholderTextColor={cores.textoFraco}
        style={[s.input, !!erro && { borderColor: cores.perigo }, style]}
        {...props}
      />
      {!!erro && <Text style={s.erro}>{erro}</Text>}
      {!erro && !!ajuda && <Text style={s.ajuda}>{ajuda}</Text>}
    </View>
  );
}

// ------------------------------------------------------------------ Cartão
export function Cartao({
  children,
  estilo,
  onPress,
}: {
  children: ReactNode;
  estilo?: StyleProp<ViewStyle>;
  onPress?: () => void;
}) {
  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [s.cartao, estilo, pressed && { opacity: 0.9 }]}
      >
        {children}
      </Pressable>
    );
  }
  return <View style={[s.cartao, estilo]}>{children}</View>;
}

// ------------------------------------------------------------------ Estados
export function Carregando({ texto = 'Carregando…' }: { texto?: string }) {
  return (
    <View style={s.centro}>
      <ActivityIndicator size="large" color={cores.primaria} />
      <Text style={s.textoSuave}>{texto}</Text>
    </View>
  );
}

export function Vazio({
  titulo,
  descricao,
  acao,
}: {
  titulo: string;
  descricao?: string;
  acao?: ReactNode;
}) {
  return (
    <View style={s.centro}>
      <Text style={s.vazioTitulo}>{titulo}</Text>
      {!!descricao && <Text style={s.textoSuave}>{descricao}</Text>}
      {acao}
    </View>
  );
}

export function ErroEstado({
  mensagem,
  aoTentarNovamente,
}: {
  mensagem: string;
  aoTentarNovamente?: () => void;
}) {
  return (
    <View style={s.centro}>
      <Text style={s.erroTitulo}>{mensagem}</Text>
      {aoTentarNovamente && (
        <Botao titulo="Tentar de novo" variante="secundario" onPress={aoTentarNovamente} />
      )}
    </View>
  );
}

// ------------------------------------------------------------------ Etiqueta
export function Etiqueta({
  texto,
  cor = cores.primariaFraca,
  corTexto = cores.primaria,
  estilo,
}: {
  texto: string;
  cor?: string;
  corTexto?: string;
  estilo?: StyleProp<TextStyle>;
}) {
  return (
    <Text style={[s.etiqueta, { backgroundColor: cor, color: corTexto }, estilo]}>{texto}</Text>
  );
}

export function Linha({
  esquerda,
  direita,
  destaque = false,
}: {
  esquerda: string;
  direita: string;
  destaque?: boolean;
}) {
  return (
    <View style={s.linha}>
      <Text style={[s.linhaEsquerda, destaque && s.linhaDestaque]}>{esquerda}</Text>
      <Text style={[s.linhaDireita, destaque && s.linhaDestaque]}>{direita}</Text>
    </View>
  );
}

export function Separador() {
  return <View style={s.separador} />;
}

const s = StyleSheet.create({
  botao: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: raio.md,
    paddingHorizontal: espaco.lg,
  },
  botaoTexto: { fontWeight: '700' },

  campo: { marginBottom: espaco.lg },
  rotulo: {
    fontSize: fonte.pequena,
    fontWeight: '600',
    color: cores.textoSuave,
    marginBottom: espaco.xs,
  },
  input: {
    minHeight: ALVO_TOQUE,
    borderWidth: 1,
    borderColor: cores.borda,
    borderRadius: raio.md,
    paddingHorizontal: espaco.md,
    fontSize: fonte.media,
    color: cores.texto,
    backgroundColor: cores.superficie,
  },
  erro: { color: cores.perigo, fontSize: fonte.pequena, marginTop: espaco.xs },
  ajuda: { color: cores.textoFraco, fontSize: fonte.pequena, marginTop: espaco.xs },

  cartao: {
    backgroundColor: cores.superficie,
    borderRadius: raio.md,
    padding: espaco.lg,
    marginBottom: espaco.md,
    ...sombra,
  },

  centro: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: espaco.xl,
    gap: espaco.md,
  },
  textoSuave: { color: cores.textoSuave, fontSize: fonte.base, textAlign: 'center' },
  vazioTitulo: { fontSize: fonte.media, fontWeight: '700', color: cores.texto },
  erroTitulo: {
    fontSize: fonte.base,
    fontWeight: '600',
    color: cores.perigo,
    textAlign: 'center',
  },

  etiqueta: {
    fontSize: fonte.micro,
    fontWeight: '700',
    paddingHorizontal: espaco.sm,
    paddingVertical: 3,
    borderRadius: raio.redondo,
    overflow: 'hidden',
  },

  linha: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: espaco.sm,
  },
  linhaEsquerda: { fontSize: fonte.base, color: cores.textoSuave },
  linhaDireita: { fontSize: fonte.base, color: cores.texto, fontWeight: '600' },
  linhaDestaque: { fontSize: fonte.grande, fontWeight: '800', color: cores.texto },

  separador: { height: 1, backgroundColor: cores.borda, marginVertical: espaco.sm },
});
