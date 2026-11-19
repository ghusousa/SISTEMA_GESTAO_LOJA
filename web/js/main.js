/**
 * Ponto de entrada: monta a moldura (barra lateral) e registra as telas.
 *
 * A moldura é redesenhada só quando o contexto muda (entrar/sair), nunca a cada navegação —
 * assim o menu não pisca e, no PDV, o cursor não escapa do campo do leitor.
 */

import { api, restaurarSessao, sair, definirTratadorDeSessaoPerdida } from './api.js';
import { iniciarRoteador, rota, ir, caminhoAtual } from './router.js';
import { limparTudoDaSessao, sessao } from './store.js';
import { PODE, pode, titulo } from './permissoes.js';
import { conectarTempoReal, desconectarTempoReal } from './tempo-real.js';
import { html, confirmar, cru, aviso } from './ui.js';
import { carregarLoja, loja, aoMudarLoja } from './loja.js';
import { ligarFaixaDaDemonstracao } from './faixa-demonstracao.js';
import { naRaiz } from './raiz.js';
import { desligarLeitorCelular, ligarLeitorCelular, pararLeitorCelular } from './leitor-celular.js';

/* ------------------------------------------------------------------------- telas */

rota('/entrar', () => import('./views/entrar.js'));

rota('/pdv', () => import('./views/pdv.js'));
rota('/vendas', () => import('./views/vendas.js'));
// Antes de '/vendas/:id': ':id' casaria com 'devolucao' como se fosse um número.
rota('/vendas/devolucao', () => import('./views/devolucao.js'), { pode: PODE.DEVOLVER_VENDA });
rota('/vendas/:id/recibo', () => import('./views/recibo.js'));
rota('/vendas/:id', () => import('./views/venda-detalhe.js'));
rota('/condicionais', () => import('./views/condicionais.js'), { pode: PODE.FAZER_CONDICIONAL });
// Antes de '/condicionais/:id', pelo mesmo motivo de '/vendas/devolucao'.
rota('/condicionais/nova', () => import('./views/condicionais-nova.js'), { pode: PODE.FAZER_CONDICIONAL });
rota('/condicionais/:id', () => import('./views/condicionais-detalhe.js'), { pode: PODE.FAZER_CONDICIONAL });

rota('/produtos', () => import('./views/produtos.js'));
rota('/produtos/novo', () => import('./views/produto-novo.js'));
// Antes de '/produtos/:id': o roteador casa a primeira rota que bate, e ':id' aceitaria
// 'etiquetas' como se fosse um id.
rota('/produtos/:id/etiquetas', () => import('./views/etiquetas.js'));
rota('/produtos/:id', () => import('./views/produto-detalhe.js'));
// Sem produto no caminho: a folha do que ACABOU de entrar, que mistura produtos e usa a
// quantidade que chegou em vez do saldo.
rota('/etiquetas', () => import('./views/etiquetas.js'));
rota('/categorias', () => import('./views/categorias.js'), { pode: PODE.EDITAR_CATALOGO });

rota('/estoque', () => import('./views/estoque.js'));
rota('/estoque/entrada', () => import('./views/entrada.js'));
rota('/estoque/inventario', () => import('./views/inventario.js'), { pode: PODE.CORRIGIR_ESTOQUE });
rota('/estoque/extrato', () => import('./views/extrato.js'));

rota('/caixa', () => import('./views/caixa.js'), { pode: PODE.FECHAR_CAIXA });
rota('/despesas', () => import('./views/despesas.js'), { pode: PODE.LANCAR_DESPESA });
rota('/relatorios', () => import('./views/relatorios.js'), { pode: PODE.VER_DINHEIRO });
rota('/taxas', () => import('./views/taxas.js'), { pode: PODE.VER_DINHEIRO });
rota('/contas-pagar', () => import('./views/contas-pagar.js'), { pode: PODE.VER_DINHEIRO });

rota('/clientes', () => import('./views/clientes.js'), { pode: PODE.GERIR_CREDIARIO });
rota('/aniversariantes', () => import('./views/aniversariantes.js'), { pode: PODE.ATENDER_CLIENTE });
rota('/usuarios', () => import('./views/usuarios.js'), { pode: PODE.GERIR_USUARIOS });
rota('/auditoria', () => import('./views/auditoria.js'), { pode: PODE.VER_AUDITORIA });
rota('/configuracao', () => import('./views/configuracao.js'), { pode: PODE.CONFIGURAR_LOJA });
rota('/backup', () => import('./views/backup.js'), { pode: PODE.GERIR_BACKUP });
rota('/conta', () => import('./views/conta.js'));

/* ------------------------------------------------------------------------ menu */

const MENU = [
  {
    grupo: 'Balcão',
    itens: [
      { href: '/pdv', icone: '🛒', texto: 'Vender (PDV)' },
      { href: '/vendas', icone: '🧾', texto: 'Vendas' },
      { href: '/vendas/devolucao', icone: '↩️', texto: 'Devolução', pode: PODE.DEVOLVER_VENDA },
      { href: '/aniversariantes', icone: '🎂', texto: 'Aniversariantes', pode: PODE.ATENDER_CLIENTE },
      { href: '/condicionais', icone: '🛍️', texto: 'Condicional', pode: PODE.FAZER_CONDICIONAL },
    ],
  },
  {
    grupo: 'Catálogo',
    itens: [
      { href: '/produtos', icone: '👕', texto: 'Produtos' },
      { href: '/categorias', icone: '🏷️', texto: 'Categorias', pode: PODE.EDITAR_CATALOGO },
    ],
  },
  {
    grupo: 'Estoque',
    itens: [
      { href: '/estoque', icone: '📦', texto: 'Saldos' },
      { href: '/estoque/entrada', icone: '📥', texto: 'Entrada' },
      { href: '/estoque/inventario', icone: '📋', texto: 'Inventário', pode: PODE.CORRIGIR_ESTOQUE },
      { href: '/estoque/extrato', icone: '📜', texto: 'Extrato' },
    ],
  },
  {
    grupo: 'Financeiro',
    itens: [
      { href: '/caixa', icone: '💰', texto: 'Caixa do dia', pode: PODE.FECHAR_CAIXA },
      { href: '/despesas', icone: '💸', texto: 'Despesas', pode: PODE.LANCAR_DESPESA },
      { href: '/contas-pagar', icone: '📅', texto: 'Contas a pagar', pode: PODE.VER_DINHEIRO },
      { href: '/relatorios', icone: '📊', texto: 'Relatórios', pode: PODE.VER_DINHEIRO },
      { href: '/taxas', icone: '💳', texto: 'Taxas do cartão', pode: PODE.VER_DINHEIRO },
      { href: '/clientes', icone: '🤝', texto: 'Crediário', pode: PODE.GERIR_CREDIARIO },
    ],
  },
  {
    grupo: 'Sistema',
    itens: [
      { href: '/usuarios', icone: '👥', texto: 'Usuários', pode: PODE.GERIR_USUARIOS },
      { href: '/auditoria', icone: '🔎', texto: 'Auditoria', pode: PODE.VER_AUDITORIA },
      { href: '/configuracao', icone: '🏪', texto: 'A loja', pode: PODE.CONFIGURAR_LOJA },
      { href: '/backup', icone: '☁️', texto: 'Backup', pode: PODE.GERIR_BACKUP },
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

function menuHtml() {
  // Grupo sem nenhum item permitido simplesmente não é desenhado — nada de título de
  // seção pairando sozinho sobre o vazio.
  return MENU.map((g) => {
      const itens = g.itens.filter((i) => !i.pode || pode(i.pode));
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
          <strong data-nome-loja>${loja().nome}</strong>
          <span>Estoque · PDV · Caixa</span>
        </div>
        <div class="lateral__menu">${cru(menuHtml())}</div>
        <div class="lateral__rodape">
          <button class="lateral__leitor" type="button" data-leitor-celular
            title="Use a câmera do celular como leitor de código de barras deste computador">
            <span aria-hidden="true">📱</span><span>Celular como leitor</span>
          </button>
          <button class="lateral__leitor is-ativo" type="button" data-leitor-selo hidden
            title="O celular está lendo para este computador. Clique para desligar.">
            <span class="lateral__versao-ponto" aria-hidden="true"></span>
            <span aria-hidden="true">📱</span><span data-leitor-nome></span>
          </button>
          <div class="lateral__quem-linha">
            <span class="lateral__avatar" aria-hidden="true">${iniciais(usuario.nome)}</span>
            <span class="lateral__quem">
              <strong title="${usuario.email}">${usuario.nome}</strong>
              <span>${titulo(usuario.papel)}</span>
            </span>
            <button class="lateral__sair" data-sair title="Sair do sistema" aria-label="Sair do sistema">⏻</button>
          </div>
          <div class="lateral__versao" data-versao hidden></div>
          <a class="lateral__versao is-atencao" data-backup href="#/backup" style="text-decoration:none;color:inherit" hidden></a>
          <a class="lateral__versao is-atencao" data-contas href="#/contas-pagar" style="text-decoration:none;color:inherit" hidden></a>
          <a class="lateral__privacidade" href="${naRaiz('/privacidade')}" target="_blank" rel="noopener">Privacidade</a>
        </div>
      </nav>
      <main class="conteudo" id="conteudo"></main>
    </div>
  `;
}

/** "há 4 min", "há 3 dias" — o quanto dá para confiar no selo ao lado. */
function desdeQuando(iso) {
  if (!iso) return 'nunca conferido';
  const minutos = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutos < 60) return `há ${minutos} min`;
  const horas = Math.round(minutos / 60);
  if (horas < 48) return `há ${horas} h`;
  return `há ${Math.round(horas / 24)} dias`;
}

/**
 * "Estou na versão mais nova?" — respondido na barra, sem ninguém precisar perguntar.
 *
 * Mostrar só o hash não ajudaria: `5c31d04` não é maior nem menor que o de ontem. Quem
 * decide é o servidor (`GET /versao`), que sabe quando foi a última conferida com o GitHub
 * e se ela achou coisa nova. Aqui só se pinta a resposta — verde quando está em dia,
 * amarelo quando há versão esperando ou quando faz tempo demais que ninguém confere.
 */
async function pintarVersao(raizMoldura) {
  const area = raizMoldura.querySelector('[data-versao]');
  if (!area) return;
  try {
    const v = await api.get('/versao');
    const emDia = v.atualizada === true && v.conferido_recente;
    area.hidden = false;
    area.className = `lateral__versao ${emDia ? 'is-ok' : 'is-atencao'}`;
    area.title = v.resumo;
    // A barra tem 236px: a frase inteira cortaria no meio ("Está na versão mai…"), que é
    // pior do que não mostrar. O veredito cabe numa palavra, o detalhe vira o tempo desde
    // a última conferida, e a frase inteira fica no title, para quem passar o mouse.
    area.innerHTML = html`
      <span class="lateral__versao-ponto" aria-hidden="true"></span>
      <span>
        <strong>${emDia ? 'Versão em dia' : 'Versão desatualizada'}</strong>
        <span>${v.commit || 'sem versão'} · ${desdeQuando(v.conferido_em)}</span>
      </span>
    `;
  } catch {
    // Barra lateral não é lugar de dar erro: sem resposta, o selo simplesmente não aparece.
    area.hidden = true;
  }
}

/**
 * "O backup parou?" — para o dono, na mesma barra e no mesmo desenho do selo de versão,
 * mas só quando há problema: o backup em dia não precisa ocupar a barra de ninguém.
 * Quem decide o atraso é o servidor (`atrasado`: ligado e sem cópia nova há mais de 2× o
 * intervalo). Sem isto, a cópia parada só aparecia para quem abrisse a tela do backup —
 * isto é, no dia em que precisasse dela.
 */
let backupPintadoEm = 0;
async function pintarBackup(raizMoldura) {
  const area = raizMoldura.querySelector('[data-backup]');
  if (!area || !pode(PODE.GERIR_BACKUP)) return;
  backupPintadoEm = Date.now();
  try {
    const b = await api.get('/backup');
    const falhou = b.ativo && b.ultimo_ok === false;
    area.hidden = !(b.atrasado || falhou);
    if (area.hidden) return;
    area.title = 'Abrir a tela do backup';
    area.innerHTML = html`
      <span class="lateral__versao-ponto" aria-hidden="true"></span>
      <span>
        <strong>${falhou ? 'Backup falhou' : 'Backup atrasado'}</strong>
        <span>última cópia ${b.ultimo_em ? desdeQuando(b.ultimo_em) : 'nunca'}</span>
      </span>
    `;
  } catch {
    area.hidden = true;
  }
}

/**
 * "Tem boleto vencendo?" — para quem vê dinheiro, no mesmo desenho dos outros selos, e só
 * quando há o que pagar: vencida ou vencendo nos próximos 7 dias (`/contas-pagar/resumo`,
 * ADR-40). Sem isto o boleto da coleção só aparecia para quem abrisse Contas a pagar.
 */
let contasPintadasEm = 0;
async function pintarContas(raizMoldura) {
  const area = raizMoldura.querySelector('[data-contas]');
  if (!area || !pode(PODE.VER_DINHEIRO)) return;
  contasPintadasEm = Date.now();
  try {
    const r = await api.get('/contas-pagar/resumo');
    const qtd = r.vencidas.quantidade + r.proximos_7_dias.quantidade;
    area.hidden = qtd === 0;
    if (area.hidden) return;
    area.title = 'Abrir Contas a pagar';
    area.innerHTML = html`
      <span class="lateral__versao-ponto" aria-hidden="true"></span>
      <span>
        <strong>${r.vencidas.quantidade ? 'Conta vencida' : 'Contas da semana'}</strong>
        <span>${qtd} a pagar até 7 dias</span>
      </span>
    `;
  } catch {
    area.hidden = true;
  }
}

// O PDV fica aberto o dia inteiro: o selo se refaz na navegação, no máximo a cada 5 min.
document.addEventListener('rota-trocada', () => {
  if (Date.now() - backupPintadoEm > 5 * 60_000) void pintarBackup(raiz);
  if (Date.now() - contasPintadasEm > 5 * 60_000) void pintarContas(raiz);
});

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
      void pintarVersao(raiz);
      void pintarBackup(raiz);
      void pintarContas(raiz);
      ligarLeitorCelular(raiz);
      raiz.querySelector('[data-sair]').addEventListener('click', async () => {
        const confirmou = await confirmar({
          titulo: 'Sair do sistema',
          mensagem: `Encerrar a sessão de ${usuario.nome} neste computador?`,
          confirmarTexto: 'Sair',
        });
        if (!confirmou) return;
        // O celular-leitor desliga no servidor enquanto ainda há sessão para isso.
        await desligarLeitorCelular();
        // Carrinho e conferência são de quem estava trabalhando: não podem sobrar para o
        // próximo turno — a venda e a sacola do turno anterior entrariam no nome de outra
        // pessoa.
        limparTudoDaSessao();
        desconectarTempoReal();
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
  // Mesma limpeza do botão Sair. A sessão que cai (refresh vencido, conta desativada,
  // família revogada) leva para a tela de entrada, e quem entra depois no mesmo navegador
  // herdaria o carrinho — com o client_uuid — e a conferência de quem estava antes: a
  // venda e a entrada sairiam no nome da pessoa errada.
  limparTudoDaSessao();
  desconectarTempoReal();
  // Sem token não dá para desligar no servidor. A aba guarda o id: se a mesma pessoa
  // entrar de novo, o leitor volta; se for outra, o servidor responde 404 e ele some.
  pararLeitorCelular({ esquecerAba: false });
  aviso('Sua sessão expirou. Entre de novo para continuar.', 'alerta');
});

// O canal acompanha a sessão: nasce com ela e morre com ela, sem cada tela ter de saber
// que ele existe.
sessao.inscrever(({ usuario }) => {
  if (usuario) conectarTempoReal();
  else desconectarTempoReal();
});

// O nome da loja é lido sem sessão: a tela de entrada já abre com ele. Não esperamos a
// resposta para iniciar o roteador — a loja sem nome é um detalhe, a loja sem PDV não é.
// Na mesma leitura vem se esta é a demonstração (ADR-46), que ganha a faixa no topo.
ligarFaixaDaDemonstracao();
carregarLoja();
aoMudarLoja((config) => {
  document.querySelectorAll('[data-nome-loja]').forEach((el) => {
    el.textContent = config.nome;
  });
});

iniciarRoteador(areaDeConteudo);
// Só depois de tentar reerguer a sessão pelo cookie o roteador sai do estado "carregando".
restaurarSessao();
