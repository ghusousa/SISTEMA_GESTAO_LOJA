/**
 * "Usar como leitor do computador" (ADR-43 e ADR-47).
 *
 * Nas telas do computador que leem código (PDV, Devolução, Entrada, Inventário, Condicional
 * nova), "Abrir no app o leitor de código" CHAMA o celular do mesmo login: o chamado aparece
 * aqui num cartão com o sinal de 3 caracteres que o computador também mostra ("Sinal 7K3"), e
 * um toque em "Abrir o leitor" liga a câmera — sem QR nem código (ADR-47). Fora desta tela,
 * quem avisa é a faixa do topo (`components/FaixaDoChamado.tsx`), e com o app fechado, a
 * notificação, quando o servidor da loja manda push — o toque nela abre esta tela já ligando o
 * chamado daquele sinal.
 *
 * O QR continua, recolhido: o celular de OUTRA pessoa (outro login), ou o app sem o chamado.
 * O celular lê o QR — ou a pessoa digita o código — e passa a ser o leitor de código de barras
 * daquele computador: cada bipe na câmera cai no campo do leitor de lá, como o leitor USB.
 *
 * Qualquer pessoa logada pode (não há capacidade própria). Um celular por computador, e o
 * leitor vale até alguém desligar, sair, ou no máximo 12 h. O app liga SEMPRE no servidor em
 * que já está: o endereço do QR só serve para avisar que o código é de outro servidor.
 *
 * As notificações: a permissão é pedida aqui na abertura (sem leitor ligado, sem câmera), só
 * no iPhone, só se o servidor manda push e só se nunca decidida. A linha do fim da tela diz o
 * efeito; recusada, oferece "Abrir Ajustes" — a régua da câmera (5.1.1).
 */

import { useMutation } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';

import { baseAtual, mensagemDoErro } from '@/api/client';
import { leitor } from '@/api/endpoints';
import { CartoesDoChamado } from '@/components/FaixaDoChamado';
import { LeitorPareado, ListaDeBipes } from '@/components/LeitorPareado';
import { Scanner, SO_QR, type ScannerRef } from '@/components/Scanner';
import { Botao, Campo, Cartao } from '@/components/ui';
import {
  buscarChamadosAbertos,
  useAtenderChamado,
  useChamadosDoLeitor,
  type AtenderChamado,
} from '@/hooks/useChamadosDoLeitor';
import { useTelaVisivel } from '@/hooks/useTelaVisivel';
import { urlDaApi } from '@/lib/enderecoDoServidor';
import { idDaInstalacao } from '@/lib/instalacao';
import {
  conviteDoLink,
  formatarCodigo,
  hostDoEndereco,
  lerConvite,
  mesmoServidor,
  normalizarCodigo,
  type Convite,
} from '@/lib/leitorRemoto';
import { avisoDasNotificacoes, type SituacaoNaTela } from '@/lib/notificacoes';
import { situacaoNoLeitor } from '@/lib/pushDoLeitor';
import { chaves, queryClient } from '@/lib/queryClient';
import { cores, espaco, fonte } from '@/lib/tema';
import { useLeitorStore } from '@/stores/leitorStore';

/** O toque numa notificação cujo chamado não está mais aberto. */
const CHAMADO_QUE_ACABOU =
  'Esse chamado já acabou (venceu, foi atendido ou cancelado). Se o computador ainda estiver chamando, ele aparece aqui.';

export default function LeitorDoComputador() {
  const pareamento = useLeitorStore((e) => e.pareamento);
  const pedido = useLeitorStore((e) => e.pedido);
  const visivel = useTelaVisivel();
  const atendimento = useAtenderChamado();
  const { atender } = atendimento;
  const [destaque, setDestaque] = useState<string | null>(null);
  const [avisoDoToque, setAvisoDoToque] = useState<string | null>(null);
  const montada = useRef(true);
  useEffect(() => {
    montada.current = true;
    return () => {
      montada.current = false;
    };
  }, []);

  // Um "sim" a um chamado chegou pela store:
  // - o "Abrir o leitor" da faixa traz o id e pede antes a notificação — aqui, sem câmera;
  // - o toque numa notificação traz só o sinal: procura entre os chamados abertos AGORA (sem
  //   cache) e atende — a permissão já existe, ou a notificação não teria chegado.
  // Com o leitor ligado não troca sozinho: destaca a linha do chamado, e trocar é um toque.
  useEffect(() => {
    if (!pedido) return;
    const lido = useLeitorStore.getState().consumirPedido();
    if (!lido) return;
    setAvisoDoToque(null);
    if (lido.id !== undefined && !useLeitorStore.getState().pareamento) {
      atender(lido.id, { pedirPermissao: lido.pedirPermissao });
      return;
    }
    queryClient
      .fetchQuery({ queryKey: chaves.chamadosDoLeitor, queryFn: buscarChamadosAbertos, staleTime: 0, retry: false })
      .then((chamados) => {
        if (!montada.current) return;
        const achado = chamados.find((c) => c.sinal === lido.sinal);
        if (!achado) setAvisoDoToque(CHAMADO_QUE_ACABOU);
        else if (useLeitorStore.getState().pareamento) setDestaque(achado.sinal);
        else atender(achado.id, { pedirPermissao: lido.pedirPermissao });
      })
      .catch((erro: unknown) => {
        if (montada.current) setAvisoDoToque(mensagemDoErro(erro, 'Não deu para procurar o chamado.'));
      });
  }, [pedido, atender]);

  if (pareamento) {
    return (
      <LeitorPareado
        pareamento={pareamento}
        visivel={visivel}
        atendimento={atendimento}
        destaque={destaque}
        avisoDoToque={avisoDoToque}
      />
    );
  }
  return (
    <SemPareamento
      visivel={visivel}
      atendimento={atendimento}
      avisoDoToque={avisoDoToque}
      esquecerAvisoDoToque={() => setAvisoDoToque(null)}
    />
  );
}

/**
 * A linha das notificações no fim da tela. Na primeira vez que a tela aparece sem leitor e sem
 * câmera, o sistema pergunta (só nas condições de `lib/pushDoLeitor.ts`); na volta dos Ajustes,
 * relê. Sem tela do app com "Permitir" antes do alerta.
 */
function useSituacaoDasNotificacoes(visivel: boolean, podePedir: boolean): SituacaoNaTela {
  const [situacao, setSituacao] = useState<SituacaoNaTela>('lendo');
  const jaPediu = useRef(false);
  useEffect(() => {
    if (!visivel) return undefined;
    let viva = true;
    const pedir = podePedir && !jaPediu.current;
    jaPediu.current = true;
    void situacaoNoLeitor({ pedir }).then((nova) => {
      if (viva) setSituacao(nova);
    });
    return () => {
      viva = false;
    };
    // `podePedir` vale só na abertura (o `jaPediu`): depois, a tela só relê.
  }, [visivel, podePedir]);
  return situacao;
}

type Modo = 'inicio' | 'qr' | 'digitar';

const NAO_E_CONVITE = 'Isso não é o QR do leitor. Aponte para o QR na tela do computador.';
const CONVITE_DE_OUTRA_VERSAO =
  'Este link do leitor é de outra versão do sistema. Leia o QR pela câmera do app ou digite o código.';


/** A API do app no mesmo formato da do convite (`…/api/v1`, com a raiz: `…/demo/api/v1`). */
function apiDoApp(): string {
  return urlDaApi(baseAtual());
}

function SemPareamento({
  visivel,
  atendimento,
  avisoDoToque,
  esquecerAvisoDoToque,
}: {
  visivel: boolean;
  atendimento: AtenderChamado;
  avisoDoToque: string | null;
  esquecerAvisoDoToque: () => void;
}) {
  const params = useLocalSearchParams<{ v?: string; c?: string; api?: string }>();
  const router = useRouter();
  const ligar = useLeitorStore((e) => e.ligar);
  const aviso = useLeitorStore((e) => e.aviso);
  const esquecerAviso = useLeitorStore((e) => e.esquecerAviso);
  // O que não saiu do leitor que acabou de parar: a pessoa vê o que refazer até dispensar.
  // (Filtra fora do seletor: array novo a cada leitura da store faria o zustand 5 girar.)
  const bipes = useLeitorStore((e) => e.bipes);
  const naoSairam = bipes.filter((b) => b.estado === 'nao-enviado' || b.estado === 'sem-confirmacao');
  const { data: chamados } = useChamadosDoLeitor();
  // Pedir a permissão de notificação na abertura, mas não por cima de quem chegou pelo link do
  // QR com o código preenchido: essa pessoa veio tocar em "Ligar".
  const [podePedir] = useState(() => !normalizarCodigo(params.c));
  const linhaDasNotificacoes = avisoDasNotificacoes(useSituacaoDasNotificacoes(visivel, podePedir));

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
    if (!normalizarCodigo(params.c)) return;
    // Pelo mesmo leitor do QR (versão, código, `api` que não é http(s)): o link e a câmera
    // do app aceitam e recusam as mesmas coisas.
    const convite = lerConvite(conviteDoLink({ v: params.v, c: params.c, api: params.api }));
    router.setParams({ v: undefined, c: undefined, api: undefined } as never);
    if (!convite) {
      setErro(CONVITE_DE_OUTRA_VERSAO);
      return;
    }
    setTexto(formatarCodigo(convite.codigo));
    setApiDoConvite(convite.api);
    setModo('digitar');
  }, [params.v, params.c, params.api, router]);

  const aceitar = useMutation({
    mutationFn: async (convite: Convite) => {
      // A sessão de quando o aceite saiu: se ela sair antes da resposta, nada liga.
      const sessao = useLeitorStore.getState().sessao;
      // A instalação prende o leitor a ESTE aparelho (ADR-47): o reenvio do aceite só vale
      // para ele, e outro celular com o mesmo login não bipa por este pareamento.
      return { novo: await leitor.aceitar(convite.codigo, await idDaInstalacao()), sessao };
    },
    onSuccess: ({ novo, sessao }) => {
      setErro(null);
      ligar(novo, sessao);
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
      // A câmera segue lendo; a trava do Scanner segura a repetição do mesmo QR. `false`:
      // a leitura foi recusada — sem a vibração de "deu certo" nem o "Último: <Pix>".
      setAvisoQr(NAO_E_CONVITE);
      return false;
    }
    scanner.current?.pausar();
    setAvisoQr(null);
    setErro(null);
    setApiDoConvite(convite.api);
    mutar.current(convite);
    return true;
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
    // O aviso do leitor que parou (e a lista do que não chegou) fica até a pessoa tocar
    // nele, ou até ligar de novo: é a lista do que ela tem de bipar outra vez.
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
            encosta="embaixo"
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

  const avisoDoChamado = atendimento.aviso ?? avisoDoToque;

  return (
    <ScrollView contentContainerStyle={s.conteudo} keyboardShouldPersistTaps="handled">
      {/* Primeiro, o que o computador está pedindo agora: um cartão por chamado aberto. */}
      <CartoesDoChamado chamados={chamados ?? []} atendimento={atendimento} />
      {!!avisoDoChamado && (
        <Cartao
          estilo={s.cartaoAviso}
          onPress={() => {
            atendimento.esquecerAviso();
            esquecerAvisoDoToque();
          }}
        >
          <Text style={s.avisoTexto}>{avisoDoChamado}</Text>
          <Text style={s.dispensar}>Tocar para fechar</Text>
        </Cartao>
      )}

      {!!aviso && (
        <Cartao estilo={s.cartaoAviso} onPress={esquecerAviso}>
          <Text style={s.avisoTexto}>{aviso}</Text>
          {naoSairam.length > 0 && (
            <Text style={s.avisoTexto}>
              {naoSairam.length === 1
                ? 'Esta leitura não saiu (ou não foi confirmada) — bipe de novo o que faltar:'
                : `Estas ${naoSairam.length} leituras não saíram (ou não foram confirmadas) — bipe de novo o que faltar:`}
            </Text>
          )}
          <Text style={s.dispensar}>Tocar para fechar</Text>
        </Cartao>
      )}
      {!!aviso && naoSairam.length > 0 && <ListaDeBipes bipes={[...naoSairam].reverse()} />}

      <Cartao>
        <Text style={s.titulo}>Usar o celular como leitor</Text>
        <Text style={s.texto}>
          No computador, entre com o mesmo login e toque em “Abrir no app o leitor de código”:
          o chamado aparece aqui, com o mesmo sinal da tela de lá. Para o celular de outra
          pessoa, leia o QR do computador. Depois de ligado, cada peça bipada aqui cai na tela
          do computador, como no leitor de código de barras.
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
            onChangeText={(novo) => {
              setTexto(novo);
              // Outro código, talvez de outro computador: a dica do QR de antes não vale mais.
              setApiDoConvite(null);
            }}
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

      {/* Por último: o computador alcança este celular com o app fechado? */}
      {linhaDasNotificacoes && (
        <View style={s.notificacoes}>
          <Text style={s.notificacoesTexto}>{linhaDasNotificacoes.texto}</Text>
          {linhaDasNotificacoes.botao && (
            <Botao
              titulo={linhaDasNotificacoes.botao}
              variante="secundario"
              onPress={() => void Linking.openSettings()}
            />
          )}
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
  notificacoes: { gap: espaco.sm, paddingTop: espaco.sm },
  notificacoesTexto: { fontSize: fonte.pequena, color: cores.textoSuave, lineHeight: 19 },
  avisoQr: {
    color: '#FFF',
    backgroundColor: 'rgba(198,40,40,0.85)',
    padding: espaco.sm,
    borderRadius: 8,
    textAlign: 'center',
    fontWeight: '600',
  },
});
