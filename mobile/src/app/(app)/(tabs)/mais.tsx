import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { baseAtual } from '@/api/client';
import { sistema } from '@/api/endpoints';
import { Cartao, Etiqueta } from '@/components/ui';
import { PODE, pode, titulo, type Capacidade } from '@/lib/permissoes';
import { cores, espaco, fonte, raio } from '@/lib/tema';
import { useAuthStore } from '@/stores/authStore';
import { useServidorStore } from '@/stores/servidorStore';
import { useLoja } from '@/hooks/useLoja';
import { ROTULOS, type Segmento } from '@/lib/segmento';

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
    rotulo: 'Devolução',
    descricao: 'A cliente voltou com a peça',
    icone: 'keyboard-return',
    rota: '/venda/devolucao',
    pode: PODE.DEVOLVER_VENDA,
  },
  {
    rotulo: 'Crediário',
    descricao: 'Quem levou fiado e quanto deve',
    icone: 'handshake-outline',
    rota: '/clientes',
    pode: PODE.GERIR_CREDIARIO,
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
    rotulo: 'Auditoria',
    descricao: 'Tudo que cada um fez no login',
    icone: 'shield-search',
    rota: '/mais/auditoria',
    pode: PODE.VER_AUDITORIA,
  },
  {
    rotulo: 'A loja',
    descricao: 'Nome, ramo e o que sai no recibo',
    icone: 'storefront-outline',
    rota: '/mais/loja',
    pode: PODE.CONFIGURAR_LOJA,
  },
  {
    rotulo: 'Trocar minha senha',
    descricao: 'Segurança da sua conta',
    icone: 'lock-outline',
    rota: '/mais/senha',
  },
];

/**
 * "Estou na versão mais nova?" — a pergunta de quem cuida da loja, respondida sem sair
 * daqui.
 *
 * Mostrar só o hash não resolveria: `5c31d04` não é maior nem menor que o de ontem. Quem
 * sabe é o servidor, que guarda quando foi a última conferida com o GitHub e se ela achou
 * coisa nova — a frase vem pronta de lá, a mesma que o web mostra.
 */
function SeloDeVersao() {
  const versao = useQuery({
    queryKey: ['versao'],
    queryFn: sistema.versao,
    // Versão não muda de minuto em minuto, e uma consulta a cada abertura da aba seria
    // gasto de bateria e de rede da loja por nada.
    staleTime: 5 * 60_000,
    retry: false,
  });

  if (!versao.data) return null;
  const emDia = versao.data.atualizada === true && versao.data.conferido_recente;

  return (
    <View style={s.versao}>
      <View style={[s.versaoPonto, { backgroundColor: emDia ? cores.acao : cores.alerta }]} />
      <View style={{ flex: 1 }}>
        <Text style={[s.versaoTitulo, !emDia && { color: cores.alerta }]}>
          {emDia ? 'Versão em dia' : 'Versão desatualizada'}
        </Text>
        <Text style={s.versaoDetalhe}>
          {versao.data.commit ?? 'sem versão'} · {versao.data.resumo}
        </Text>
      </View>
    </View>
  );
}

export default function Mais() {
  const router = useRouter();
  const usuario = useAuthStore((e) => e.usuario);
  const loja = useLoja();
  const sair = useAuthStore((e) => e.sair);
  const ehDono = usuario?.papel === 'ADMIN';

  return (
    <ScrollView contentContainerStyle={s.conteudo}>
      <Cartao>
        {/* De que loja é este aparelho. Vem do servidor, não do build: um `.apk` serve
            todas as lojas (ADR-13), então quem se apresenta é a instalação. */}
        <View style={s.loja}>
          <Text style={s.lojaIcone}>{loja.vocabulario.icone}</Text>
          <View style={{ flex: 1 }}>
            <Text style={s.lojaNome} numberOfLines={2}>
              {loja.nome}
            </Text>
            <Text style={s.lojaRamo}>
              {ROTULOS[loja.segmento as Segmento] ?? 'Loja'}
            </Text>
          </View>
        </View>

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

        <SeloDeVersao />
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

      {/* As duas lojas de app exigem que a política de privacidade seja alcançável de
          dentro do aplicativo. Abre no navegador do aparelho, no servidor da própria loja. */}
      <Pressable
        style={s.opcao}
        onPress={() => {
          const base = baseAtual().replace(/\/api\/v1\/?$/, '');
          void Linking.openURL(`${base}/privacidade`);
        }}
      >
        <MaterialCommunityIcons name="shield-lock-outline" size={24} color={cores.primaria} />
        <View style={s.opcaoTexto}>
          <Text style={s.opcaoRotulo}>Privacidade</Text>
          <Text style={s.opcaoDescricao}>Como seus dados são tratados</Text>
        </View>
        <MaterialCommunityIcons name="open-in-new" size={18} color={cores.textoFraco} />
      </Pressable>

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
              'Trocar desconecta você e abre a tela do endereço. Use se a loja mudou de ' +
              'servidor ou se o endereço está errado.',
            [
              { text: 'Ficar como está', style: 'cancel' },
              {
                text: 'Trocar',
                style: 'destructive',
                onPress: () => {
                  // Sai primeiro: é o servidor ANTIGO quem ainda reconhece esta sessão e
                  // pode revogá-la. O endereço fica gravado até a pessoa confirmar outro,
                  // para ela editar o que está lá em vez de digitar tudo de novo.
                  void sair().then(() => router.push('/servidor'));
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
  versao: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: espaco.sm,
    marginTop: espaco.lg,
    paddingTop: espaco.md,
    borderTopWidth: 1,
    borderTopColor: cores.borda,
  },
  versaoPonto: { width: 9, height: 9, borderRadius: 5, marginTop: 5 },
  versaoTitulo: { fontSize: fonte.base, fontWeight: '700', color: cores.texto },
  versaoDetalhe: { fontSize: fonte.pequena, color: cores.textoSuave, marginTop: 2, lineHeight: 18 },

  conteudo: { padding: espaco.lg, paddingBottom: espaco.xxl },

  servidor: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: espaco.xs,
    marginTop: espaco.xl,
    padding: espaco.sm,
  },

  loja: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: espaco.md,
    paddingBottom: espaco.md,
    marginBottom: espaco.md,
    borderBottomWidth: 1,
    borderBottomColor: cores.borda,
  },
  lojaIcone: { fontSize: 30 },
  lojaNome: { fontSize: fonte.media, fontWeight: '800', color: cores.texto },
  lojaRamo: { fontSize: fonte.pequena, color: cores.textoSuave, marginTop: 1 },

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
