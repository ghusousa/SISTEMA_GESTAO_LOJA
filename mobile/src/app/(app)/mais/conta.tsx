/**
 * Minha conta: quem está usando, a troca da senha e a exclusão da própria conta.
 *
 * As lojas de app exigem que quem tem conta consiga excluí-la de dentro do app (Apple
 * 5.1.1(v), ADR-45). O caminho é Mais › Minha conta › Excluir minha conta: a tela diz o que
 * some e o que fica, pede a senha e confirma. A senha errada aparece no campo (é 422 — a
 * sessão segue); o único dono lê que precisa passar o papel antes; deu certo, a sessão fecha
 * aqui mesmo e a entrada diz "Conta excluída".
 */

import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { codigoDoErro, mensagemDoErro, sessaoContinua, statusDoErro } from '@/api/client';
import { usuarios } from '@/api/endpoints';
import { Confirmacao } from '@/components/Confirmacao';
import { Botao, Campo, Cartao, Etiqueta } from '@/components/ui';
import { depoisDaIncerta, recusaDaExclusao, textosDaExclusao } from '@/lib/exclusaoDeConta';
import { titulo } from '@/lib/permissoes';
import { cores, espaco, fonte, raio } from '@/lib/tema';
import { useAuthStore } from '@/stores/authStore';

const TEXTOS = textosDaExclusao({ propria: true });

export default function MinhaConta() {
  const router = useRouter();
  const usuario = useAuthStore((e) => e.usuario);
  const encerrarPorContaExcluida = useAuthStore((e) => e.encerrarPorContaExcluida);
  const ehDono = usuario?.papel === 'ADMIN';

  const [senha, setSenha] = useState('');
  const [erroSenha, setErroSenha] = useState<string | null>(null);
  const [recusa, setRecusa] = useState<string | null>(null);
  const [confirmando, setConfirmando] = useState(false);

  // A tentativa anterior ficou sem resposta (o servidor pode ter excluído e a resposta se
  // perdido): nesta, o 401 é lido sem o desvio de "sessão vencida" (ver `depoisDaIncerta`).
  const incerta = useRef(false);

  const excluir = useMutation({
    mutationFn: async () => {
      if (!incerta.current) return usuarios.excluirMinhaConta(senha);
      try {
        await usuarios.excluirMinhaConta(senha, { semRenovar: true });
      } catch (erro) {
        if (statusDoErro(erro) !== 401) throw erro;
        if (depoisDaIncerta(await sessaoContinua()) === 'pedir-de-novo') {
          await usuarios.excluirMinhaConta(senha);
        }
        // 'excluida': a tentativa sem resposta tinha excluído; o servidor não conhece mais esta
        // sessão, e a entrada diz "Conta excluída" em vez de "sessão expirada".
      }
    },
    onSuccess: () => {
      setConfirmando(false);
      // A navegação volta à entrada sozinha (usuario = null), com o recado.
      void encerrarPorContaExcluida();
    },
    onError: (erro) => {
      setConfirmando(false);
      const r = recusaDaExclusao({
        status: statusDoErro(erro),
        code: codigoDoErro(erro),
        message: mensagemDoErro(erro, ''),
      });
      incerta.current = !!r.incerta;
      if (r.onde === 'senha') {
        setErroSenha(r.texto);
        setSenha('');
      } else {
        setRecusa(r.texto);
      }
    },
  });

  function pedirConfirmacao() {
    setRecusa(null);
    if (!senha) {
      setErroSenha('Digite a sua senha para confirmar.');
      return;
    }
    setErroSenha(null);
    setConfirmando(true);
  }

  return (
    <KeyboardAvoidingView
      style={s.tela}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={s.conteudo} keyboardShouldPersistTaps="handled">
        <Cartao>
          <Text style={s.nome}>{usuario?.nome}</Text>
          <Text style={s.email}>{usuario?.email}</Text>
          <Etiqueta
            texto={titulo(usuario?.papel).toLowerCase()}
            cor={ehDono ? cores.primariaFraca : cores.superficieAlt}
            corTexto={ehDono ? cores.primaria : cores.textoSuave}
            estilo={s.papel}
          />
        </Cartao>

        <Pressable
          style={s.opcao}
          onPress={() => router.push('/mais/senha')}
          accessibilityRole="button"
        >
          <MaterialCommunityIcons name="lock-outline" size={24} color={cores.primaria} />
          <View style={s.opcaoTexto}>
            <Text style={s.opcaoRotulo}>Trocar senha</Text>
            <Text style={s.opcaoDescricao}>Derruba as sessões abertas nos outros aparelhos</Text>
          </View>
          <MaterialCommunityIcons name="chevron-right" size={22} color={cores.textoFraco} />
        </Pressable>

        <Text style={s.secao}>Excluir minha conta</Text>
        <Cartao>
          <Text style={s.texto}>
            Apaga o seu acesso a este sistema, em todos os aparelhos.
          </Text>

          <Text style={s.subtitulo}>O que some</Text>
          {TEXTOS.some.map((linha) => (
            <Text key={linha} style={s.item}>
              • {linha}
            </Text>
          ))}
          <Text style={s.subtitulo}>O que fica</Text>
          {TEXTOS.fica.map((linha) => (
            <Text key={linha} style={s.item}>
              • {linha}
            </Text>
          ))}
          <Text style={s.fim}>{TEXTOS.fim}</Text>

          {ehDono && (
            <Text style={s.dica}>
              A loja não fica sem dono: se você é o único, passe antes o papel de dono a outra
              pessoa em Mais › Usuários › (a pessoa) › Mudar papel.
            </Text>
          )}

          {!!recusa && (
            <Text style={s.recusa} accessibilityRole="alert">
              {recusa}
            </Text>
          )}

          <Campo
            rotulo="Sua senha"
            value={senha}
            onChangeText={(texto) => {
              setSenha(texto);
              setErroSenha(null);
            }}
            secureTextEntry
            autoComplete="current-password"
            erro={erroSenha ?? undefined}
            ajuda="Confirma que é você"
          />
          <Botao
            titulo="Excluir minha conta"
            variante="perigo"
            grande
            onPress={pedirConfirmacao}
          />
        </Cartao>
      </ScrollView>

      <Confirmacao
        visivel={confirmando}
        titulo="Excluir a sua conta?"
        textoConfirmar="Excluir conta"
        carregando={excluir.isPending}
        aoConfirmar={() => excluir.mutate()}
        aoCancelar={() => setConfirmando(false)}
      >
        <Text style={s.texto}>
          Não tem volta. Você sai do aplicativo agora e não entra mais com {usuario?.email}.
        </Text>
      </Confirmacao>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  tela: { flex: 1, backgroundColor: cores.fundo },
  conteudo: { padding: espaco.lg, paddingBottom: espaco.xxl, gap: espaco.sm },

  nome: { fontSize: fonte.media, fontWeight: '800', color: cores.texto },
  email: { fontSize: fonte.pequena, color: cores.textoSuave, marginTop: 2 },
  papel: { alignSelf: 'flex-start', marginTop: espaco.sm },

  opcao: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: espaco.lg,
    backgroundColor: cores.superficie,
    borderRadius: raio.md,
    padding: espaco.lg,
  },
  opcaoTexto: { flex: 1 },
  opcaoRotulo: { fontSize: fonte.base, fontWeight: '700', color: cores.texto },
  opcaoDescricao: { fontSize: fonte.pequena, color: cores.textoSuave, marginTop: 2 },

  secao: {
    fontSize: fonte.pequena,
    fontWeight: '700',
    color: cores.textoSuave,
    marginTop: espaco.md,
  },
  texto: { fontSize: fonte.base, color: cores.texto, lineHeight: 21 },
  subtitulo: {
    fontSize: fonte.pequena,
    fontWeight: '700',
    color: cores.texto,
    marginTop: espaco.md,
    marginBottom: espaco.xs,
  },
  item: { fontSize: fonte.pequena, color: cores.textoSuave, lineHeight: 19, marginBottom: 2 },
  fim: {
    fontSize: fonte.pequena,
    color: cores.texto,
    fontWeight: '600',
    marginTop: espaco.md,
    marginBottom: espaco.md,
  },
  dica: { fontSize: fonte.pequena, color: cores.textoSuave, marginBottom: espaco.md },
  recusa: {
    color: cores.perigo,
    backgroundColor: cores.perigoFraco,
    borderRadius: raio.sm,
    overflow: 'hidden',
    padding: espaco.md,
    fontSize: fonte.base,
    fontWeight: '600',
    marginBottom: espaco.md,
  },
});
