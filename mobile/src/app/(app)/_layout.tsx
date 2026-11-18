import { Stack } from 'expo-router';

import { cores } from '@/lib/tema';

/**
 * Stack por fora, abas por dentro: telas de detalhe (pagamento, cadastro, recibo) empilham
 * por cima das abas em vez de virarem uma aba cada.
 */
export default function AppLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: cores.primaria },
        headerTintColor: cores.aoFundoEscuro,
        headerTitleStyle: { fontWeight: '700' },
        headerBackTitle: 'Voltar',
        contentStyle: { backgroundColor: cores.fundo },
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen
        name="venda/pagamento"
        options={{ title: 'Cobrar', presentation: 'modal' }}
      />
      <Stack.Screen name="venda/[id]" options={{ title: 'Venda' }} />
      <Stack.Screen name="venda/devolucao" options={{ title: 'Devolução' }} />
      <Stack.Screen name="venda/recibo" options={{ title: 'Recibo' }} />
      <Stack.Screen name="clientes/index" options={{ title: 'Crediário' }} />
      <Stack.Screen name="clientes/[id]" options={{ title: 'Conta da cliente' }} />
      <Stack.Screen name="produto/novo" options={{ title: 'Nova peça' }} />
      <Stack.Screen name="produto/[id]" options={{ title: 'Produto' }} />
      <Stack.Screen name="estoque/entrada" options={{ title: 'Entrada de mercadoria' }} />
      <Stack.Screen name="estoque/ajuste" options={{ title: 'Ajustar estoque' }} />
      <Stack.Screen name="estoque/inventario" options={{ title: 'Inventário' }} />
      <Stack.Screen name="estoque/movimentacoes" options={{ title: 'Extrato do estoque' }} />
      <Stack.Screen name="financeiro/despesas" options={{ title: 'Despesas' }} />
      <Stack.Screen name="financeiro/despesa-nova" options={{ title: 'Nova despesa' }} />
      <Stack.Screen name="financeiro/relatorios" options={{ title: 'Relatórios' }} />
      <Stack.Screen name="financeiro/caixa" options={{ title: 'Fechamento de caixa' }} />
      <Stack.Screen name="financeiro/contas-pagar" options={{ title: 'Contas a pagar' }} />
      <Stack.Screen name="condicional/index" options={{ title: 'Condicional' }} />
      <Stack.Screen name="condicional/nova" options={{ title: 'Nova condicional' }} />
      <Stack.Screen name="condicional/[id]" options={{ title: 'Condicional' }} />
      <Stack.Screen name="mais/vendas" options={{ title: 'Vendas' }} />
      <Stack.Screen name="mais/usuarios" options={{ title: 'Usuários' }} />
      <Stack.Screen name="mais/auditoria" options={{ title: 'Auditoria' }} />
      <Stack.Screen name="mais/loja" options={{ title: 'A loja' }} />
      <Stack.Screen name="mais/usuario-novo" options={{ title: 'Novo usuário' }} />
      <Stack.Screen name="mais/usuario-comissao" options={{ title: 'Comissão e meta' }} />
      <Stack.Screen name="mais/usuario-papel" options={{ title: 'Mudar papel' }} />
      <Stack.Screen name="mais/senha" options={{ title: 'Trocar senha' }} />
      <Stack.Screen name="mais/conta" options={{ title: 'Minha conta' }} />
      <Stack.Screen name="mais/categorias" options={{ title: 'Categorias' }} />
      <Stack.Screen name="mais/taxas" options={{ title: 'Taxas do cartão' }} />
      <Stack.Screen name="mais/aniversariantes" options={{ title: 'Aniversariantes' }} />
      <Stack.Screen name="mais/leitor" options={{ title: 'Leitor do computador' }} />
      {/* Atalho do link gestaoloja://leitor?c=…: só repassa para mais/leitor. */}
      <Stack.Screen name="leitor" options={{ headerShown: false }} />
    </Stack>
  );
}
