import React from 'react';
import { View } from 'react-native';
import { useTheme } from '@/theme/ThemeProvider';
import { useT } from '@/i18n';
import { Icon } from '@/components/icons/Icon';
import { Text } from './Text';

export function Disclaimer({ kind = 'general', text }: { kind?: 'general' | 'legal'; text?: string }) {
  const { colors: c, radii } = useTheme();
  const { t } = useT();
  return (
    <View
      accessibilityRole="text"
      style={{ flexDirection: 'row', gap: 10, padding: 12, borderRadius: radii.md, backgroundColor: c.surfaceAlt, alignItems: 'flex-start' }}
    >
      <Icon name={kind === 'legal' ? 'flag' : 'info'} size={18} color={c.textMuted} />
      <Text variant="caption" tone="muted" style={{ flex: 1 }}>
        {text ?? t(kind === 'legal' ? 'disclaimer.legal' : 'disclaimer.text')}
      </Text>
    </View>
  );
}
