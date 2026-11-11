import { Tabs } from 'expo-router';

import { Icon } from '@/components/icons/Icon';
import { useT } from '@/i18n';
import { useTheme } from '@/theme/ThemeProvider';

/** Bottom tab navigation: Domů, Mapa, Výpravy, Výbava, AI (other modules via the "Více" menu). */
export default function TabsLayout() {
  const { t } = useT();
  const theme = useTheme();
  const c = theme.colors;
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: c.primary,
        tabBarInactiveTintColor: c.textMuted,
        tabBarStyle: { backgroundColor: c.surface, borderTopColor: c.border },
      }}
    >
      <Tabs.Screen name="index" options={{ title: t('nav.home'), tabBarIcon: ({ color, size }) => <Icon name="home" color={String(color)} size={size} /> }} />
      <Tabs.Screen name="map" options={{ title: t('nav.map'), tabBarIcon: ({ color, size }) => <Icon name="map" color={String(color)} size={size} /> }} />
      <Tabs.Screen name="trips" options={{ title: t('nav.trips'), tabBarIcon: ({ color, size }) => <Icon name="backpack" color={String(color)} size={size} /> }} />
      <Tabs.Screen name="gear" options={{ title: t('nav.gear'), tabBarIcon: ({ color, size }) => <Icon name="gear" color={String(color)} size={size} /> }} />
      <Tabs.Screen name="ai" options={{ title: t('nav.ai'), tabBarIcon: ({ color, size }) => <Icon name="sparkle" color={String(color)} size={size} /> }} />
    </Tabs>
  );
}
