import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { baseAtual } from '@/api/client';
import { backup, sistema } from '@/api/endpoints';
import { Cartao, Etiqueta } from '@/components/ui';
import { PODE, pode, titulo, type Capacidade } from '@/lib/permissoes';
import { cores, espaco, fonte, raio } from '@/lib/tema';
import { useAuthStore } from '@/stores/authStore';
import { useServidorStore } from '@/stores/servidorStore';
import { useLoja } from '@/hooks/useLoja';
import { ROTULOS, type Segmento } from '@/lib/segmento';
import { backupPrecisaDeAtencao, CHAVE_BACKUP } from '@/lib/backup';

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
    // Para qualquer papel (ADR-43): quem bipa no balcão é quem estiver no computador.
    rotulo: 'Leitor do computador',
    descricao: 'Bipe pelo celular e a peça cai na tela do computador',
    icone: 'barcode-scan',
    rota: '/mais/leitor',
  },
  {
    rotulo: 'Devolução',
    descricao: 'A cliente voltou com a peça',
    icone: 'keyboard-return',
    rota: '/venda/devolucao',
    pode: PODE.DEVOLVER_VENDA,
  },
  {
    rotulo: 'Condicional',
    descricao: 'Peças na casa da cliente, com prazo',
    icone: 'shopping-outline',
    rota: '/condicional',
    pode: PODE.FAZER_CONDICIONAL,
  },
  {
    rotulo: 'Crediário',
    descricao: 'Quem levou fiado e quanto deve',
    icone: 'handshake-outline',
    rota: '/clientes',
    pode: PODE.GERIR_CREDIARIO,
  },
  {
    rotulo: 'Aniversariantes',
    descricao: 'Quem faz aniversário no mês',
    icone: 'cake-variant-outline',
    rota: '/mais/aniversariantes',
    pode: PODE.ATENDER_CLIENTE,
  },
  {
    rotulo: 'Taxas do cartão',
    descricao: 'Quanto a maquininha cobra e quando paga',
    icone: 'credit-card-outline',
    rota: '/mais/taxas',
    pode: PODE.VER_DINHEIRO,
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
    rotulo: 'Backup na nuvem',
    descricao: 'A cópia do banco no seu Google Drive',
    icone: 'cloud-upload-outline',
    rota: '/mais/backup',
    pode: PODE.GERIR_BACKUP,
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

/**
 * "O backup parou?" — para o dono, logo abaixo do selo de versão e no mesmo desenho, mas
 * só quando há problema (atrasado ou falhou). Quem decide o atraso é o servidor. Sem isto,
 * a cópia parada só aparecia para quem abrisse a tela do backup: no dia de precisar dela.
 */
function SeloDoBackup() {
  const router = useRouter();
  const consulta = useQuery({
    queryKey: CHAVE_BACKUP,
    queryFn: backup.obter,
    staleTime: 5 * 60_000,
    retry: false,
  });
  if (!consulta.data || !backupPrecisaDeAtencao(consulta.data)) return null;
  const falhou = consulta.data.ultimo_ok === false;
  const quando = consulta.data.ultimo_em
    ? new Date(consulta.data.ultimo_em).toLocaleString('pt-BR')
    : 'nunca';
  return (
    <Pressable style={s.versao} onPress={() => router.push('/mais/backup' as never)}>
      <View style={[s.versaoPonto, { backgroundColor: falhou ? cores.perigo : cores.alerta }]} />
      <View style={{ flex: 1 }}>
        <Text style={[s.versaoTitulo, { color: falhou ? cores.perigo : cores.alerta }]}>
          {falhou ? 'Backup falhou' : 'Backup atrasado'}
        </Text>
        <Text style={s.versaoDetalhe}>Última cópia: {quando}</Text>
      </View>
    </Pressable>
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
          <Text style={s.lojaNome} numberOfLines={2}>
            {loja.nome}
          </Text>
          <Text style={s.lojaRamo}>{ROTULOS[loja.segmento as Segmento] ?? 'Loja'}</Text>
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
        {pode(usuario?.papel, PODE.GERIR_BACKUP) ? <SeloDoBackup /> : null}
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
    paddingBottom: espaco.md,
    marginBottom: espaco.md,
    borderBottomWidth: 1,
    borderBottomColor: cores.borda,
  },
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
