/**
 * O quadro da foto: nada cortado nas bordas do que se vê.
 *
 * `medirQuadro` roda DENTRO do navegador (o Playwright a serializa): não usa nada de fora
 * dela. Mede a tela como ela está e, na lista que rola (a área rolável sob o centro da
 * tela), procura a posição mais perto da que a cena deixou em que:
 *
 *   - nenhum ÁTOMO fica cortado pela borda de cima ou de baixo, nem embaixo do indicador de
 *     início (os 28 pt de baixo, onde a tela é arredondada). Átomo é o que se lê ou se
 *     reconhece: cada linha de texto, campo, ícone e imagem;
 *   - nenhuma CAIXA (o que tem fundo, borda ou sombra próprios: cartão, botão, pílula) fica
 *     cortada pela borda de cima ou, com a lista rolada, colada nela (menos de 4 pt), nem
 *     termina embaixo do indicador;
 *   - caixa cortada embaixo — a lista continuando — mostra ao menos um átomo inteiro: fatia
 *     de cartão sem nada dentro (a fileira de teclas sob o rodapé) parece defeito. Só na
 *     faixa do indicador, sem texto, é a lista passando por baixo dele, como no iPhone;
 *   - o que flutua por cima da lista (o botão +, mais estreito que a metade dela) não cobre
 *     átomo nenhum;
 *   - o que a cena pediu em `mostrar` fica inteiro à vista.
 *
 * A busca vai até uma tela de distância de onde a cena deixou: a cena escolhe a região, o
 * quadro só acerta as bordas. Fora da lista nada se move: lá, nada pode ficar embaixo da
 * barra de status nem do indicador. Com `procurar: false`, só diz o que está errado onde a
 * tela está.
 *
 * Devolve `{ ok, de, para, problemas, antes }`: `para` é a posição escolhida (já aplicada),
 * `antes` o que estava errado onde a cena deixou, e `problemas` o que sobrou (vazio se ok).
 */
export function medirQuadro({ largura, altura, status, faixa, mostrar = [], procurar = true }) {
  const TOL = 1;
  /** Cartão que começa a menos disto da borda de cima parece colado no cabeçalho. */
  const FOLGA_EM_CIMA = 4;
  const TOL_DE_LADO = 3;
  const B = altura - faixa;
  const transparente = (cor) => !cor || cor === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(cor);
  const visivel = (el) => el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  const rolavel = (el) =>
    ['auto', 'scroll'].includes(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1;

  let rolador = document.elementFromPoint(largura / 2, altura / 2);
  while (rolador && !rolavel(rolador)) rolador = rolador.parentElement;

  // ------------------------------------------------------------- átomos
  /** O pedaço do retângulo que os recortes de dentro da lista deixam ver (ou null). */
  const recortar = (el, r) => {
    let { top, bottom, left, right } = r;
    let cortadoDeLado = false;
    for (let a = el; a && a !== rolador && a !== document.body; a = a.parentElement) {
      const e = getComputedStyle(a);
      if (e.overflowX === 'visible' && e.overflowY === 'visible') continue;
      const q = a.getBoundingClientRect();
      // Na lista que rola de lado (o gráfico), a caixa da letra passa uns 2 pt do desenho
      // dela: só conta como cortado o que passa disso.
      if (['auto', 'scroll'].includes(e.overflowX) && (left < q.left - TOL_DE_LADO || right > q.right + TOL_DE_LADO)) {
        if (right > q.left + TOL && left < q.right - TOL) cortadoDeLado = true;
      }
      top = Math.max(top, q.top);
      bottom = Math.min(bottom, q.bottom);
      left = Math.max(left, q.left);
      right = Math.min(right, q.right);
      if (bottom - top < 1 || right - left < 1) return null;
    }
    return { top, bottom, left, right, cortadoDeLado };
  };
  /** Está mesmo à vista (e não numa tela empilhada por baixo da atual)? */
  const noTopo = (el, r) => {
    for (const y of [r.top + 1, (r.top + r.bottom) / 2, r.bottom - 1]) {
      if (y < 0 || y >= altura) continue;
      const x = Math.min(Math.max((r.left + r.right) / 2, 1), largura - 1);
      const achado = document.elementFromPoint(x, y);
      if (achado && (achado === el || el.contains(achado))) return true;
    }
    return false;
  };

  const atomos = [];
  const juntar = (el, r, texto, grupo) => {
    if (r.width < 1 || r.height < 1) return;
    const naLista = Boolean(rolador && rolador.contains(el));
    const q = recortar(el, r);
    if (!q) return;
    if (!naLista && !noTopo(el, q)) return;
    atomos.push({ el, texto, grupo, naLista, ...q });
  };
  let grupos = 0;
  const andar = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let no = andar.nextNode(); no; no = andar.nextNode()) {
    const pai = no.parentElement;
    const texto = no.textContent.trim();
    if (!texto || !pai || !visivel(pai)) continue;
    const faixaDoTexto = document.createRange();
    faixaDoTexto.selectNodeContents(no);
    grupos += 1;
    for (const r of faixaDoTexto.getClientRects()) juntar(pai, r, texto, grupos);
  }
  for (const el of document.querySelectorAll('input, textarea, img, svg')) {
    if (el.parentElement?.closest('svg') || !visivel(el)) continue;
    grupos += 1;
    const nome = { svg: 'ícone', img: 'imagem' }[el.tagName.toLowerCase()];
    const texto = el.value || el.getAttribute('placeholder') || el.getAttribute('aria-label') || nome || 'campo';
    juntar(el, el.getBoundingClientRect(), texto, grupos);
  }

  const fixos = [];
  for (const a of atomos.filter((a) => !a.naLista)) {
    if (a.top < status - TOL && a.bottom > 0) fixos.push(`"${a.texto}" embaixo da barra de status`);
    else if (a.bottom > B + TOL && a.top < altura) fixos.push(`"${a.texto}" embaixo do indicador de início`);
  }
  for (const a of atomos.filter((a) => a.cortadoDeLado)) fixos.push(`"${a.texto}" cortado de lado`);

  const naoAchados = mostrar.filter((m) => !atomos.some((a) => a.texto.includes(m)));
  for (const m of naoAchados) fixos.push(`"${m}" não está na tela`);

  if (!rolador) {
    const problemas = [...fixos];
    for (const m of mostrar) {
      const vistos = atomos.filter((a) => a.texto.includes(m));
      if (vistos.length && !vistos.some((a) => a.top >= status - TOL && a.bottom <= B + TOL)) {
        problemas.push(`"${m}" não está inteiro à vista`);
      }
    }
    return { ok: problemas.length === 0, de: 0, para: 0, problemas, antes: problemas };
  }

  // ------------------------------------------------------------- a lista
  const R = rolador.getBoundingClientRect();
  const W0 = R.top + rolador.clientTop;
  const Wfim = W0 + rolador.clientHeight;
  const W1 = Math.min(Wfim, B);
  const s0 = rolador.scrollTop;
  const maximo = rolador.scrollHeight - rolador.clientHeight;
  const daLista = atomos.filter((a) => a.naLista);

  const fundoDeTras = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const c = getComputedStyle(p).backgroundColor;
      if (!transparente(c)) return c;
    }
    return null;
  };
  const ehCaixa = (el, e) => {
    if (!transparente(e.backgroundColor) && e.backgroundColor !== fundoDeTras(el)) return true;
    if (e.boxShadow && e.boxShadow !== 'none') return true;
    return ['Top', 'Right', 'Bottom', 'Left'].some(
      (l) =>
        parseFloat(e[`border${l}Width`]) > 0 && e[`border${l}Style`] !== 'none' && !transparente(e[`border${l}Color`]),
    );
  };
  const caixas = [];
  for (const el of rolador.querySelectorAll('*')) {
    if (!visivel(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.height < 4 || r.width < 4 || r.height > W1 - W0) continue;
    if (!ehCaixa(el, getComputedStyle(el))) continue;
    const q = recortar(el.parentElement, r);
    if (!q) continue;
    const dentro = daLista.filter((a) => el === a.el || el.contains(a.el));
    const nome = dentro[0]?.texto ?? el.textContent.trim().slice(0, 30) ?? el.tagName;
    caixas.push({ top: r.top, bottom: r.bottom, dentro, nome });
  }

  // O que flutua por cima da lista sem ser dela (o botão +), pequeno e por cima de tudo.
  const flutuantes = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (rolador.contains(el) || el.contains(rolador)) continue;
    const e = getComputedStyle(el);
    if (!['absolute', 'fixed'].includes(e.position) || !visivel(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8 || r.width > 0.5 * R.width) continue;
    if (r.right <= R.left || r.left >= R.right || r.bottom <= W0 || r.top >= Wfim) continue;
    const meio = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    if (meio && (meio === el || el.contains(meio))) flutuantes.push(r);
  }

  const inteiro = (a, d) => a.top - d >= W0 - TOL && a.bottom - d <= W1 + TOL;
  const avaliar = (d) => {
    const problemas = [...fixos];
    for (const a of daLista) {
      const top = a.top - d;
      const bottom = a.bottom - d;
      if (bottom <= W0 + TOL || top >= Wfim - TOL) continue;
      if (top < W0 - TOL) problemas.push(`"${a.texto}" cortado em cima`);
      else if (bottom > W1 + TOL) {
        problemas.push(bottom > Wfim + TOL || W1 === Wfim ? `"${a.texto}" cortado embaixo` : `"${a.texto}" embaixo do indicador de início`);
      } else if (flutuantes.some((f) => a.right > f.left - 2 && a.left < f.right + 2 && bottom > f.top - 2 && top < f.bottom + 2)) {
        problemas.push(`"${a.texto}" embaixo do botão flutuante`);
      }
    }
    for (const c of caixas) {
      const top = c.top - d;
      const bottom = c.bottom - d;
      const folga = s0 + d > TOL ? FOLGA_EM_CIMA : 0;
      if (bottom <= W0 + TOL || top >= Wfim - TOL || (bottom <= W1 + TOL && top >= W0 + folga - TOL)) continue;
      if (top < W0 - TOL) problemas.push(`cartão "${c.nome}" cortado em cima`);
      else if (top < W0 + FOLGA_EM_CIMA - TOL && s0 + d > TOL) problemas.push(`cartão "${c.nome}" colado na borda de cima`);
      else if (bottom < Wfim - TOL) problemas.push(`cartão "${c.nome}" terminando embaixo do indicador de início`);
      // Continua além da borda (a lista seguindo): acima da faixa do indicador, só com algo
      // inteiro dentro; só na faixa, é a lista passando por baixo do indicador, como no iPhone.
      else if (top < W1 - TOL && !c.dentro.some((a) => inteiro(a, d))) problemas.push(`fatia do cartão "${c.nome}" embaixo`);
    }
    for (const m of mostrar) {
      const grupos = new Map();
      for (const a of atomos.filter((a) => a.texto.includes(m))) {
        const ok = !a.naLista || inteiro(a, d);
        grupos.set(a.grupo, (grupos.get(a.grupo) ?? true) && ok);
      }
      if (grupos.size && ![...grupos.values()].some(Boolean)) problemas.push(`"${m}" não está inteiro à vista`);
    }
    return problemas;
  };

  const antes = avaliar(0);
  if (!procurar || !antes.length || fixos.length) {
    return { ok: antes.length === 0, de: s0, para: s0, problemas: antes, antes };
  }
  let melhor = { s: s0, problemas: antes };
  // A cena escolhe a região da tela; aqui só se acerta a borda. Até uma tela de distância:
  // mais longe que isso a foto já seria outra (e a lista paginada carregaria mais linhas).
  for (let passo = 1; passo <= Math.min(maximo, rolador.clientHeight); passo += 1) {
    for (const destino of [s0 + passo, s0 - passo]) {
      if (destino < 0 || destino > maximo) continue;
      const problemas = avaliar(destino - s0);
      if (!problemas.length) {
        rolador.scrollTop = destino;
        return { ok: true, de: s0, para: destino, problemas: [], antes };
      }
      if (problemas.length < melhor.problemas.length) melhor = { s: destino, problemas };
    }
  }
  // Sem posição limpa: diz o que sobra na que chega mais perto, que é o que a cena tem de mudar.
  return {
    ok: false,
    de: s0,
    para: s0,
    problemas: [
      `a ${Math.round(melhor.s - s0)} pt de onde a cena deixou: ${melhor.problemas.join('; ')}`,
      `no topo da lista: ${avaliar(-s0).join('; ')}`,
      `no fim da lista: ${avaliar(maximo - s0).join('; ')}`,
    ],
    antes,
  };
}
