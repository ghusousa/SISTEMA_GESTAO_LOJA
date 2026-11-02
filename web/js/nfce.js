/**
 * NFC-e de uma venda (ADR-41): o cartão do detalhe da venda e a linha do recibo.
 *
 * A tela não decide nada fiscal. Mostra o que `GET /vendas/{id}/nfce` diz e, no botão,
 * pede `POST` — que é idempotente: nota autorizada não sai duas vezes, por mais cliques
 * que o balcão dê. O que falta para emitir (NCM, CNPJ, emissor) vem do servidor, já em
 * frase de gente, e aparece aqui como lista.
 */

import { api } from './api.js';
import { PODE, pode } from './permissoes.js';
import { aviso, avisarErro, cru, dataHora, etiqueta, html, numero } from './ui.js';

const STATUS = {
  PENDENTE: ['Pendente', 'alerta'],
  AUTORIZADA: ['Autorizada', 'ok'],
  REJEITADA: ['Rejeitada', 'perigo'],
  CANCELADA: ['Cancelada', 'neutro'],
};

/** A situação fiscal da venda, ou `null` se não deu para saber (a tela segue sem ela). */
export async function situacaoDaNfce(vendaId) {
  try {
    return await api.get(`/vendas/${vendaId}/nfce`);
  } catch {
    return null;
  }
}

/** Chave de 44 dígitos em grupos de 4, como sai no DANFE: dá para ler e para ditar. */
export const chaveFormatada = (chave) => (chave || '').replace(/(\d{4})(?=\d)/g, '$1 ');

/** Só link http(s): o endereço vem do emissor, e `javascript:` não vira botão aqui. */
const linkSeguro = (url) => (/^https?:\/\//i.test(url || '') ? url : null);

/** A linha do recibo: "NFC-e autorizada: <chave>", quando houver. */
export function linhaDoRecibo(nfce) {
  const nota = nfce?.nota;
  if (nota?.status !== 'AUTORIZADA') return '';
  return html`
    <span class="recibo__nfce" style="word-break:break-word">NFC-e autorizada: ${chaveFormatada(nota.chave)}</span>
    ${nota.ambiente === 'homologacao' ? cru('<span class="recibo__miudo">Homologação — sem valor fiscal.</span>') : ''}
  `;
}

function listaDoQueFalta(itens) {
  if (!itens?.length) return '';
  return html`<ul class="texto-suave" style="margin:8px 0 0 18px">${itens.map((f) => html`<li>${f}</li>`)}</ul>`;
}

function corpoDoCartao(venda, nfce, faltando) {
  const { emissor, nota } = nfce;
  const cancelada = venda.status === 'CANCELADA';
  const podeEmitir = emissor.configurado && !cancelada;

  if (!nota) {
    if (!emissor.configurado) {
      return html`
        <p>Emissor fiscal desligado: esta venda não tem NFC-e.</p>
        ${listaDoQueFalta(emissor.faltando)}
      `;
    }
    return html`
      <p class="texto-suave">${cancelada ? 'Venda cancelada: não emite nota.' : 'NFC-e ainda não emitida.'}</p>
      ${listaDoQueFalta(faltando)}
      ${podeEmitir ? cru('<button class="botao" data-emitir>Emitir NFC-e</button>') : ''}
    `;
  }

  const [rotulo, tom] = STATUS[nota.status] || [nota.status, 'neutro'];
  const danfe = linkSeguro(nota.url_danfe);
  const xml = linkSeguro(nota.url_xml);
  const tentarDeNovo = podeEmitir && (nota.status === 'PENDENTE' || nota.status === 'REJEITADA');
  return html`
    <p>
      ${cru(etiqueta(rotulo, tom))}
      ${nota.ambiente === 'homologacao' ? cru(etiqueta('Homologação — sem valor fiscal', 'info')) : ''}
      ${nota.numero ? cru(html` · Nº ${numero(nota.numero)}, série ${nota.serie ?? '—'}`) : ''}
      ${nota.autorizada_em ? cru(html` · autorizada em ${dataHora(nota.autorizada_em)}`) : ''}
    </p>
    ${nota.chave ? cru(html`<p class="dinheiro" style="word-break:break-all">Chave: ${chaveFormatada(nota.chave)}</p>`) : ''}
    ${nota.mensagem && nota.status !== 'AUTORIZADA' ? cru(html`<p class="texto-suave">${nota.mensagem}</p>`) : ''}
    ${listaDoQueFalta(faltando)}
    <div class="pagina__acoes" style="margin-top:8px">
      ${danfe ? cru(html`<a class="botao botao--fantasma" href="${danfe}" target="_blank" rel="noopener">Abrir DANFE</a>`) : ''}
      ${xml ? cru(html`<a class="botao botao--fantasma" href="${xml}" target="_blank" rel="noopener">XML</a>`) : ''}
      ${tentarDeNovo ? cru('<button class="botao" data-emitir>Tentar de novo</button>') : ''}
    </div>
  `;
}

/**
 * Desenha o cartão da NFC-e em `alvo`. Quem não configura a loja não vê o cartão de um
 * emissor desligado — é aviso para o dono, não ruído no balcão de quem não pode resolver.
 */
export function cartaoNfce(alvo, venda, nfce) {
  if (!alvo) return;
  if (!nfce || (!nfce.nota && !nfce.emissor.configurado && !pode(PODE.CONFIGURAR_LOJA))) {
    alvo.innerHTML = '';
    return;
  }
  const desenhar = (faltando = []) => {
    alvo.innerHTML = html`
      <div class="cartao" style="margin-top:16px">
        <div class="cartao__topo"><h2>NFC-e</h2></div>
        <div class="cartao__corpo">${corpoDoCartao(venda, nfce, faltando)}</div>
      </div>
    `;
    alvo.querySelector('[data-emitir]')?.addEventListener('click', emitir);
  };

  async function emitir(evento) {
    const botao = evento.currentTarget;
    botao.disabled = true;
    botao.innerHTML = cru('<span class="giro" aria-hidden="true"></span> Emitindo…');
    try {
      nfce = await api.post(`/vendas/${venda.id}/nfce`, {});
      const status = nfce.nota?.status;
      if (status === 'AUTORIZADA') aviso('NFC-e autorizada.');
      else if (status === 'REJEITADA') aviso('A SEFAZ recusou a nota. Veja o motivo no cartão.', 'erro');
      else aviso('Sem resposta definitiva do emissor. Tente de novo em instantes.', 'alerta');
      desenhar();
    } catch (erro) {
      avisarErro(erro);
      desenhar(erro.detail?.faltando || []);
    }
  }

  desenhar();
}
