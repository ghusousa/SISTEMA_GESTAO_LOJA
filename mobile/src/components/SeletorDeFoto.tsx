/**
 * A foto da peça: um quadrado que se toca para fotografar ou escolher da galeria.
 *
 * Serve tanto no cadastro (onde a peça ainda não existe e a foto espera o id) quanto no
 * detalhe (onde já existe e a foto vai direto). Quem decide o que fazer com o arquivo é a
 * tela; aqui só se escolhe e se mostra.
 */

import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useState } from 'react';
import { ActivityIndicator, Alert, Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { PermissaoNegada, escolherFoto, type FotoEscolhida } from '@/lib/foto';
import { cores, espaco, fonte, raio } from '@/lib/tema';

interface Props {
  /** O que mostrar agora: a foto recém-escolhida, ou a que já está no servidor. */
  uri?: string | null;
  /** Chamado com a foto já reduzida. Devolver uma promessa deixa o quadrado em espera. */
  aoEscolher: (foto: FotoEscolhida) => void | Promise<void>;
  /** Enquanto o upload da tela roda. */
  enviando?: boolean;
  rotulo?: string;
}

export function SeletorDeFoto({ uri, aoEscolher, enviando = false, rotulo = 'Foto da peça' }: Props) {
  const [ocupado, setOcupado] = useState(false);
  const trabalhando = ocupado || enviando;

  async function pegar(origem: 'camera' | 'galeria') {
    setOcupado(true);
    try {
      const foto = await escolherFoto(origem);
      if (foto) await aoEscolher(foto);
    } catch (erro) {
      // Desistir de tirar a foto não é erro; negar a permissão é, e a mensagem já vem
      // pronta dizendo onde autorizar.
      if (erro instanceof PermissaoNegada) Alert.alert('Permissão necessária', erro.message);
      else Alert.alert('Não deu para usar a foto', (erro as Error)?.message ?? 'Tente de novo.');
    } finally {
      setOcupado(false);
    }
  }

  function perguntar() {
    if (trabalhando) return;
    Alert.alert(rotulo, 'De onde vem a imagem?', [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Tirar foto', onPress: () => void pegar('camera') },
      { text: 'Escolher da galeria', onPress: () => void pegar('galeria') },
    ]);
  }

  return (
    <View style={s.bloco}>
      <Text style={s.rotulo}>{rotulo}</Text>
      <Pressable
        onPress={perguntar}
        style={s.quadro}
        accessibilityRole="button"
        accessibilityLabel={uri ? 'Trocar a foto da peça' : 'Adicionar foto da peça'}
      >
        {uri ? (
          <Image source={{ uri }} style={s.imagem} resizeMode="cover" />
        ) : (
          <View style={s.vazio}>
            <MaterialCommunityIcons name="camera-plus-outline" size={30} color={cores.textoFraco} />
            <Text style={s.vazioTexto}>Tirar foto ou escolher</Text>
          </View>
        )}

        {trabalhando && (
          <View style={s.espera}>
            <ActivityIndicator color="#FFF" />
          </View>
        )}

        {!!uri && !trabalhando && (
          <View style={s.trocar}>
            <MaterialCommunityIcons name="camera-outline" size={14} color="#FFF" />
            <Text style={s.trocarTexto}>Trocar</Text>
          </View>
        )}
      </Pressable>
      <Text style={s.ajuda}>
        Opcional. Ajuda a achar a peça na lista quando a etiqueta não está à mão.
      </Text>
    </View>
  );
}

const LADO = 132;

const s = StyleSheet.create({
  bloco: { marginBottom: espaco.lg },
  rotulo: {
    fontSize: fonte.pequena,
    fontWeight: '700',
    color: cores.texto,
    marginBottom: espaco.xs,
  },
  quadro: {
    width: LADO,
    height: LADO,
    borderRadius: raio.md,
    overflow: 'hidden',
    backgroundColor: cores.superficieAlt,
    borderWidth: 1,
    borderColor: cores.borda,
    borderStyle: 'dashed',
  },
  imagem: { width: '100%', height: '100%' },
  vazio: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: espaco.xs },
  vazioTexto: {
    fontSize: fonte.pequena,
    color: cores.textoFraco,
    textAlign: 'center',
    paddingHorizontal: espaco.sm,
  },
  espera: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  trocar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 5,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  trocarTexto: { color: '#FFF', fontSize: fonte.pequena, fontWeight: '700' },
  ajuda: {
    fontSize: fonte.pequena,
    color: cores.textoFraco,
    marginTop: espaco.xs,
    maxWidth: 240,
  },
});
