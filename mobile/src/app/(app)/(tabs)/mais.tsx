import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { baseAtual } from '@/api/client';
import { Cartao, Etiqueta } from '@/components/ui';
import { PODE, pode, titulo, type Capacidade } from '@/lib/permissoes';
import { cores, espaco, fonte, raio } from '@/lib/tema';
import { useAuthStore } from '@/stores/authStore';
import { useServidorStore } from '@/stores/servidorStore';

interface Opcao {
  rotulo: string;
  descricao: string;
  icone: keyof typeof MaterialCommunityIcons.glyphMap;
  rota: string;
  /** Capacidade exigida; sem ela, a opção não aparece. */
  pode?: Capacidade;
}

const OPCOES: Opcao[] = [
  {
    rotulo: 'Vendas',
    descricao: 'Histórico e cancelamentos',
    icone: 'receipt-text-outline',
    rota: '/mais/vendas',
  },
  {
    rotulo: 'Categorias de produto',
    descricao: 'Organizar o catálogo',
    icone: 'shape-outline',
    rota: '/mais/categorias',
    pode: PODE.EDITAR_CATALOGO,
  },
  {
    rotulo: 'Usuários',
    descricao: 'Quem pode entrar no sistema',
    icone: 'account-group-outline',
    rota: '/mais/usuarios',
    pode: PODE.GERIR_USUARIOS,
  },
  {
    rotulo: 'Trocar minha senha',
    descricao: 'Segurança da sua conta',
    icone: 'lock-outline',
    rota: '/mais/senha',
  },
];

export default function Mais() {
  const router = useRouter();
  const usuario = useAuthStore((e) => e.usuario);
  const sair = useAuthStore((e) => e.sair);
  const esquecerServidor = useServidorStore((e) => e.esquecer);
  const ehDono = usuario?.papel === 'ADMIN';

  return (
    <ScrollView contentContainerStyle={s.conteudo}>
      <Cartao>
        <View style={s.perfil}>
          <View style={s.avatar}>
            <Text style={s.avatarTexto}>
              {(usuario?.nome ?? '?').slice(0, 1).toUpperCase()}
            </Text>
          </View>
          <View style={s.perfilInfo}>
            <Text style={s.nome}>{usuario?.nome}</Text>
            <Text style={s.email}>{usuario?.email}</Text>
            <Etiqueta
              texto={titulo(usuario?.papel).toLowerCase()}
              cor={ehDono ? cores.primariaFraca : cores.superficieAlt}
              corTexto={ehDono ? cores.primaria : cores.textoSuave}
              estilo={s.papel}
            />
          </View>
        </View>
      </Cartao>

      {OPCOES.filter((o) => !o.pode || pode(usuario?.papel, o.pode)).map((opcao) => (
        <Pressable
          key={opcao.rota}
          style={s.opcao}
          onPress={() => router.push(opcao.rota as never)}
        >
          <MaterialCommunityIcons name={opcao.icone} size={24} color={cores.primaria} />
          <View style={s.opcaoTexto}>
            <Text style={s.opcaoRotulo}>{opcao.rotulo}</Text>
            <Text style={s.opcaoDescricao}>{opcao.descricao}</Text>
          </View>
          <MaterialCommunityIcons name="chevron-right" size={22} color={cores.textoFraco} />
        </Pressable>
      ))}

      <Pressable
        style={[s.opcao, s.opcaoSair]}
        onPress={() =>
          Alert.alert('Sair do aplicativo?', 'Você precisará entrar de novo.', [
            { text: 'Ficar', style: 'cancel' },
            { text: 'Sair', style: 'destructive', onPress: () => void sair() },
          ])
        }
      >
        <MaterialCommunityIcons name="logout" size={24} color={cores.perigo} />
        <View style={s.opcaoTexto}>
          <Text style={[s.opcaoRotulo, { color: cores.perigo }]}>Sair</Text>
        </View>
      </Pressable>

      <Pressable
        style={s.servidor}
        onPress={() =>
          Alert.alert(
            'Trocar de servidor',
            `Este celular fala com ${baseAtual()}.\n\n` +
              'Trocar desconecta você e pede o endereço de novo. Use se a loja mudou de ' +
              'servidor ou se você configurou o endereço errado.',
            [
              { text: 'Ficar como está', style: 'cancel' },
              {
                text: 'Trocar',
                style: 'destructive',
                onPress: () => {
                  // A ordem importa: sair primeiro revoga a sessão no servidor ANTIGO,
                  // que é justamente quem ainda a reconhece.
                  void sair().then(() => esquecerServidor());
                },
              },
            ],
          )
        }
      >
        <MaterialCommunityIcons name="server-network" size={18} color={cores.textoFraco} />
        <Text style={s.rodape}>Conectado em {baseAtual()}</Text>
      </Pressable>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  conteudo: { padding: espaco.lg, paddingBottom: espaco.xxl },

  servidor: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: espaco.xs,
    marginTop: espaco.xl,
    padding: espaco.sm,
  },

  perfil: { flexDirection: 'row', gap: espaco.lg, alignItems: 'center' },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: raio.redondo,
    backgroundColor: cores.primaria,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarTexto: { color: cores.aoFundoEscuro, fontSize: fonte.titulo, fontWeight: '800' },
  perfilInfo: { flex: 1, gap: 2 },
  nome: { fontSize: fonte.media, fontWeight: '800', color: cores.texto },
  email: { fontSize: fonte.pequena, color: cores.textoSuave },
  papel: { alignSelf: 'flex-start', marginTop: espaco.xs },

  opcao: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: espaco.lg,
    backgroundColor: cores.superficie,
    borderRadius: raio.md,
    padding: espaco.lg,
    marginBottom: espaco.sm,
  },
  opcaoSair: { marginTop: espaco.lg },
  opcaoTexto: { flex: 1 },
  opcaoRotulo: { fontSize: fonte.base, fontWeight: '700', color: cores.texto },
  opcaoDescricao: { fontSize: fonte.pequena, color: cores.textoSuave, marginTop: 2 },

  rodape: {
    fontSize: fonte.micro,
    color: cores.textoFraco,
    textAlign: 'center',
    marginTop: espaco.lg,
  },
});
