import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import type { ColorValue } from 'react-native';

import { cores, fonte } from '@/lib/tema';
import { useAuthStore } from '@/stores/authStore';

type Icone = keyof typeof MaterialCommunityIcons.glyphMap;

function icone(nome: Icone) {
  return ({ color, size }: { color: ColorValue; size: number }) => (
    <MaterialCommunityIcons name={nome} color={color} size={size} />
  );
}

export default function TabsLayout() {
  const ehAdmin = useAuthStore((e) => e.usuario?.papel === 'ADMIN');

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: cores.primaria },
        headerTintColor: cores.aoFundoEscuro,
        headerTitleStyle: { fontWeight: '700' },
        tabBarActiveTintColor: cores.primaria,
        tabBarInactiveTintColor: cores.textoFraco,
        tabBarLabelStyle: { fontSize: fonte.micro, fontWeight: '600' },
        tabBarStyle: { height: 62, paddingBottom: 8, paddingTop: 6 },
      }}
    >
      {/* Vender é a primeira aba: abrir o app cai direto no scanner. */}
      <Tabs.Screen
        name="index"
        options={{ title: 'Vender', tabBarIcon: icone('barcode-scan'), headerShown: false }}
      />
      <Tabs.Screen
        name="produtos"
        options={{ title: 'Produtos', tabBarIcon: icone('tshirt-crew-outline') }}
      />
      <Tabs.Screen
        name="estoque"
        options={{ title: 'Estoque', tabBarIcon: icone('package-variant-closed') }}
      />
      {/* Dinheiro do negócio é assunto de dono: para o vendedor a aba nem existe. */}
      <Tabs.Protected guard={ehAdmin}>
        <Tabs.Screen
          name="financeiro"
          options={{ title: 'Financeiro', tabBarIcon: icone('cash-multiple') }}
        />
      </Tabs.Protected>
      <Tabs.Screen name="mais" options={{ title: 'Mais', tabBarIcon: icone('menu') }} />
    </Tabs>
  );
}
