/**
 * Ponto de entrada: monta a moldura (barra lateral) e registra as telas.
 *
 * A moldura é redesenhada só quando o contexto muda (entrar/sair), nunca a cada navegação —
 * assim o menu não pisca e, no PDV, o cursor não escapa do campo do leitor.
 */

import { restaurarSessao, sair, definirTratadorDeSessaoPerdida } from './api.js';
import { iniciarRoteador, rota, ir, caminhoAtual } from './router.js';
import { limparCarrinho } from './store.js';
import { html, confirmar, cru, aviso } from './ui.js';

/* ------------------------------------------------------------------------- telas */

rota('/entrar', () => import('./views/entrar.js'));

rota('/pdv', () => import('./views/pdv.js'));
rota('/vendas', () => import('./views/vendas.js'));
rota('/vendas/:id', () => import('./views/venda-detalhe.js'));

rota('/produtos', () => import('./views/produtos.js'));
rota('/produtos/novo', () => import('./views/produto-novo.js'));
rota('/produtos/:id', () => import('./views/produto-detalhe.js'));
rota('/categorias', () => import('./views/categorias.js'), { papel: 'ADMIN' });

rota('/estoque', () => import('./views/estoque.js'));
rota('/estoque/entrada', () => import('./views/entrada.js'));
rota('/estoque/inventario', () => import('./views/inventario.js'), { papel: 'ADMIN' });
rota('/estoque/extrato', () => import('./views/extrato.js'));

rota('/caixa', () => import('./views/caixa.js'), { papel: 'ADMIN' });
rota('/despesas', () => import('./views/despesas.js'), { papel: 'ADMIN' });
rota('/relatorios', () => import('./views/relatorios.js'), { papel: 'ADMIN' });

rota('/usuarios', () => import('./views/usuarios.js'), { papel: 'ADMIN' });
rota('/conta', () => import('./views/conta.js'));

/* ------------------------------------------------------------------------ menu */

const MENU = [
  {
    grupo: 'Balcão',
    itens: [
      { href: '/pdv', icone: '🛒', texto: 'Vender (PDV)' },
      { href: '/vendas', icone: '🧾', texto: 'Vendas' },
    ],
  },
  {
    grupo: 'Catálogo',
    itens: [
      { href: '/produtos', icone: '👕', texto: 'Produtos' },
      { href: '/categorias', icone: '🏷️', texto: 'Categorias', admin: true },
    ],
  },
  {
    grupo: 'Estoque',
    itens: [
      { href: '/estoque', icone: '📦', texto: 'Saldos' },
      { href: '/estoque/entrada', icone: '📥', texto: 'Entrada' },
      { href: '/estoque/inventario', icone: '📋', texto: 'Inventário', admin: true },
      { href: '/estoque/extrato', icone: '📜', texto: 'Extrato' },
    ],
  },
  {
    grupo: 'Financeiro',
    admin: true,
    itens: [
      { href: '/caixa', icone: '💰', texto: 'Caixa do dia', admin: true },
      { href: '/despesas', icone: '💸', texto: 'Despesas', admin: true },
      { href: '/relatorios', icone: '📊', texto: 'Relatórios', admin: true },
    ],
  },
  {
    grupo: 'Sistema',
    itens: [
      { href: '/usuarios', icone: '👥', texto: 'Usuários', admin: true },
      { href: '/conta', icone: '⚙️', texto: 'Minha conta' },
    ],
  },
];

const iniciais = (nome) =>
  nome
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join('');

function menuHtml(usuario) {
  const admin = usuario.papel === 'ADMIN';
  return MENU.filter((g) => !g.admin || admin)
    .map((g) => {
      const itens = g.itens.filter((i) => !i.admin || admin);
      if (!itens.length) return '';
      return html`
        <div class="lateral__grupo">${g.grupo}</div>
        ${itens.map(
          (i) => html`
            <a class="lateral__item" href="#${cru(i.href)}" data-nav="${i.href}">
              <span class="lateral__icone" aria-hidden="true">${i.icone}</span>
              <span>${i.texto}</span>
            </a>
          `,
        )}
      `;
    })
    .join('');
}

function molduraHtml(usuario) {
  return html`
    <div class="aplicacao">
      <nav class="lateral" aria-label="Navegação principal">
        <div class="lateral__marca">
          <span class="lateral__logo" aria-hidden="true">👕</span>
          <span>
            <strong>Gestão da Loja</strong>
            <span>Estoque · PDV · Caixa</span>
          </span>
        </div>
        <div class="lateral__menu">${cru(menuHtml(usuario))}</div>
        <div class="lateral__rodape">
          <span class="lateral__avatar" aria-hidden="true">${iniciais(usuario.nome)}</span>
          <span class="lateral__quem">
            <strong title="${usuario.email}">${usuario.nome}</strong>
            <span>${usuario.papel === 'ADMIN' ? 'Dona da loja' : 'Vendedor(a)'}</span>
          </span>
          <button class="lateral__sair" data-sair title="Sair do sistema" aria-label="Sair do sistema">⏻</button>
        </div>
      </nav>
      <main class="conteudo" id="conteudo"></main>
    </div>
  `;
}

/* --------------------------------------------------------------------- moldura */

const raiz = document.getElementById('raiz');
let molduraAtual = null;

function marcarItemAtivo() {
  const atual = caminhoAtual();
  raiz.querySelectorAll('[data-nav]').forEach((a) => {
    const alvo = a.dataset.nav;
    // "/estoque" não pode ficar aceso em "/estoque/entrada": só o item mais específico.
    const ativo = atual === alvo || (alvo !== '/' && atual.startsWith(`${alvo}/`) && !temFilhoMaisEspecifico(atual, alvo));
    if (ativo) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

function temFilhoMaisEspecifico(atual, alvo) {
  return [...raiz.querySelectorAll('[data-nav]')].some((a) => {
    const outro = a.dataset.nav;
    return outro !== alvo && outro.startsWith(`${alvo}/`) && atual.startsWith(outro);
  });
}

/** Chamada pelo roteador antes de cada render: garante a moldura certa e devolve a área. */
function areaDeConteudo(caminho, usuario) {
  const desejada = usuario ? `app:${usuario.id}` : 'entrada';
  if (molduraAtual !== desejada) {
    molduraAtual = desejada;
    if (usuario) {
      raiz.innerHTML = molduraHtml(usuario);
      raiz.querySelector('[data-sair]').addEventListener('click', async () => {
        const confirmou = await confirmar({
          titulo: 'Sair do sistema',
          mensagem: `Encerrar a sessão de ${usuario.nome} neste computador?`,
          confirmarTexto: 'Sair',
        });
        if (!confirmou) return;
        // O carrinho é de quem estava vendendo: não pode sobrar para o próximo turno.
        limparCarrinho();
        await sair();
        ir('/entrar', true);
      });
    } else {
      raiz.innerHTML = '<div id="conteudo"></div>';
    }
  }
  return raiz.querySelector('#conteudo');
}

document.addEventListener('rota-trocada', marcarItemAtivo);

/* ------------------------------------------------------------------------ boot */

definirTratadorDeSessaoPerdida(() => {
  aviso('Sua sessão expirou. Entre de novo para continuar.', 'alerta');
});

iniciarRoteador(areaDeConteudo);
// Só depois de tentar reerguer a sessão pelo cookie o roteador sai do estado "carregando".
restaurarSessao();
