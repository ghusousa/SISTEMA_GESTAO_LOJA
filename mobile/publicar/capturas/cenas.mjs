/**
 * As 10 capturas da App Store: o que cada uma vende e como a tela chega lá.
 *
 * Cada cena prepara a tela do jeito que uma pessoa faria no balcão — bipa (pelo "Digitar
 * código"), busca pelo nome, cobra, abre a condicional — e só então a foto sai. Nada é
 * desenhado por fora: o que aparece no celular da arte é o app de verdade, com os dados de
 * mentira do `api/scripts/seed_demo.py` (a mesma "Loja Tria" do servidor de demonstração).
 *
 * Os textos têm de ser VERDADE no app: cada título e subtítulo foi conferido na tela que a
 * cena fotografa. Sem preço, sem "grátis", sem citar outra plataforma. O título tem sempre
 * duas linhas (o `\n`) e o subtítulo, uma — `compor.mjs` recusa a arte se não couber.
 *
 * `mostrar` é o que tem de sair INTEIRO na foto. Depois do `preparar`, o enquadramento
 * (`quadro.mjs`) rola a lista o mínimo para isso e para nada sair cortado nas bordas; se não
 * houver posição assim, a cena para dizendo o que cortou — e o ajuste é aqui.
 *
 * `ROTEIRO` é a ordem em que as cenas são FOTOGRAFADAS, que não é a ordem da loja: o fiado
 * e a condicional acontecem antes, para o caixa e o financeiro já contarem com eles, e a
 * venda do PDV atravessa três cenas (carrinho → cobrança → recibo).
 */

/** O que a dona faz uma vez, antes de tudo: as taxas da maquininha (Mais → Taxas do cartão). */
export async function prepararLoja(app) {
  await app.aba('Mais');
  await app.tocar('Taxas do cartão');
  await app.esperarTexto('Nova taxa');
  // Crédito de 1x a 12x a 4,99%, caindo em 30 dias: o "Até" sobe de um em um, como na tela.
  for (let vez = 1; vez < 12; vez += 1) {
    await app.page.getByText('+', { exact: true }).filter({ visible: true }).nth(1).click();
  }
  await app.esperarTexto('12x');
  await app.digitar('3,19', '4,99');
  await app.botao('Salvar');
  await app.esperarTexto('Crédito 1x a 12x');
  // Débito a 1,99%, no dia seguinte.
  await app.tocar('Débito');
  await app.digitar('3,19', '1,99');
  await app.botao('Salvar');
  await app.esperarTexto('Débito 1x');
}

/**
 * Fiado no balcão para as três clientes da seed. A Marizete leva duas peças e passa do
 * limite combinado com ela (R$ 300) — continua acima mesmo depois de pagar uma parte.
 */
const FIADO = [
  { cliente: 'Cleide Ramos', pecas: ['Vestido Midi Floral'] },
  { cliente: 'Marizete Alves', pecas: ['Calça Alfaiataria', 'Blusa de Tricô'] },
  { cliente: 'Sônia Barbosa', pecas: ['Saia Midi Plissada'] },
];

export const CENAS = [
  {
    arquivo: '01-vender',
    titulo: 'Venda feita\nem segundos',
    subtitulo: 'Bipe a etiqueta ou busque pelo nome',
    tela: 'PDV com quatro peças no carrinho (o vestido pelo "Digitar código", as outras pela busca por nome), o total e o Cobrar',
    mostrar: ['4 peças', 'Total', 'Cobrar'],
    async preparar(app) {
      await app.aba('Vender');
      const vestido = await app.peca('Vestido Longo Festa');
      await app.digitarCodigo(vestido.codigo_barras);
      await app.esperarTexto(vestido.produto);
      for (const nome of ['Blusa de Tricô', 'Calça Jeans Skinny', 'Saia Midi Plissada']) {
        await app.buscarPeca(await app.peca(nome), { botao: 'Buscar' });
      }
      await app.esperarTexto('4 peças');
    },
  },
  {
    arquivo: '02-cobrar',
    titulo: 'Pix, cartão\ne fiado',
    subtitulo: 'Divida a conta e parcele no crédito',
    tela: 'Cobrança da mesma venda: R$ 300,00 no PIX e R$ 400,00 no crédito em 3x (Visa) já lançados, o que falta e as seis formas de pagamento',
    mostrar: ['Falta receber', 'Crédito 3x · Visa', 'Vale de troca', 'Fiado'],
    async preparar(app) {
      await app.botao('Cobrar');
      await app.esperarTexto('Falta receber');
      await app.teclar('300,00');
      await app.tocar('PIX');
      await app.esperarTexto('remover');
      await app.teclar('400,00');
      await app.tocar('Crédito');
      await app.esperarTexto('Crédito — em quantas vezes?');
      await app.tocar('Visa');
      await app.tocar('3x');
      await app.esperarTexto('Crédito 3x · Visa');
      await app.rolarParaOTopo();
    },
  },
  {
    arquivo: '03-financeiro',
    titulo: 'Seu lucro\nde verdade',
    subtitulo: 'Já descontados custo, despesas e taxas',
    tela: 'Financeiro: resultado do mês, faturamento, custo das peças vendidas, lucro bruto, despesas, taxas de cartão, margem e o aviso de repor',
    mostrar: ['Resultado do mês', 'Devoluções', 'Lucro bruto', 'Taxas de cartão', 'hora de repor'],
    async preparar(app) {
      await app.aba('Financeiro');
      await app.esperarTexto('Resultado do mês');
      // A seed lança as despesas do mês inteiro de uma vez e espalha as vendas pelos últimos
      // 25 dias: na primeira quinzena o mês ainda fecha no vermelho, e "Seu lucro de
      // verdade" em cima de um prejuízo não vai para a App Store.
      const resultado = await app.page.evaluate(() => {
        const rotulo = [...document.querySelectorAll('div[dir="auto"]')].find(
          (el) => el.textContent === 'Resultado do mês' && el.checkVisibility(),
        );
        return rotulo?.nextElementSibling?.textContent?.trim() ?? '';
      });
      if (/^[-−]/.test(resultado) && !process.env.CAPTURAS_ACEITAR_PREJUIZO) {
        throw new Error(
          `o Resultado do mês saiu negativo (${resultado}). Rode na segunda quinzena do mês ` +
            '(as despesas da seed já contam inteiras), ou CAPTURAS_ACEITAR_PREJUIZO=1 para seguir.',
        );
      }
    },
  },
  {
    arquivo: '04-relatorios',
    titulo: 'Saiba o que\nmais vende',
    subtitulo: 'Vendas por dia e o lucro de cada peça',
    tela: 'Relatórios dos últimos 30 dias: vendas por dia (gráfico arrastado até hoje) e o ranking dos mais vendidos, com o lucro de cada um',
    mostrar: ['Vendas por dia', 'Mais vendidos'],
    async preparar(app) {
      await app.aba('Financeiro');
      await app.tocar('Relatórios');
      await app.esperarTexto('Mais vendidos');
      await app.rolarGraficoAteHoje();
    },
  },
  {
    arquivo: '05-estoque',
    titulo: 'Estoque por\ntamanho e cor',
    subtitulo: 'O app avisa a hora de repor',
    tela: 'Estoque das blusas (pela busca): saldo de cada tamanho e cor, o valor parado em custo e a etiqueta "repor" no que chegou ao mínimo',
    mostrar: ['Inventário', 'repor'],
    async preparar(app) {
      await app.aba('Estoque');
      await app.esperarTexto('Inventário');
      // As blusas, pela busca: as seis linhas cabem inteiras na tela. A lista do estoque
      // inteiro deixaria uma fatia de cartão em cima da barra de abas.
      await app.buscar('Peça ou código', 'Blusa');
    },
  },
  {
    arquivo: '06-produtos',
    titulo: 'Catálogo na\npalma da mão',
    subtitulo: 'Grade, preço e saldo de cada peça',
    tela: 'Produtos (as calças, pela busca): cada peça com preço, categoria, a grade com o saldo de cada tamanho (o zerado em vermelho) e o total em estoque',
    mostrar: ['Calça Alfaiataria', 'Calça Jeans Skinny', 'em estoque'],
    async preparar(app) {
      await app.aba('Produtos');
      await app.esperarTexto('em estoque');
      // As calças, pela busca. Com o catálogo inteiro, o botão + flutua sempre em cima do
      // preço ou do saldo de algum cartão (o vão entre dois é menor que ele), e no fim da
      // lista o primeiro cartão sai cortado em cima.
      await app.buscar('Buscar por nome ou código de barras', 'Calça');
    },
  },
  {
    arquivo: '07-caixa',
    titulo: 'Feche o caixa\nsem planilha',
    subtitulo: 'O esperado e o contado, forma por forma',
    tela: 'Fechamento de caixa do dia, no fim da conferência: dinheiro, PIX, débito e crédito com o esperado e o contado de cada um, o total contado, a diferença e o Fechar caixa',
    mostrar: ['Dinheiro na gaveta', 'Cartão de crédito', 'Diferença', 'Fechar caixa'],
    async preparar(app) {
      await app.aba('Financeiro');
      await app.tocar('Caixa');
      await app.esperarTexto('Dinheiro na gaveta');
      // A conferência do dia inteira numa tela só: as quatro formas, o total, a diferença e o
      // "Fechar caixa". Diferença numa forma acrescenta uma linha ("Faltou R$ 4,50") ao cartão
      // dela, e aí a tela do iPhone não cabe mais o primeiro cartão inteiro e o botão longe do
      // indicador de início ao mesmo tempo: a gaveta desta foto bate.
      await app.rolarAteOFim();
    },
  },
  {
    arquivo: '08-crediario',
    titulo: 'Fiado sob\ncontrole',
    subtitulo: 'O que levou, o que pagou e o que falta',
    tela: 'Conta da Marizete no crediário: quanto deve, o aviso de que passou do limite combinado, o que levou no fiado, o que já pagou e cada compra',
    mostrar: ['acima do limite combinado', 'Deve', 'Compras no fiado', 'Pagamentos'],
    async preparar(app) {
      // Três vendas no fiado, pelo PDV, como no balcão. A seed deixa o crediário quase vazio
      // (as peças sorteadas para o fiado costumam ter acabado), e a tela vazia não diz nada.
      for (const { cliente, pecas } of FIADO) {
        await app.aba('Vender');
        for (const nome of pecas) await app.buscarPeca(await app.peca(nome), { botao: 'Buscar' });
        await app.botao('Cobrar');
        await app.tocar('Fiado');
        await app.digitar('Procure pelo nome ou telefone', cliente.split(' ')[0]);
        await app.tocar(cliente);
        await app.botao('Confirmar venda');
        await app.esperarTexto('Recibo para a cliente');
        await app.botao('Nova venda');
      }
      // A Marizete passa na loja e paga R$ 50,00 no PIX.
      await app.aba('Mais');
      await app.tocar('Crediário');
      await app.tocar('Marizete Alves');
      await app.botao('Receber pagamento');
      await app.esperarTexto('Como recebeu');
      // O valor nasce com a dívida inteira; a folha ainda pode estar abrindo quando o
      // primeiro toque chega, então confere o painel antes de seguir.
      for (let vez = 0; vez < 3; vez += 1) {
        await app.tocar('Limpar');
        await app.teclar('50,00');
        if (await app.page.getByText('R$ 50,00', { exact: true }).filter({ visible: true }).count()) break;
      }
      await app.esperarTexto('R$ 50,00');
      await app.tocar('PIX');
      await app.botao('Registrar');
      await app.esperarTexto('Como recebeu', { some: true });
      await app.esperarTexto('Ainda não pagou nada', { some: true });
    },
  },
  {
    arquivo: '09-condicional',
    titulo: 'Condicional\nsem caderno',
    subtitulo: 'O que voltou para a arara e o que cobrar',
    tela: 'Condicional da Cleide (prazo de 3 dias) sendo fechada: o vestido voltou para a arara, a blusa ficou, o que cobrar dela e as formas de pagamento',
    mostrar: ['Cleide Ramos', 'Tudo voltou', 'A cobrar', 'Fiado', 'Fechar condicional'],
    async preparar(app) {
      await app.aba('Mais');
      await app.tocar('Condicional');
      await app.botao('Nova condicional');
      for (const nome of ['Vestido Longo Festa', 'Blusa de Tricô']) {
        await app.buscarPeca(await app.peca(nome), { botao: 'Buscar pelo nome' });
      }
      await app.digitar('Nome ou telefone', 'Cleide');
      await app.tocar('Cleide Ramos');
      await app.tocar('3 dias');
      await app.botao('Registrar condicional');
      await app.esperarTexto('Tudo voltou');
      // Na volta, peça por peça: o vestido voltou, a blusa ficou.
      await app.responderVolta({ 'Vestido Longo Festa': 1, 'Blusa de Tricô': 0 });
      await app.esperarTexto('A cobrar');
      await app.soltarCampo();
      // Desce até o "Fechar condicional": o que cobrar, as formas e o botão de concluir. Sem
      // tocar a forma: a linha do pagamento escolhido deixaria a tela mais alta que o iPhone
      // (o cartão da Cleide, em cima, ou o botão, embaixo, sairia cortado).
      await app.rolarAteOFim();
    },
  },
  {
    arquivo: '10-recibo',
    titulo: 'Recibo\nna hora',
    subtitulo: 'Mande para a cliente pelo celular',
    tela: 'Recibo da venda das cenas 1 e 2, concluída com o resto no dinheiro: as peças, o total e as três formas de pagamento, com o botão Enviar recibo',
    mostrar: ['Total', 'Troca em até 30 dias', 'Enviar recibo'],
    async preparar(app) {
      // Continua a cobrança da cena 2: o que falta vai no dinheiro.
      await app.tocar('Dinheiro');
      await app.botao('Confirmar venda');
      await app.botao('Recibo para a cliente');
      await app.esperarTexto('Troca em até 30 dias');
    },
  },
];

/** Ordem das fotos (ver o comentário do topo). */
export const ROTEIRO = [
  '08-crediario',
  '09-condicional',
  '01-vender',
  '02-cobrar',
  '10-recibo',
  '07-caixa',
  '03-financeiro',
  '04-relatorios',
  '05-estoque',
  '06-produtos',
];
