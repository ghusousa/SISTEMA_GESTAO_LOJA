/**
 * O guia em PDF para o revisor da Apple — os 7 itens da Guideline 2.1 por extenso, com os
 * prints — e a conferência de que o PDF commitado ainda é o destas entradas.
 *
 * O texto mora AQUI (em inglês: o revisor lê inglês; os rótulos das telas entre aspas, em
 * português, como aparecem no app). Quem imprime o PDF é gerar-guia.mjs (Playwright). O PDF
 * fica commitado ao lado (app-review-guide.pdf) e o publicador o anexa à revisão quando não há
 * gravação de tela: a Apple aceita UM anexo, e o vídeo vem primeiro (anexos.mjs). Por isso o
 * guia nunca diz que a gravação está anexada junto — quem diz onde ela está são as notas.
 *
 * Nada que muda por loja ou que é segredo entra no PDF (servidor, conta demo, senha, código
 * de barras): eles estão nas notas e em "Sign-in information". Entram: este arquivo, a lista
 * de aparelhos testados (ficha/aparelhos-testados.txt) e os prints de media/app-store/iphone-6.5.
 * A impressão digital dessas entradas fica em app-review-guide.entradas.json; mudou alguma,
 * o PDF está desatualizado — o teste (CI) e o publicador (--enviar) avisam.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { md5, NOME_DO_GUIA } from '../anexos.mjs';
import { lerAparelhosTestados } from '../ficha.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, '..', '..', '..');
export const PDF = join(AQUI, NOME_DO_GUIA);
export const IMPRESSAO = join(AQUI, 'app-review-guide.entradas.json');
const APARELHOS = join(AQUI, '..', 'ficha', 'aparelhos-testados.txt');
const PRINTS = join(RAIZ, 'media', 'app-store', 'iphone-6.5');

/** Legenda de cada print (pelo nome); print novo sem legenda aparece com o nome do arquivo. */
export const LEGENDAS = {
  '01-vender.png': 'Point of sale ("Vender"): items in the cart, the total and "Cobrar".',
  '02-cobrar.png': 'Payment ("Cobrar"): one sale split between PIX and a 3x credit card.',
  '03-financeiro.png': '"Financeiro": the month result — revenue, returns, cost, profit, expenses, card fees.',
  '04-relatorios.png': 'Reports: sales per day and the best sellers with their profit.',
  '05-estoque.png': 'Stock by size and color, with the restock ("repor") alert.',
  '06-produtos.png': 'Catalog ("Produtos"): price, sizes and stock of each item.',
  '07-caixa.png': 'Cash count ("Caixa"): expected vs. counted, per payment method.',
  '08-crediario.png': 'Store credit ("Crediário"): what a customer owes, bought and paid.',
  '09-condicional.png': 'Consignment ("Condicional"): what came back and what is charged.',
  '10-recibo.png': 'Receipt of a sale, shared from the iPhone (not a tax document).',
};

/** As entradas do guia, da raiz do repositório: este texto, os aparelhos e os prints. */
export function entradasDoGuia() {
  const prints = existsSync(PRINTS)
    ? readdirSync(PRINTS)
        .filter((n) => n.toLowerCase().endsWith('.png'))
        .sort()
        .map((n) => join(PRINTS, n))
    : [];
  return [fileURLToPath(import.meta.url), APARELHOS, ...prints];
}

/** sha256 de cada entrada (arquivo ausente = "ausente"), pelo caminho a partir da raiz. */
export function impressaoAtual() {
  const impressao = {};
  for (const caminho of entradasDoGuia()) {
    const chave = relative(RAIZ, caminho).split('\\').join('/');
    impressao[chave] = existsSync(caminho) ? createHash('sha256').update(readFileSync(caminho)).digest('hex') : 'ausente';
  }
  return impressao;
}

/** O que mudou desde que o PDF foi gerado ([] = o PDF é destas entradas). */
export function diferencas(gravada, atual = impressaoAtual()) {
  const motivos = [];
  for (const [arquivo, soma] of Object.entries(atual)) {
    if (!(arquivo in gravada)) motivos.push(`${arquivo} é novo`);
    else if (gravada[arquivo] !== soma) motivos.push(`${arquivo} mudou`);
  }
  for (const arquivo of Object.keys(gravada)) if (!(arquivo in atual)) motivos.push(`${arquivo} saiu`);
  return motivos;
}

/** O PDF commitado, pronto para anexar: { nome, dados, md5, desatualizado: [motivos] }. */
export function lerGuia() {
  if (!existsSync(PDF)) {
    throw new Error(`Não achei o guia do revisor (${relative(RAIZ, PDF)}). Gere com: node publicar/revisao/gerar-guia.mjs`);
  }
  const dados = readFileSync(PDF);
  if (dados.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error(`${relative(RAIZ, PDF)} não é um PDF.`);
  const gravada = existsSync(IMPRESSAO) ? JSON.parse(readFileSync(IMPRESSAO, 'utf8')).entradas ?? {} : {};
  const desatualizado = Object.keys(gravada).length ? diferencas(gravada) : ['sem app-review-guide.entradas.json'];
  return { nome: NOME_DO_GUIA, dados, md5: md5(dados), desatualizado };
}

/**
 * Os aparelhos testados, com a MESMA leitura (e a mesma recusa de linha torta) do publicador
 * — sempre o arquivo do repositório, nunca o PUBLICAR_APARELHOS do teste.
 */
export function aparelhosDoGuia() {
  return lerAparelhosTestados(APARELHOS);
}

export function printsDoGuia() {
  return entradasDoGuia()
    .filter((c) => c.startsWith(PRINTS))
    .map((caminho) => {
      const nome = caminho.slice(PRINTS.length + 1);
      return { nome, caminho, legenda: LEGENDAS[nome] ?? nome };
    });
}

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Caminho de toques, com os rótulos como aparecem no app ("Mais > Minha conta > ..."). */
const caminho = (texto) => `<span class="caminho">${esc(texto)}</span>`;
const rotulo = (texto) => `<span class="rotulo">"${esc(texto)}"</span>`;

/**
 * O HTML do guia. `prints`: [{ nome, legenda, src }] (src = data URL); `aparelhos`: as linhas
 * de ficha/aparelhos-testados.txt.
 */
export function montarHtml({ aparelhos = [], prints = [] } = {}) {
  // Só o que se sabe: o aparelho da gravação é a 1ª linha da lista; sem lista, as notas dizem.
  // Onde a gravação está, também: a Apple aceita UM anexo, e com este guia anexado ela não está.
  const gravacao = aparelhos.length
    ? `made on a physical ${esc(aparelhos[0])}; the App Review notes (item 1) say where it is`
    : 'made on a physical iPhone; the App Review notes (item 1) give the model, the iOS version and where it is';
  const listaDeAparelhos = aparelhos.length
    ? `<table class="tabela"><thead><tr><th>Physical device — iOS version</th></tr></thead><tbody>${aparelhos
        .map((a, i) => `<tr><td>${esc(a)}${i === 0 ? ' <em>(screen recording)</em>' : ''}</td></tr>`)
        .join('')}</tbody></table>`
    : '<p class="pendente">The list of physical devices and iOS versions is in the App Review notes (item 2).</p>';
  const galeria = prints
    .map(
      (p) => `<figure><img src="${p.src}" alt="${esc(p.legenda)}"><figcaption>${esc(p.legenda)}</figcaption></figure>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Gestão de Loja — App Review guide</title>
<style>
  @page { size: A4; }
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; font: 400 9.6pt/1.45 'Inter', 'Helvetica Neue', Arial, sans-serif; color: #1b2430; }
  header { background: #1e3a5f; color: #fff; border-radius: 10px; padding: 16px 20px 15px; margin-bottom: 14px; }
  header h1 { margin: 0 0 3px; font: 800 19pt/1.15 'Inter Display', 'Inter', sans-serif; letter-spacing: -0.01em; }
  header p { margin: 0; color: #d6e2f0; font-size: 10pt; }
  .intro { font-size: 10pt; margin: 0 0 10px; }
  h2 { font: 700 12pt/1.25 'Inter Display', 'Inter', sans-serif; color: #1e3a5f; margin: 15px 0 5px;
       padding-bottom: 3px; border-bottom: 1.5px solid #d9e2ec; break-after: avoid; }
  h2 .n { display: inline-block; min-width: 1.6em; color: #2f6fb3; }
  h3 { font: 700 10pt/1.3 'Inter', sans-serif; margin: 9px 0 3px; break-after: avoid; }
  p { margin: 0 0 6px; }
  ul, ol { margin: 0 0 7px; padding-left: 17px; }
  li { margin: 0 0 2.5px; }
  section { break-inside: avoid-page; }
  .caminho { font-weight: 600; color: #12355c; background: #eef3f9; border-radius: 4px; padding: 0 4px; white-space: nowrap; }
  .rotulo { font-weight: 600; color: #12355c; }
  .nota { background: #fff8e6; border-left: 3px solid #e0a100; padding: 6px 9px; border-radius: 0 6px 6px 0; margin: 6px 0 8px; }
  .pendente { color: #8a5a00; font-style: italic; }
  .tabela { border-collapse: collapse; width: 100%; margin: 4px 0 8px; font-size: 9.2pt; }
  .tabela th, .tabela td { border: 1px solid #d9e2ec; padding: 4px 7px; text-align: left; vertical-align: top; }
  .tabela th { background: #f2f6fa; font-weight: 700; }
  .duas { display: grid; grid-template-columns: 1fr 1fr; gap: 0 18px; }
  .galeria { display: grid; grid-template-columns: repeat(5, 1fr); gap: 9px 8px; margin-top: 8px; }
  figure { margin: 0; break-inside: avoid; }
  figure img { width: 100%; border-radius: 6px; border: 1px solid #d9e2ec; display: block; }
  figcaption { font-size: 7.4pt; line-height: 1.3; color: #4a5868; margin-top: 3px; }
  .quebra { break-before: page; }
</style>
</head>
<body>
<header>
  <h1>Gestão de Loja — guide for App Review</h1>
  <p>Answers to Guideline 2.1 – Information Needed · iPhone app, Portuguese (Brazil)</p>
</header>
<p class="intro">Gestão de Loja is the iPhone client of a point-of-sale and stock system that each shop runs on
<b>its own server</b>. The app is the same for every shop and asks for the server address on first use. This guide
answers the seven questions of the App Review message in full. The demo server address, the demo account and a
sample barcode are in the App Review notes and in Sign-in information.</p>

<section>
<h2><span class="n">1</span>Screen recording on a physical device</h2>
<p>The screen recording was ${gravacao}. It starts when the app is opened and follows the steps of section 4:</p>
<ul>
  <li>connecting the app to the shop's server (${rotulo('Conectar à loja')}) and signing in;</li>
  <li>the <b>camera permission</b> prompt, when the barcode reader is opened for the first time;</li>
  <li>a sale: an item added by its barcode, the payment and the receipt;</li>
  <li><b>account registration</b>: there is no sign-up — the owner creates a staff account in ${caminho('Mais > Usuários > "+"')}
    (the round button at the bottom right);</li>
  <li><b>account deletion</b>, both ways: the owner deletes a staff account
    (${caminho('Mais > Usuários > (pessoa) > Excluir conta')}) and a staff member deletes their own account
    (${caminho('Mais > Minha conta > Excluir minha conta')}).</li>
</ul>
<p>There is no paid content and no content shared between users (section 8).</p>
</section>

<section>
<h2><span class="n">2</span>Devices and iOS versions tested</h2>
${listaDeAparelhos}
<p>Minimum iOS 15.1 (React Native 0.81). iPhone only (no iPad layout), portrait.</p>
</section>

<section>
<h2><span class="n">3</span>What the app does, for whom, and why</h2>
<p><b>Audience.</b> Owners and staff of small brick-and-mortar shops in Brazil — clothing, shoes, auto parts,
electronics, cosmetics, food, building materials — using the app at the counter. It is a work tool, not a consumer app:
the shop's customers never use it.</p>
<p><b>Problem.</b> In a small shop, sales, stock and money live in a paper notebook, a spreadsheet and the card
terminal's statement. The owner does not know the real profit, what to restock, or who owes the shop.</p>
<p><b>What it does.</b> Barcode point of sale (iPhone camera, or a USB reader on the shop's computer); payment in cash,
PIX, debit, credit in installments, store credit ("fiado") and exchange voucher, split in one sale; returns and
exchanges; consignment ("condicional"); stock by size and color with restock alerts; purchase entries with supplier and
cost; inventory count; daily cash count; expenses, profit and margin; reports (best sellers, ABC curve, sales and
commission per salesperson, slow stock, stock value); customers and birthdays; receipts shared from the iPhone; an
optional NFC-e. Phones and computers of the same shop stay in sync in real time, and the phone can be the computer's
barcode reader.</p>
<p><b>Who sees what.</b> Owner, manager, supervisor and salesperson. A salesperson never receives cost, profit or
expenses — the server filters them, not the screen. The audit log (who did what) is for the owner only.</p>
<p><b>Value.</b> One system from the counter to the month's result, with the shop's data on the shop's own server.</p>
</section>

<section>
<h2><span class="n">4</span>How to set up and access the main features</h2>
<p>Each shop installs the server once (Docker on its own computer, or a cloud server). For the review we run a demo
shop with fictitious data only; its address, the owner account and a sample barcode are in the notes.</p>
<ol>
  <li>Open the app. On the sign-in screen tap the <b>gear</b> (top right): ${rotulo('Conectar à loja')} opens.</li>
  <li>In ${rotulo('Endereço do servidor')} type the demo server address exactly as in the notes (with <b>https://</b>), and
    tap ${rotulo('Conectar')}.</li>
  <li>Type the e-mail and password of the demo account and tap ${rotulo('Entrar')}. The ${rotulo('Vender')} tab
    (point of sale) opens. The demo account is the shop owner: every screen is visible.</li>
  <li>Add an item: ${rotulo('Ler código de barras')} (camera), ${rotulo('Digitar código')} (type the sample barcode)
    or ${rotulo('Buscar')} (part of an item name, e.g. "cami").</li>
  <li>Tap ${rotulo('Cobrar')}, choose ${rotulo('Dinheiro')} (or split between methods) and tap
    ${rotulo('Confirmar venda')}. The completed sale opens; ${rotulo('Recibo para a cliente')} shows the receipt.</li>
</ol>
<table class="tabela">
  <thead><tr><th style="width:24%">Where</th><th>Main features</th></tr></thead>
  <tbody>
    <tr><td>${rotulo('Vender')}</td><td>Point of sale, payment, receipt.</td></tr>
    <tr><td>${rotulo('Produtos')}</td><td>Catalog with sizes, colors, prices and item photos.</td></tr>
    <tr><td>${rotulo('Estoque')}</td><td>Stock by size and color, purchase entry ("Entrada"), stock history, adjustment and
      inventory count.</td></tr>
    <tr><td>${rotulo('Financeiro')}</td><td>Month result, expenses, reports, cash count ("Caixa") and bills to pay.</td></tr>
    <tr><td>${rotulo('Mais')}</td><td>Sales history and cancellation, returns, consignment, store credit, birthdays, card
      fees, categories, users ("Usuários"), audit log, cloud backup, shop settings, the phone as barcode reader
      ("Leitor do computador") and "Minha conta".</td></tr>
  </tbody>
</table>
<h3>Phone as the computer's barcode reader</h3>
<ol>
  <li>Open the server address in a computer browser and sign in with the <b>same account</b> as the app. The sale
    screen (${rotulo('Vender (PDV)')}) opens.</li>
  <li>Click ${rotulo('Abrir no app o leitor de código')}, above the barcode field. The computer shows
    "Chamando o leitor no seu celular…" and a 3-character code, e.g. "Sinal 7K3".</li>
  <li>With the app <b>open</b> on the iPhone, on any screen, the banner ${rotulo('O computador está chamando')} comes
    down with the same code: tap ${rotulo('Abrir o leitor')}. The camera opens (the first time, iOS asks for the
    camera) and the computer shows "Celular de … ligado".</li>
  <li>Each label the camera scans appears on the computer's open sale. The code tells apart two computers signed in
    with the same account: open the call with the code your computer shows.</li>
</ol>
<p><b>QR instead</b> (another person's phone, for example): ${rotulo('Celular de outra pessoa? Ler o QR')}, next to the
button, or ${rotulo('Celular como leitor')}, in the left bar, shows a QR code; in the app:
${caminho('Mais > Leitor do computador > "Ler o QR do computador"')}.</p>
<p class="nota"><b>Notifications are optional</b>, and off unless the shop's server turns them on. When on, the
barcode reader flow asks for the notification permission (when the person taps ${rotulo('Abrir o leitor')} or opens
${rotulo('Leitor do computador')}, never at launch), and the call also reaches the phone with the app closed: a
notification with the same code, which opens the camera. When off, nothing asks for it, and the call reaches the
open app as above.</p>
</section>

<section>
<h2><span class="n">5</span>External services</h2>
<table class="tabela">
  <thead><tr><th style="width:26%">Purpose</th><th>Service</th></tr></thead>
  <tbody>
    <tr><td>Data and sign-in</td><td>Only the shop's own server: FastAPI + PostgreSQL, installed and run by the shop.
      Every sale, item, photo and login goes to that server and to no other.</td></tr>
    <tr><td>Connectivity check</td><td>The network-status library of React Native (NetInfo) checks whether the phone is
      online with an empty request to Google's <i>generate_204</i> address. It carries no user or shop data.</td></tr>
    <tr><td>Demo server (review)</td><td>A demo shop with fictitious data only, isolated from any real shop: its own
      database, accounts and item photos.</td></tr>
    <tr><td>NFC-e (optional)</td><td>Brazil's electronic consumer receipt, issued through an accredited issuer (Focus NFe)
      that the shop hires and connects to its server. Off in the demo.</td></tr>
    <tr><td>Push notifications (optional)</td><td>Off unless the shop's server turns them on. Then the app gets a push
      token from Expo's push service (device token and app installation id) and gives it to the shop's server, which
      sends only the computer's call through Expo and Apple (APNs): a fixed text and a random 3-character code, no shop
      or customer data.</td></tr>
    <tr><td>Payments</td><td>None in the app. The card terminal is a separate device; the app only records how the
      customer paid and the amount.</td></tr>
    <tr><td>AI, third-party sign-in, analytics, ads</td><td>None. No tracking, no IDFA, so no ATT prompt.</td></tr>
  </tbody>
</table>
</section>

<section>
<h2><span class="n">6</span>Regional differences</h2>
<p>None. The app is offered in Brazil only, in Portuguese (Brazil), and works the same way everywhere.</p>
</section>

<section>
<h2><span class="n">7</span>Regulated industry and third-party content</h2>
<p>The app is not in a regulated industry (no health, financial services, gambling or similar): it records a shop's
own sales and stock, and it does not move money. It shows no third-party protected content. The optional NFC-e is a
Brazilian tax receipt issued by the accredited issuer with the shop's own digital certificate; the shop decides to turn
it on.</p>
</section>

<section>
<h2><span class="n">8</span>Accounts, user content, permissions and purchases</h2>
<h3>Account registration</h3>
<p>There is no sign-up in the app. The owner (or a manager) creates staff accounts in
${caminho('Mais > Usuários > "+"')} (the round button at the bottom right).</p>
<h3>Account deletion (Guideline 5.1.1(v))</h3>
<ul>
  <li><b>Any user, their own account:</b> ${caminho('Mais > Minha conta > Excluir minha conta')}. The screen lists what is
    deleted and what stays, asks for the password and confirms. The sign-in screen then shows
    ${rotulo('Conta excluída')}.</li>
  <li><b>The owner, a staff account:</b> ${caminho('Mais > Usuários > (pessoa) > Excluir conta')} — "pessoa" is the
    person's card — with a confirmation. "Desativar" also exists, for a temporary leave.</li>
  <li><b>Deleted:</b> the login (e-mail and password), the sessions on every device, a phone paired as barcode reader
    and its registration for notifications, and the e-mail in the shop's log (masked). <b>Kept:</b> the sales, returns, stock entries and cash counts the person
    registered, with their name — they are the shop's bookkeeping.</li>
  <li>The shop's only owner cannot delete their own account: the app asks to pass the owner role to someone else
    first (${caminho('Mais > Usuários > (pessoa) > Mudar papel')}). The demo account itself is protected on the demo
    server (it cannot be deleted, demoted or have its password changed), so the next reviewer can still sign in:
    please create a staff account and delete it either way.</li>
</ul>
<h3>User-generated content</h3>
<p>Item names, photos and notes stay on one shop's server, visible only to that shop's team. There is no publishing,
feed, comments or messaging between users, so there is nothing to report or block.</p>
<h3>Permissions</h3>
<ul>
  <li><b>Camera:</b> the barcode reader, and a photo of an item.</li>
  <li><b>Photos:</b> to pick an item photo.</li>
  <li><b>Local network:</b> only when the shop's server is on the shop's own network.</li>
  <li><b>Notifications (optional):</b> only the computer's call to open the barcode reader, and only when the shop's
    server turns them on (section 4); never asked at launch.</li>
</ul>
<h3>Purchases</h3>
<p>No in-app purchases and no digital goods: the goods are physical and paid at the counter.</p>
</section>

<section class="quebra">
<h2><span class="n">9</span>Screenshots</h2>
<p>The App Store screenshots, made from the app's own screens with the demo data.</p>
<div class="galeria">${galeria}</div>
</section>
</body>
</html>
`;
}
