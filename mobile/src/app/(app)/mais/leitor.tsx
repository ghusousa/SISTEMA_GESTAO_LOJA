/**
 * "Usar como leitor do computador" (ADR-43).
 *
 * No computador (PDV, Devolução, Entrada, Inventário, Condicional nova) a pessoa pede para
 * ligar o celular: aparece um QR e um código de 6 caracteres. Aqui o celular lê o QR — ou
 * a pessoa digita o código — e passa a ser o leitor de código de barras daquele
 * computador: cada bipe na câmera cai no campo do leitor de lá, como o leitor USB.
 *
 * Qualquer pessoa logada pode (não há capacidade própria). Um celular por computador, e o
 * aceite vale até alguém desligar, sair, ou no máximo 12 h. O app aceita SEMPRE no
 * servidor em que já está ligado: o endereço do QR só serve para avisar que o código é de
 * outro servidor.
 */

import { useMutation } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { baseAtual, mensagemDoErro } from '@/api/client';
import { leitor } from '@/api/endpoints';
import { LeitorPareado } from '@/components/LeitorPareado';
import { Scanner, SO_QR, type ScannerRef } from '@/components/Scanner';
import { Botao, Campo, Cartao } from '@/components/ui';
import { useTelaVisivel } from '@/hooks/useTelaVisivel';
import {
  formatarCodigo,
  hostDoEndereco,
  lerConvite,
  mesmoServidor,
  montarConvite,
  normalizarCodigo,
  type Convite,
} from '@/lib/leitorRemoto';
import { cores, espaco, fonte } from '@/lib/tema';
import { useLeitorStore } from '@/stores/leitorStore';

export default function LeitorDoComputador() {
  const pareamento = useLeitorStore((e) => e.pareamento);
  const visivel = useTelaVisivel();
  if (pareamento) return <LeitorPareado pareamento={pareamento} visivel={visivel} />;
  return <SemPareamento visivel={visivel} />;
}

type Modo = 'inicio' | 'qr' | 'digitar';

const NAO_E_CONVITE = 'Isso não é o QR do leitor. Aponte para o QR na tela do computador.';

/** A API do app no mesmo formato da do convite (`…/api/v1`). */
function apiDoApp(): string {
  return `${baseAtual()}/api/v1`;
}

function SemPareamento({ visivel }: { visivel: boolean }) {
  const params = useLocalSearchParams<{ c?: string; api?: string }>();
  const router = useRouter();
  const ligar = useLeitorStore((e) => e.ligar);
  const aviso = useLeitorStore((e) => e.aviso);
  const esquecerAviso = useLeitorStore((e) => e.esquecerAviso);

  const [modo, setModo] = useState<Modo>('inicio');
  const [texto, setTexto] = useState('');
  const [apiDoConvite, setApiDoConvite] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [avisoQr, setAvisoQr] = useState<string | null>(null);
  const scanner = useRef<ScannerRef | null>(null);

  // Veio do link do QR (`gestaoloja://leitor?c=…`, ver `app/(app)/leitor.tsx`): o código
  // chega preenchido, mas ligar continua sendo um toque da pessoa. Lido, sai da rota —
  // senão, depois de desligar, a tela voltaria com o código velho no campo.
  useEffect(() => {
    const codigo = normalizarCodigo(params.c);
    if (!codigo) return;
    setTexto(formatarCodigo(codigo));
    // Pelo mesmo leitor do QR: `api` que não é http(s) vira null do mesmo jeito.
    setApiDoConvite(lerConvite(montarConvite(codigo, params.api))?.api ?? null);
    setModo('digitar');
    router.setParams({ c: undefined, api: undefined } as never);
  }, [params.c, params.api, router]);

  const aceitar = useMutation({
    mutationFn: (convite: Convite) => leitor.aceitar(convite.codigo),
    onSuccess: (novo) => {
      setErro(null);
      ligar(novo);
    },
    onError: (falha, convite) => {
      let mensagem = mensagemDoErro(falha, 'Não deu para ligar o leitor.');
      // O app nunca troca de servidor por causa de um QR; só diz por que não achou.
      if (convite.api && !mesmoServidor(convite.api, apiDoApp())) {
        mensagem +=
          `\n\nEste código é do servidor ${hostDoEndereco(convite.api)}; o app está ligado ` +
          `em ${hostDoEndereco(baseAtual())} (Mais → "Conectado em", no fim da tela).`;
      }
      setErro(mensagem);
      // Da câmera volta ao começo; digitando, o campo fica para corrigir.
      setModo((atual) => (atual === 'qr' ? 'inicio' : atual));
    },
  });

  // `mutate` em ref: o callback da câmera não pode mudar a cada render (reconfigura).
  const mutar = useRef(aceitar.mutate);
  mutar.current = aceitar.mutate;

  const aoLerQr = useCallback((lido: string) => {
    const convite = lerConvite(lido);
    if (!convite) {
      // A câmera segue lendo; a trava do Scanner segura a repetição do mesmo QR.
      setAvisoQr(NAO_E_CONVITE);
      return;
    }
    scanner.current?.pausar();
    setAvisoQr(null);
    setErro(null);
    setApiDoConvite(convite.api);
    mutar.current(convite);
  }, []);

  function ligarDigitado() {
    const codigo = normalizarCodigo(texto);
    if (!codigo) return;
    setErro(null);
    aceitar.mutate({ codigo, api: apiDoConvite });
  }

  function abrir(novo: Modo) {
    setErro(null);
    setAvisoQr(null);
    esquecerAviso();
    if (novo !== 'digitar') setApiDoConvite(null);
    setModo(novo);
  }

  if (modo === 'qr') {
    return (
      <View style={s.tela}>
        {visivel ? (
          <Scanner
            aoLer={aoLerQr}
            modo="continuo"
            tipos={SO_QR}
            controle={scanner}
            ocupado={aceitar.isPending}
            dica={aceitar.isPending ? 'Ligando…' : 'Aponte para o QR na tela do computador'}
            rodape={
              <>
                {!!avisoQr && <Text style={s.avisoQr}>{avisoQr}</Text>}
                <Botao titulo="Digitar o código" variante="secundario" onPress={() => abrir('digitar')} />
                <Botao titulo="Cancelar" variante="texto" onPress={() => abrir('inicio')} />
              </>
            }
          />
        ) : (
          <View style={s.cameraParada} />
        )}
      </View>
    );
  }

  const codigoValido = normalizarCodigo(texto) !== null;

  return (
    <ScrollView contentContainerStyle={s.conteudo} keyboardShouldPersistTaps="handled">
      {!!aviso && (
        <Cartao estilo={s.cartaoAviso} onPress={esquecerAviso}>
          <Text style={s.avisoTexto}>{aviso}</Text>
          <Text style={s.dispensar}>Tocar para fechar</Text>
        </Cartao>
      )}

      <Cartao>
        <Text style={s.titulo}>Usar o celular como leitor</Text>
        <Text style={s.texto}>
          No computador, peça para ligar o celular como leitor: aparece um QR e um código de
          6 letras e números. Depois de ligado, cada peça bipada aqui cai na tela do
          computador, como no leitor de código de barras.
        </Text>
      </Cartao>

      {!!erro && (
        <Cartao estilo={s.cartaoErro}>
          <Text style={s.erroTexto}>{erro}</Text>
        </Cartao>
      )}

      {modo === 'digitar' ? (
        <Cartao>
          <Campo
            rotulo="Código que aparece no computador"
            value={texto}
            onChangeText={setTexto}
            placeholder="ABC 234"
            autoCapitalize="characters"
            autoCorrect={false}
            autoFocus={!texto}
            maxLength={12}
            returnKeyType="go"
            onSubmitEditing={ligarDigitado}
            style={s.campoCodigo}
            ajuda="Sem 0, O, 1 nem I: só letras e números que não se confundem."
          />
          <View style={s.botoes}>
            <Botao
              titulo="Ligar"
              grande
              desabilitado={!codigoValido}
              carregando={aceitar.isPending}
              onPress={ligarDigitado}
            />
            <Botao titulo="Ler o QR" variante="secundario" onPress={() => abrir('qr')} />
          </View>
        </Cartao>
      ) : (
        <View style={s.botoes}>
          <Botao titulo="Ler o QR do computador" grande onPress={() => abrir('qr')} />
          <Botao titulo="Digitar o código" variante="secundario" onPress={() => abrir('digitar')} />
        </View>
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  tela: { flex: 1, backgroundColor: '#000' },
  cameraParada: { flex: 1, backgroundColor: '#000' },
  conteudo: { padding: espaco.lg, gap: espaco.md },
  titulo: { fontSize: fonte.media, fontWeight: '700', color: cores.texto, marginBottom: espaco.sm },
  texto: { fontSize: fonte.base, color: cores.textoSuave, lineHeight: 22 },
  botoes: { gap: espaco.sm },
  campoCodigo: { fontSize: fonte.titulo, letterSpacing: 4, textAlign: 'center' },
  cartaoAviso: { backgroundColor: cores.alertaFraco, borderColor: cores.alerta, borderWidth: 1 },
  avisoTexto: { fontSize: fonte.base, color: cores.texto, fontWeight: '600' },
  dispensar: { fontSize: fonte.pequena, color: cores.textoSuave, marginTop: espaco.xs },
  cartaoErro: { backgroundColor: cores.perigoFraco, borderColor: cores.perigo, borderWidth: 1 },
  erroTexto: { fontSize: fonte.base, color: cores.perigo },
  avisoQr: {
    color: '#FFF',
    backgroundColor: 'rgba(198,40,40,0.85)',
    padding: espaco.sm,
    borderRadius: 8,
    textAlign: 'center',
    fontWeight: '600',
  },
});
