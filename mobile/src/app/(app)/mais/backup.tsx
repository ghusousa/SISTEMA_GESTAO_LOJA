/**
 * Backup na nuvem, no celular do dono: o mesmo da tela do web (`web/js/views/backup.js`).
 *
 * O que importa aqui é a SITUAÇÃO — o dono quer saber, de longe, se a cópia está saindo.
 * "Atrasado" vem do servidor (`atrasado`): ligado e sem cópia nova há mais de 2× o
 * intervalo. O selo antigo do web olhava só se a última deu certo, e dizia "Funcionando"
 * com a cópia parada havia dias.
 *
 * Configurar também funciona, mas trocar a conta do Google ou a pasta de um backup já
 * conectado pede a senha de novo (ADR-28): é o caminho de quem acha a sessão do dono
 * aberta e desvia as cópias para o próprio Drive. O token entra e nunca volta.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';

import { detalheDoErro, mensagemDoErro } from '@/api/client';
import { backup } from '@/api/endpoints';
import { Botao, Campo, Carregando, Cartao, ErroEstado, Etiqueta } from '@/components/ui';
import { CHAVE_BACKUP, situacaoDoBackup, trocaPedeSenha, type TomDoBackup } from '@/lib/backup';
import { cores, espaco, fonte } from '@/lib/tema';

const COR_DO_TOM: Record<TomDoBackup, { fundo: string; texto: string }> = {
  ok: { fundo: cores.sucessoFraco, texto: cores.acaoEscura },
  info: { fundo: cores.superficieAlt, texto: cores.textoSuave },
  alerta: { fundo: cores.alertaFraco, texto: cores.texto },
  perigo: { fundo: cores.perigoFraco, texto: cores.perigo },
};

/** Bytes -> "4,2 MB": o dono quer saber se a cópia tem tamanho de banco ou de arquivo vazio. */
function tamanho(bytes: number | null): string {
  if (!bytes) return '—';
  const mb = bytes / 1024 / 1024;
  if (mb < 1) return `${Math.round(bytes / 1024)} KB`;
  return `${mb.toFixed(1).replace('.', ',')} MB`;
}

export default function BackupNaNuvem() {
  const cliente = useQueryClient();
  const consulta = useQuery({ queryKey: CHAVE_BACKUP, queryFn: backup.obter });
  const b = consulta.data;

  const [ativo, setAtivo] = useState(false);
  const [pasta, setPasta] = useState('');
  const [intervalo, setIntervalo] = useState('');
  const [manter, setManter] = useState('');
  const [token, setToken] = useState('');
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [erroSenha, setErroSenha] = useState<string | null>(null);

  // A primeira renderização vem antes da resposta; quando ela chega, o formulário adota
  // o que está gravado.
  useEffect(() => {
    if (!b) return;
    setAtivo(b.ativo);
    setPasta(b.pasta);
    setIntervalo(String(b.intervalo_min));
    setManter(String(b.manter));
  }, [b]);

  const pedeSenha = !!b && trocaPedeSenha(b, { token, pasta });

  const salvar = useMutation({
    mutationFn: () =>
      backup.salvar({
        ativo,
        pasta: pasta.trim(),
        intervalo_min: Number(intervalo),
        manter: Number(manter),
        // Só manda o token quando há um novo: vazio apagaria a conta conectada.
        ...(token.trim() ? { rclone_token: token.trim() } : {}),
        ...(pedeSenha ? { senha_atual: senha } : {}),
      }),
    onSuccess: (salvo) => {
      cliente.setQueryData(CHAVE_BACKUP, salvo);
      setToken('');
      setSenha('');
      setErro(null);
      setErroSenha(null);
      Alert.alert('Pronto', salvo.ativo ? 'Backup ligado.' : 'Configuração salva.');
    },
    onError: (e) => {
      const msg = mensagemDoErro(e, 'Não deu para salvar.');
      if (detalheDoErro(e)?.campo === 'senha_atual') {
        setSenha('');
        setErroSenha(msg);
      } else {
        setErro(msg);
      }
    },
  });

  if (consulta.isPending) return <Carregando />;
  if (consulta.isError || !b) {
    return (
      <ErroEstado
        mensagem={mensagemDoErro(consulta.error, 'Não deu para ler o backup.')}
        aoTentarNovamente={() => void consulta.refetch()}
      />
    );
  }

  const situacao = situacaoDoBackup(b);
  const cor = COR_DO_TOM[situacao.tom];

  return (
    <KeyboardAvoidingView
      style={s.tela}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Stack.Screen options={{ title: 'Backup na nuvem' }} />
      <ScrollView contentContainerStyle={s.conteudo} keyboardShouldPersistTaps="handled">
        <Cartao>
          <Etiqueta texto={situacao.texto} cor={cor.fundo} corTexto={cor.texto} />
          <Linha rotulo="Última cópia" valor={b.ultimo_em ? new Date(b.ultimo_em).toLocaleString('pt-BR') : 'nenhuma ainda'} />
          <Linha rotulo="Tamanho" valor={tamanho(b.ultimo_bytes)} />
          <Linha rotulo="Cópias no Drive" valor={`${b.copias_na_nuvem ?? 0} de ${b.manter}`} />
          {b.ultimo_erro ? <Text style={s.erro}>O que deu errado: {b.ultimo_erro}</Text> : null}
          {b.atrasado ? (
            <Text style={s.ajuda}>
              A cópia deveria sair a cada {b.intervalo_min} min e passou da hora. Confira se o
              servidor da loja está ligado; o ./diagnostico.sh mostra o resto.
            </Text>
          ) : null}
        </Cartao>

        <View style={s.linhaSwitch}>
          <Text style={s.rotulo}>Backup ligado</Text>
          <Switch value={ativo} onValueChange={setAtivo} />
        </View>
        <Campo rotulo="Pasta no Drive" value={pasta} onChangeText={setPasta} autoCapitalize="none" />
        <Campo
          rotulo="De quantos em quantos minutos"
          value={intervalo}
          onChangeText={setIntervalo}
          keyboardType="number-pad"
          ajuda="30 é o recomendado"
        />
        <Campo rotulo="Quantas cópias guardar" value={manter} onChangeText={setManter} keyboardType="number-pad" />
        <Campo
          rotulo={b.configurado ? 'Token do rclone (só para trocar de conta)' : 'Token do rclone'}
          value={token}
          onChangeText={setToken}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          ajuda='Cole o texto que o comando rclone authorize "drive" imprimiu no seu computador'
        />
        {pedeSenha ? (
          <Campo
            rotulo="Sua senha"
            value={senha}
            onChangeText={setSenha}
            secureTextEntry
            autoCapitalize="none"
            erro={erroSenha ?? undefined}
            ajuda="Trocar a conta ou a pasta pede a senha de novo"
          />
        ) : null}

        {erro ? <Text style={s.erro}>{erro}</Text> : null}
        <Botao
          titulo="Salvar"
          carregando={salvar.isPending}
          desabilitado={pedeSenha && !senha}
          onPress={() => {
            setErro(null);
            setErroSenha(null);
            salvar.mutate();
          }}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Linha({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <View style={s.linha}>
      <Text style={s.linhaRotulo}>{rotulo}</Text>
      <Text style={s.linhaValor}>{valor}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  tela: { flex: 1, backgroundColor: cores.fundo },
  conteudo: { padding: espaco.lg, paddingBottom: espaco.xxl, gap: espaco.md },
  rotulo: { fontSize: fonte.base, fontWeight: '700', color: cores.texto },
  ajuda: { fontSize: fonte.pequena, color: cores.textoSuave, marginTop: espaco.sm },
  erro: { color: cores.perigo, fontSize: fonte.pequena, marginTop: espaco.sm },
  linhaSwitch: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  linha: { flexDirection: 'row', justifyContent: 'space-between', marginTop: espaco.sm },
  linhaRotulo: { fontSize: fonte.base, color: cores.textoSuave },
  linhaValor: { fontSize: fonte.base, fontWeight: '600', color: cores.texto },
});
