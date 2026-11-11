import * as Clipboard from 'expo-clipboard';
import { formatCoordinates } from '@trailpack/shared';
import { useState } from 'react';
import { View } from 'react-native';

import { TrailMap } from '@/components/map/TrailMap';
import { Button, Card, Text, toast } from '@/components/ui';
import { useTheme } from '@/theme/ThemeProvider';

export default function MapScreen() {
  const theme = useTheme();
  const [pin, setPin] = useState<{ lat: number; lon: number } | null>(null);
  const text = pin ? formatCoordinates(pin.lat, pin.lon, 5) : '';

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <TrailMap initialCamera={{ center: [15.5, 49.8], zoom: 6.5 }} pin={pin} onLongPress={(lat, lon) => setPin({ lat, lon })} />
      <View pointerEvents="box-none" style={{ position: 'absolute', left: 12, right: 12, bottom: 12, gap: 8 }}>
        {pin ? (
          <Card>
            <Text variant="caption" tone="muted">
              Vybraný bod
            </Text>
            <Text>{text}</Text>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              <Button
                label="Kopírovat"
                icon="copy"
                onPress={() => {
                  void Clipboard.setStringAsync(`${pin.lat.toFixed(5)}, ${pin.lon.toFixed(5)}`).then(() => toast.success('Souřadnice zkopírovány'));
                }}
              />
              <Button label="Zavřít" variant="ghost" onPress={() => setPin(null)} />
            </View>
          </Card>
        ) : (
          <Card padding={10}>
            <Text variant="caption" tone="muted">
              Podržte prst (na webu pravé tlačítko) na mapě pro zobrazení souřadnic.
            </Text>
          </Card>
        )}
        <Text variant="caption" tone="muted">
          © OpenStreetMap contributors · OpenFreeMap · OpenMapTiles
        </Text>
      </View>
    </View>
  );
}
