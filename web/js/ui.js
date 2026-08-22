/**
 * Peças de interface reaproveitadas por todas as telas.
 *
 * A regra de segurança do projeto: nada de dado vindo do servidor entra em `innerHTML` sem
 * passar por escape. O template `html` faz isso por padrão — o que for interpolado nele é
 * escapado, e HTML de verdade só entra marcado com `cru()`. Um nome de produto com `<` já
 * basta para quebrar a página; com `<img onerror>` vira execução de script.
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapar(valor) {
  return String(valor).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

const MARCA_CRUA = Symbol('html-cru');

/** Marca um texto como HTML já confiável (montado por nós, nunca vindo do servidor). */
export function cru(texto) {
  return { [MARCA_CRUA]: true, texto: String(texto), toString: () => String(texto) };
}

function interpolar(valor) {
  if (valor === null || valor === undefined || valor === false) return '';
  if (Array.isArray(valor)) return valor.map(interpolar).join('');
  if (typeof valor === 'object' && valor[MARCA_CRUA]) return valor.texto;
  return escapar(valor);
}

/**
 * Template de HTML com escape automático: html`<td>${nomeDoProduto}</td>`.
 *
 * Devolve um valor JÁ MARCADO como confiável, e não uma string solta, para que um template
 * dentro do outro continue sendo HTML. Se devolvesse string, `html`<ul>${itens.map(...)}`
 * escaparia a lista inteira e a tela mostraria as tags como texto.
 *
 * Onde se espera texto (innerHTML, join, concatenação) o `toString` resolve sozinho.
 */
export function html(partes, ...valores) {
  return cru(partes.reduce((acc, parte, i) => acc + parte + interpolar(valores[i]), ''));
}

/* ---------------------------------------------------------------- formatação pt-BR */

/** "2026-08-22" ou ISO completo -> "22/08/2026". Sem `new Date` em data pura: o fuso comeria um dia. */
export function data(valor) {
  if (!valor) return '—';
  const texto = String(valor);
  const soData = texto.slice(0, 10);
  const [ano, mes, dia] = soData.split('-');
  return ano && mes && dia ? `${dia}/${mes}/${ano}` : texto;
}

/** ISO com hora -> "22/08/2026 14:35". */
export function dataHora(valor) {
  if (!valor) return '—';
  const d = new Date(valor);
  if (Number.isNaN(d.getTime())) return String(valor);
  return `${data(valor)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "2026-08" -> "agosto de 2026". */
export function competencia(valor) {
  if (!valor) return '—';
  const [ano, mes] = String(valor).split('-');
  const nomes = [
    'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
    'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
  ];
  return `${nomes[Number(mes) - 1] ?? mes} de ${ano}`;
}

export const hojeISO = () => {
  const agora = new Date();
  const local = new Date(agora.getTime() - agora.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
};

export function diasAtrasISO(dias) {
  const d = new Date();
  d.setDate(d.getDate() - dias);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

export const numero = (n) => Number(n || 0).toLocaleString('pt-BR');

export const plural = (n, singular, plural_) => `${numero(n)} ${n === 1 ? singular : plural_}`;

/* ---------------------------------------------------------------- avisos e diálogos */

let areaAvisos = null;

export function aviso(mensagem, tipo = 'ok') {
  areaAvisos ??= document.getElementById('avisos');
  const caixa = document.createElement('div');
  caixa.className = `aviso aviso--${tipo}`;
  caixa.setAttribute('role', tipo === 'erro' ? 'alert' : 'status');
  caixa.textContent = mensagem;
  areaAvisos.append(caixa);
  const sair = () => {
    caixa.classList.add('aviso--saindo');
    setTimeout(() => caixa.remove(), 200);
  };
  const timer = setTimeout(sair, tipo === 'erro' ? 7000 : 3500);
  caixa.addEventListener('click', () => {
    clearTimeout(timer);
    sair();
  });
}

export const avisarErro = (erro) =>
  aviso(erro?.textoAmigavel || erro?.message || 'Não foi possível concluir.', 'erro');

/**
 * Modal. `render(fechar)` devolve o HTML do corpo; `aoAbrir(elemento, fechar)` recebe o nó
 * já na tela para ligar os eventos. Resolve com o valor passado a `fechar(valor)`.
 */
export function modal({ titulo, render, aoAbrir, largura = '520px' }) {
  return new Promise((resolve) => {
    const fundo = document.createElement('div');
    fundo.className = 'modal-fundo';
    fundo.innerHTML = html`
      <div class="modal" role="dialog" aria-modal="true" aria-label="${titulo}" style="max-width:${cru(largura)}">
        <header class="modal__topo">
          <h2>${titulo}</h2>
          <button class="botao-icone" data-fechar aria-label="Fechar">✕</button>
        </header>
        <div class="modal__corpo"></div>
      </div>
    `;
    const focoAnterior = document.activeElement;

    const fechar = (valor) => {
      document.removeEventListener('keydown', aoTeclar);
      fundo.remove();
      focoAnterior?.focus?.();
      resolve(valor);
    };
    const aoTeclar = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        fechar(undefined);
      }
    };

    fundo.querySelector('.modal__corpo').innerHTML = render ? render(fechar) : '';
    fundo.querySelector('[data-fechar]').addEventListener('click', () => fechar(undefined));
    fundo.addEventListener('mousedown', (e) => {
      if (e.target === fundo) fechar(undefined);
    });
    document.addEventListener('keydown', aoTeclar);
    document.body.append(fundo);

    aoAbrir?.(fundo.querySelector('.modal__corpo'), fechar);
    const primeiro = fundo.querySelector(
      'input:not([type=hidden]), select, textarea, button:not([data-fechar])',
    );
    primeiro?.focus();
  });
}

/** Confirmação. Resolve `true` só quando a pessoa confirma de fato. */
export function confirmar({ titulo, mensagem, confirmarTexto = 'Confirmar', perigo = false }) {
  return modal({
    titulo,
    largura: '440px',
    render: () => html`
      <p class="texto-suave">${mensagem}</p>
      <div class="modal__acoes">
        <button class="botao botao--neutro" data-nao>Cancelar</button>
        <button class="botao ${cru(perigo ? 'botao--perigo' : '')}" data-sim>${confirmarTexto}</button>
      </div>
    `,
    aoAbrir: (corpo, fechar) => {
      corpo.querySelector('[data-nao]').addEventListener('click', () => fechar(false));
      corpo.querySelector('[data-sim]').addEventListener('click', () => fechar(true));
      corpo.querySelector('[data-sim]').focus();
    },
  }).then((v) => v === true);
}

/** Pergunta um texto (motivo de cancelamento, observação). Resolve o texto ou `undefined`. */
export function perguntarTexto({ titulo, rotulo, placeholder = '', minimo = 3, confirmarTexto = 'Confirmar' }) {
  return modal({
    titulo,
    largura: '460px',
    render: () => html`
      <form data-form>
        <label class="campo">
          <span>${rotulo}</span>
          <textarea name="texto" rows="3" placeholder="${placeholder}" required minlength="${minimo}"></textarea>
        </label>
        <div class="modal__acoes">
          <button type="button" class="botao botao--neutro" data-nao>Cancelar</button>
          <button type="submit" class="botao">${confirmarTexto}</button>
        </div>
      </form>
    `,
    aoAbrir: (corpo, fechar) => {
      corpo.querySelector('[data-nao]').addEventListener('click', () => fechar(undefined));
      corpo.querySelector('[data-form]').addEventListener('submit', (e) => {
        e.preventDefault();
        fechar(new FormData(e.target).get('texto').trim());
      });
    },
  });
}

/* ---------------------------------------------------------------- blocos de página */

export const carregando = (texto = 'Carregando…') => html`
  <div class="carregando" role="status">
    <span class="giro" aria-hidden="true"></span>
    <span>${texto}</span>
  </div>
`;

export const vazio = (titulo, dica = '', acao = '') => html`
  <div class="vazio">
    <p class="vazio__titulo">${titulo}</p>
    ${dica ? cru(html`<p class="texto-suave">${dica}</p>`) : ''}
    ${cru(acao)}
  </div>
`;

export const erroBloco = (mensagem) => html`
  <div class="vazio vazio--erro">
    <p class="vazio__titulo">Não deu para carregar</p>
    <p class="texto-suave">${mensagem}</p>
    <button class="botao botao--neutro" onclick="location.reload()">Tentar de novo</button>
  </div>
`;

export const etiqueta = (texto, tom = 'neutro') =>
  html`<span class="etiqueta etiqueta--${cru(tom)}">${texto}</span>`;

/**
 * Barra de paginação. Só aparece quando há mais de uma página.
 * `aoMudar` recebe a página nova (1-based).
 */
export function paginacao({ total, page, size }) {
  const paginas = Math.max(1, Math.ceil(total / size));
  if (paginas <= 1) return '';
  const de = (page - 1) * size + 1;
  const ate = Math.min(page * size, total);
  return html`
    <nav class="paginacao" aria-label="Paginação">
      <span class="texto-suave">${numero(de)}–${numero(ate)} de ${numero(total)}</span>
      <span class="paginacao__botoes">
        <button class="botao botao--neutro botao--pequeno" data-pagina="${page - 1}" ${cru(page <= 1 ? 'disabled' : '')}>Anterior</button>
        <span class="texto-suave">Página ${numero(page)} de ${numero(paginas)}</span>
        <button class="botao botao--neutro botao--pequeno" data-pagina="${page + 1}" ${cru(page >= paginas ? 'disabled' : '')}>Próxima</button>
      </span>
    </nav>
  `;
}

export function ligarPaginacao(raiz, aoMudar) {
  raiz.querySelectorAll('[data-pagina]').forEach((botao) => {
    botao.addEventListener('click', () => aoMudar(Number(botao.dataset.pagina)));
  });
}

/** Espera a digitação parar antes de buscar — senão cada tecla vira uma requisição. */
export function comAtraso(fn, ms = 350) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/**
 * Campo de dinheiro estilo caixa registradora: o valor em centavos fica no dataset e a
 * pessoa só digita números. Devolve uma função que lê o valor atual em centavos.
 */
export function ligarCampoDinheiro(input, inicial = 0, aoMudar) {
  const dinheiro = { valor: inicial };
  // Campo que já vem preenchido (o que falta pagar, o esperado no caixa) é uma SUGESTÃO.
  // Sem isto, digitar "200" sobre um campo que mostra 179,70 daria 17.970,00: os dígitos
  // empurram pela direita e o valor sugerido vira prefixo. Já rendeu troco de milhão.
  // Então o primeiro dígito depois de focar recomeça o número; do segundo em diante, empurra.
  let recomecar = true;

  const pintar = (avisar = false) => {
    input.value = formatarValorInterno(dinheiro.valor);
    if (avisar) aoMudar?.(dinheiro.valor);
  };

  input.setAttribute('inputmode', 'numeric');
  pintar();

  input.addEventListener('focus', () => {
    recomecar = true;
    input.select();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      recomecar = false; // Apagar é corrigir o número que está lá, não começar outro.
      dinheiro.valor = Math.trunc(dinheiro.valor / 10);
      pintar(true);
    } else if (/^\d$/.test(e.key) && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      const base = recomecar ? 0 : dinheiro.valor;
      recomecar = false;
      const proximo = base * 10 + Number(e.key);
      // Acima de R$ 9.999.999,99 é erro de digitação: o dígito é ignorado em vez de
      // truncar o valor para um número que ninguém digitou.
      if (proximo <= 999999999) {
        dinheiro.valor = proximo;
        pintar(true);
      }
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
    }
  });

  return {
    valor: () => dinheiro.valor,
    definir: (centavos) => {
      dinheiro.valor = centavos;
      recomecar = true;
      pintar(true);
    },
  };
}

function formatarValorInterno(centavos) {
  const inteiros = Math.floor(Math.abs(centavos) / 100).toLocaleString('pt-BR');
  const resto = String(Math.abs(centavos) % 100).padStart(2, '0');
  return `${centavos < 0 ? '-' : ''}${inteiros},${resto}`;
}

/** Nome curto do tamanho/cor para caber em tabela: "P · Preto". */
export const grade = (tamanho, cor) => (cor && cor !== 'Única' ? `${tamanho} · ${cor}` : tamanho);

export const FORMAS = {
  DINHEIRO: 'Dinheiro',
  PIX: 'PIX',
  DEBITO: 'Débito',
  CREDITO: 'Crédito',
};

export const TIPOS_MOVIMENTO = {
  ENTRADA: 'Entrada',
  AJUSTE: 'Ajuste',
  INVENTARIO: 'Inventário',
  VENDA: 'Venda',
  ESTORNO: 'Estorno',
};
