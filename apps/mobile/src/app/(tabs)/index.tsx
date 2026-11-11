import { sunTimes } from '@trailpack/calculations';
import { formatCoordinates, todayIso } from '@trailpack/shared';
import { useRouter } from 'expo-router';
import { View } from 'react-native';

import { Card, IconButton, KeyValueTable, Screen, SectionHeader, Text } from '@/components/ui';
import { useTheme } from '@/theme/ThemeProvider';

/** Reference point used until the GPS location service is wired in (Lysá hora, Beskydy). */
const REFERENCE = { name: 'Lysá hora', lat: 49.5461, lon: 18.4475 };

const fmtTime = (d: Date | null) =>
  d ? d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Prague' }) : '—';

export default function HomeScreen() {
  const theme = useTheme();
  const router = useRouter();
  const today = todayIso();
  const sun = sunTimes(today, REFERENCE.lat, REFERENCE.lon);

  return (
    <Screen
      title="TrailPack"
      subtitle="Your intelligent outdoor companion"
      actions={<IconButton icon="settings" label="Nastavení" onPress={() => router.push('/settings')} />}
    >
      <Card>
        <SectionHeader title="Slunce dnes (vypočteno offline)" />
        <Text variant="caption" tone="muted">
          {REFERENCE.name} · {formatCoordinates(REFERENCE.lat, REFERENCE.lon, 4)}
        </Text>
        <View style={{ height: theme.spacing.sm }} />
        <KeyValueTable
          rows={[
            { label: 'Svítání (občanské)', value: fmtTime(sun.civilDawn) },
            { label: 'Východ slunce', value: fmtTime(sun.sunrise) },
            { label: 'Západ slunce', value: fmtTime(sun.sunset) },
            { label: 'Soumrak (občanský)', value: fmtTime(sun.civilDusk) },
          ]}
        />
      </Card>
      <View style={{ height: theme.spacing.md }} />
      <Card>
        <SectionHeader title="Začněte" />
        <Text>Naplánujte výpravu v záložce Výpravy, spravujte výbavu v záložce Výbava nebo popište cestu asistentovi v záložce AI.</Text>
      </Card>
    </Screen>
  );
}
