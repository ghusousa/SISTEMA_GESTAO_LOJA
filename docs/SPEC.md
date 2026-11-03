# SPEC — Sistema de Gestão de Loja de Roupas (v1)

## Objetivo

Dar ao dono de uma loja de roupas o controle completo do negócio pelo celular: cadastrar peças por
código de barras, saber o estoque real de cada tamanho/cor, vender bipando a etiqueta, registrar
despesas e enxergar quanto sobrou no fim do mês.

## Quem usa

Quatro cargos, do balcão para cima. Cada degrau soma ao de baixo — ninguém tem um poder que
o superior não tenha.

| Cargo | Além do degrau anterior | O que NÃO alcança |
|---|---|---|
| **Vendedora** (`VENDEDOR`) | Vende no PDV, bipa e consulta preço, cadastra peça nova, dá entrada de mercadoria (sem a nota do fornecedor); busca e cadastra cliente no balcão e põe o nome dela em qualquer venda, sem ver saldo nem limite; leva peça em condicional e a fecha; vê no PDV quanto ela mesma vendeu hoje contra a meta do dia | Custo, lucro, despesas, relatórios, estorno, ajuste de estoque, inventário, vendas e números das colegas, fiado, taxa da maquininha |
| **Supervisora** (`SUPERVISORA`) | Ajusta estoque, faz inventário, edita e exclui produtos e categorias, confere e fecha o caixa do dia, vê as vendas de toda a equipe | Custo, lucro, despesas, relatórios, estorno, devolução, crediário, logins da equipe |
| **Gerente** (`GERENTE`) | Vê custo, lucro e margem; lança despesas; abre relatórios (inclusive a comissão de cada um, e lê as taxas da maquininha que o resultado desconta); cancela venda concluída; recebe peça de volta (devolução) e cuida do crediário; administra os logins da equipe | A conta do dono (não cria, não promove, não edita, não redefine a senha dele), o **diário de auditoria**, o **nome da loja**, a **tabela de taxas da maquininha** e a **comissão e meta** da equipe — a identidade e os contratos do negócio são do dono, e quem recebe comissão não decide quanto |
| **Dono** (`ADMIN`) | Tudo, inclusive criar e promover outro dono, o **diário de auditoria** (tudo que cada login fez), o **nome e ramo da loja**, a **tabela de taxas da maquininha** e a **% de comissão e a meta do dia** de cada pessoa | — |

**Quatro decisões que a loja tomou e que o sistema faz valer:**

- **Quem vende não desfaz.** Estornar é do dono e do gerente. A vendedora que errar no caixa
  chama alguém — é o controle clássico contra desvio, e vale inclusive para a venda dela.
- **Quem confere o caixa não vê a margem.** A supervisora fecha o dia e sabe quanto entrou,
  mas não sabe quanto sobrou.
- **Gerir logins não é virar dono.** O gerente contrata, promove até supervisora e desliga;
  a conta do dono é intocável para ele, senão a permissão de administrar a equipe seria, na
  prática, a permissão de se promover.
- **O diário é só do dono.** O sistema anota o que cada login fez (vendeu, cancelou, deu
  entrada, mexeu no cadastro) e quem lê é só o dono — nem o gerente. É prestação de contas da
  equipe, não ferramenta de trabalho: fica fora do alcance de quem é auditado.

Quem recusa é **sempre o servidor** — schemas de resposta distintos por capacidade e uma
tabela única em `app/core/permissoes.py`. O app e o sistema web só escondem o que daria 403,
para não oferecer um botão que não funciona.

**Onde se usa.** O mesmo sistema em duas telas, com as mesmas regras e os mesmos papéis:
o **app** (Android/iOS) para andar pela loja bipando com a câmera, e o **sistema web** no
computador do balcão, onde o leitor USB digita o código como teclado e o teclado resolve
o que é chato no celular — digitar preço, lançar despesa, fechar o caixa, editar a grade.
A loja consegue operar 100% sem celular.

## Entidades centrais

- **Produto** — a peça (ex.: "Camiseta Básica Gola V"). Tem categoria, descrição e foto.
- **Variante** — o que de fato se vende e se conta: produto + tamanho + cor. Cada variante tem seu
  **código de barras** (o EAN da etiqueta do fornecedor ou um código interno gerado pelo sistema
  quando a peça vem sem etiqueta), preço de custo, preço de venda e estoque mínimo.
- **Movimentação de estoque** — todo evento que muda o saldo (entrada, ajuste, inventário, venda,
  estorno). O saldo nunca é editado direto: é consequência das movimentações. Isso dá auditoria
  completa ("por que tenho 3 e não 5?").
- **Venda** — o que saiu no PDV: itens (com preço e custo **congelados** no momento da venda),
  pagamentos (pode ser misto) e desconto. Pode levar o nome da cliente, em qualquer forma de
  pagamento. No crédito, guarda em quantas vezes (1 a 12) e a bandeira; no cartão, a taxa da
  maquininha e o prazo para cair na conta, **congelados** no momento da venda.
- **Taxa da maquininha** — o contrato do dono com a credenciadora: quanto o débito e cada faixa
  de parcelas do crédito custam, e em quantos dias o dinheiro cai. O resultado do mês desconta
  essas taxas, e a agenda de recebíveis mostra quanto cai na conta em cada dia.
- **Devolução** — a cliente voltou com a peça. Registra o que voltou, quanto saiu e por qual
  forma. Cada peça decide se volta ao estoque (a manchada não volta). Não existe "modo
  troca": troca é devolução + venda nova.
- **Vale de troca** — papel com código, gerado quando o valor não pode voltar pela forma que
  entrou. Vale como pagamento na próxima compra, inteiro ou em parte.
- **Cliente** — quem compra. Tem nome, telefone, aniversário e preferências (tamanho, estilo); o
  balcão busca e cadastra sem ver dinheiro, e a ficha mostra todas as compras dela. Quem leva no
  **fiado** tem também um limite **combinado** que avisa, mas não bloqueia, e quanto deve é
  sempre calculado, nunca guardado. Quitada, pode ter o cadastro excluído a pedido dela: nome,
  telefone, documento, aniversário, preferências e observação são apagados na hora (o cadastro
  vira "Cliente removido") e as compras ficam no histórico, sem o nome.
- **Despesa** — saída de dinheiro que não é compra de mercadoria (aluguel, energia, salário...),
  com categoria e marcação de recorrente.
- **Condicional** — as peças que a cliente leva para provar em casa, com prazo para voltar.
  Enquanto estão com ela, saem do saldo: ninguém as vende de novo no balcão. Fechada, o que
  voltou é estoque de novo e o que ficou vira uma venda comum, ligada à condicional.
- **Conta a pagar** — uma parcela que a loja deve ao fornecedor (valor, vencimento, número da
  nota, paga ou aberta). Nasce com a Entrada da mercadoria. **Não é despesa e não entra no
  Resultado**: o custo da mercadoria já entra pelo CMV quando a peça é vendida.
- **Fechamento de caixa** — conferência diária: quanto o sistema esperava por forma de pagamento
  versus quanto foi contado.
- **A loja** — o nome do negócio e o ramo dele. O nome sai na tela de entrada e no recibo do
  cliente. O ramo (roupas, calçados, autopeças, informática, cosméticos, alimentos, construção)
  troca **só as palavras** do sistema: onde uma loja de roupas lê "Tamanho / Cor", uma autopeças
  lê "Aplicação / Posição". Perguntado na instalação, mudável depois pelo dono.
- **Registro de auditoria** — uma linha para cada ação que alguém faz logado (vender, cancelar,
  dar entrada, editar cadastro, entrar no sistema, errar a senha). Guarda quem, o quê, quando e
  de onde, com o nome e o cargo **congelados** no momento — renomear a pessoa depois não reescreve
  o histórico. Só o dono lê. Não guarda e-mail à toa (erro de login com e-mail sem conta fica
  mascarado; excluir a conta mascara o e-mail dela) e apaga o que passou do prazo (dois anos por
  padrão).

## Casos de uso principais

1. **Vender (PDV)** — bipar a etiqueta (ou achar a peça pelo nome, quando a etiqueta rasgou) → a
   peça entra no carrinho com preço → repetir → aplicar desconto se houver → cobrar
   (dinheiro/PIX/débito/crédito, podendo dividir entre formas) → confirmar. O estoque baixa na
   mesma transação. Se o código não existir, o app oferece cadastro rápido. Se não houver saldo,
   a venda é recusada.
2. **Cadastrar peça nova** — dados do produto + grade de variantes (gerar P/M/G/GG de uma vez);
   para cada uma: bipar o EAN da etiqueta ou pedir um código interno ao sistema, informar custo,
   preço e estoque inicial. **É por aqui que a peça inédita entra no estoque**, pelo campo de
   estoque inicial — não pela tela de entrada, que pressupõe peça já cadastrada.
3. **Repor estoque** — dizer o que chegou, bipando (peça já etiquetada) ou pelo nome (o normal:
   mercadoria do fornecedor chega sem a nossa etiqueta, porque o código interno nasceu aqui). O
   sistema soma, e ao final envia uma entrada única com fornecedor e observação. Fechada a
   entrada, oferece a folha de etiquetas do que acabou de chegar — na quantidade que chegou.
4. **Conferir estoque (inventário)** — contar fisicamente e lançar as contagens; o sistema gera as
   movimentações de acerto e mostra as diferenças.
5. **Receber peça de volta (devolução)** — a cliente chega com a blusa e sem nota. Bipa a
   peça (ou acha pelo nome), o sistema mostra de quais vendas ela saiu, escolhe-se a venda e
   quantas unidades voltam. O valor sai **pelas mesmas formas em que entrou**, proporcional;
   o que não puder voltar assim vira vale. Peça com defeito não volta ao estoque.
6. **Vender no fiado e receber depois** — na cobrança, escolher (ou cadastrar na hora) a
   cliente. A dívida aparece no crediário, que abre em *quem está devendo*. Receber é um
   toque, já com o valor da dívida preenchido.
7. **Dar o recibo à cliente** — o papel de sempre: o que levou, quanto pagou, quando, com
   quem. No computador sai na impressora de bobina; no celular vai pelo WhatsApp. Não é nota
   fiscal, e está escrito no rodapé; com NFC-e autorizada, o recibo traz a chave dela.
8. **Lançar despesas** — valor, categoria, data, se é recorrente. Despesas recorrentes podem ser
   replicadas para a competência seguinte sem duplicar; desmarcar "recorrente" no último mês
   faz a conta fixa parar ali.
9. **Ver o resultado** — faturamento, custo das mercadorias vendidas (CMV), lucro bruto, despesas e
   resultado do período; produtos mais vendidos; peças com estoque abaixo do mínimo; curva de vendas
   por dia.
   - **Vendas e comissão por vendedora**: faturamento líquido (vendido menos devolvido), peças,
     ticket médio e comissão de cada pessoa no período, com o total a pagar. A vendedora vê no
     PDV só o próprio dia: "hoje: R$ X de R$ meta".
   - **Giro do estoque**: estoque parado (peças com saldo sem vender há mais de N dias, com o
     dinheiro parado nelas), curva ABC dos produtos pelo faturamento do período, e o valor da
     arara inteira em custo e em preço de venda.
10. **Fechar o caixa do dia** — conferir o esperado por forma de pagamento contra o contado.
11. **Levar em condicional** — escolher a cliente, bipar (ou buscar pelo nome) as peças que ela
    vai provar e combinar o prazo; as peças saem do estoque. Na volta, dizer quantas voltaram de
    cada peça e cobrar o que ficou, como no PDV. A lista de vencidas é a das ligações do dia.
12. **Pagar o fornecedor** — na Entrada, quem vê dinheiro informa o valor da nota e as parcelas
    (o sistema sugere 30/60/90); elas aparecem em Contas a pagar, com o aviso do que venceu e do
    que vence nos próximos 7 dias. Pagou, marca como paga (dia e forma).
13. **Emitir a NFC-e** — com o emissor ligado (ADR-41), um toque no detalhe da venda (ou
    sozinha, logo depois da venda, se o dono ligar). O que faltar — NCM da peça, CNPJ, IE,
    regime — aparece em lista; sem rede, fica pendente e tenta-se de novo. Cancelar a venda
    cancela a nota antes; se a SEFAZ recusar (passou de 30 minutos), a venda não é cancelada —
    nem quando não dá para confirmar com o emissor se a nota pendente foi autorizada.

## Regras de negócio que não podem ser violadas

- Saldo de estoque nunca fica negativo; toda alteração de saldo tem uma movimentação correspondente.
- Venda é atômica: itens, pagamentos e baixas de estoque acontecem juntos ou nada acontece.
- A soma dos pagamentos é exatamente igual ao total da venda.
- Preço e custo do item são congelados na venda — mudar o preço amanhã não altera o lucro de ontem.
- Cancelar uma venda nunca apaga: marca como CANCELADA e devolve o estoque por movimentação.
- Peça que volta da cliente (cancelamento ou devolução) volta para uma peça que se vê e se
  vende: se ela foi excluída do catálogo depois da venda, volta ao catálogo — ou entra na peça
  ativa com a mesma etiqueta, se a dona já a recadastrou.
- Desconto existe apenas no total da venda (não por item).
- Vendedor não recebe custo em nenhuma resposta da API.
- Retry de rede não duplica venda, entrada, devolução nem recebimento de fiado
  (idempotência por `client_uuid`). E a mesma chave com outro pedido (outras peças, outro
  pagamento, outra venda) é recusada — nunca respondida com o registro antigo como se fosse ela.
  Na Entrada, a recusa tira da tela o que já entrou — as peças e, se a entrada gravada já levou
  a mesma nota do fornecedor (mesmo número; sem número, mesmo valor), a nota também, que já
  está em Contas a pagar —, e o que falta é registrado sem lançar a mesma dívida duas vezes.
  Nota diferente da gravada fica e entra com o resto; se não sobrou peça para levá-la, a tela
  avisa para lançá-la em Contas a pagar.
- Nunca volta mais peça do que saiu na venda, nem em duas devoluções simultâneas.
- O que a devolução paga respeita o que cada forma recebeu: não sai da gaveta dinheiro que
  nunca entrou nela.
- Devolução é reconhecida no dia em que acontece — nunca reescreve o caixa de um dia fechado.
  Pelo mesmo motivo, venda de um dia cujo caixa já foi fechado não se cancela: devolve-se.
- Fiado e vale nunca contam como dinheiro na conferência do caixa; recebimento de fiado conta,
  separado do faturamento.
- O saldo devedor de um cliente nunca fica negativo: o abatimento para onde a dívida acaba, e
  a diferença sai em vale. Pelo mesmo motivo, venda no fiado cujo cancelamento deixaria o saldo
  negativo (porque a cliente já pagou) não se cancela — devolve-se.
- O mesmo vale não paga duas vendas.
- Peça em condicional não está disponível: sai do saldo na abertura e só volta no fechamento.
  Fechar duas vezes (toque duplo, dois aparelhos, resposta perdida) não devolve a peça duas
  vezes nem cobra a cliente duas vezes; o que ficou com ela é sempre uma venda comum, com caixa
  e recibo, registrada junto com o retorno — ou nada acontece.
- Conta a pagar do fornecedor nunca entra no Resultado nem nas Despesas. A nota só entra junto
  com a mercadoria da Entrada (ou nenhuma das duas), e as parcelas têm de somar a nota. Só quem
  vê dinheiro vê, lança e paga; a mesma conta não é paga duas vezes.
- Toda ação de quem está logado que muda alguma coisa fica registrada na auditoria, com o nome
  e o cargo congelados; o registro não pode derrubar a operação que ele observa.
- O login trava depois de erros de senha demais (por e-mail e por endereço), e a trava responde
  igual exista o e-mail ou não — a tela de login não revela quem é cadastrado.
- Só o dono lê a auditoria; para qualquer outro cargo a rota responde 403.
- Trocar o ramo da loja não altera nenhum produto, preço, estoque ou venda: muda só o rótulo
  que a tela dá às duas variações.
- Só o dono muda o nome e o ramo da loja; o nome é legível sem login (a tela de entrada precisa
  dele antes de existir sessão), mas documento, telefone e endereço da loja só com login.
- Cliente que ainda deve não tem o cadastro excluído; quitada, a exclusão apaga os dados
  pessoais e mantém as vendas.
- Trocar a conta do Google ou a pasta do backup na nuvem pede a senha de quem está salvando, e
  a tela do backup diz "Atrasado" quando a cópia passou de duas vezes o intervalo.
- A instalação termina com a cópia diária do banco ligada (Linux, Mac e Windows). O que sai do
  servidor (Drive, `BACKUP_REMOTO`) sai cifrado, com uma chave que só existe na máquina e onde o
  dono a guardou; a restauração abre a cópia cifrada com ela.
- A atualização sozinha só implanta versão com o CI verde, e não tenta de novo uma versão que já
  caiu neste servidor — só a próxima.
- Loja fora do ar, disco quase cheio, backup da nuvem atrasado ou rotina da máquina que falhou
  avisam o dono (ntfy), sem repetir o mesmo aviso antes de uma hora.
- Instalar pelo IP público é recusado: HTTP puro só dentro da rede da loja.
- A taxa da maquininha fica congelada em cada venda: mudar ou apagar a tabela vale só daqui
  para frente. O resultado do período desconta as taxas das vendas no cartão e devolve a taxa
  da parte devolvida pelo cartão. Só o crédito parcela (até 12x); débito e PIX, nunca.
- Só o dono muda as taxas da maquininha; quem vê dinheiro as lê; a vendedora não as vê.
- O balcão busca e cadastra cliente sem ver saldo, limite ou observação do crediário; vender
  fiado continua sendo de quem cuida do crediário. Cadastro reenviado pela rede não duplica a
  cliente.
- A comissão sai do faturamento LÍQUIDO de quem fez a venda: venda cancelada não conta, e a peça
  devolvida tira a comissão no período em que voltou — sem reescrever a folha de um mês fechado.
  A soma da equipe fecha com o faturamento líquido do resumo da loja.
- Só o dono define a % de comissão (0 a 100) e a meta do dia de cada um; nem o gerente, que também
  recebe comissão, mexe nisso — nem na própria.
- Cada pessoa vê o próprio dia no PDV (vendido, peças, meta), sem custo, lucro nem o número das
  colegas.
- Uma venda tem no máximo uma NFC-e, e nota autorizada não é emitida de novo — nem com dois
  cliques, nem com a resposta do emissor perdida no caminho (ADR-41).
- Falha fiscal nunca impede vender; e venda com NFC-e autorizada só se cancela se a nota for
  cancelada antes, no emissor.
- A credencial do emissor fiscal mora no `.env` do servidor: nunca no banco, nunca numa rota.

## Fora do escopo do v1

Funcionamento offline com sincronização (v2 — já preparado pelo `client_uuid`), NF-e (modelo 55,
inclusive a de devolução), NFC-e nos regimes Normal e Simples com excesso de sublimite, CPF na
nota, fidelidade e pontos, múltiplas lojas, e-commerce, limite de desconto por
vendedor, sessões de inventário compartilhadas no servidor, contagem cega, foto por variante,
notificações push, parcelamento do crediário em datas fixas (hoje é dívida única, recebida em
qualquer valor), cobrança automática por mensagem.

*Saíram de "fora do escopo" e hoje existem:* impressão de etiquetas, recibo da venda, cadastro de
clientes, trocas com vale, o sistema servir a outros ramos além de roupas, taxa da maquininha com
crédito parcelado e agenda de recebíveis (sem TEF integrada: a maquininha segue à parte),
cliente em qualquer venda, com aniversário, preferências e histórico de compras (sem pontos),
comissão e meta do dia por vendedora, os relatórios de estoque parado, curva ABC e valor do
estoque, condicional e contas a pagar do fornecedor, e a **NFC-e** no Simples Nacional por
emissor terceirizado (ADR-41) — o dono contrata o emissor, cadastra nele o certificado A1 e o
CSC, testa em homologação e liga pelo `.env`.
