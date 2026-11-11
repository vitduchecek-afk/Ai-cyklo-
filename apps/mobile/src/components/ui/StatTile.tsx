import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '@/theme/ThemeProvider';
import { Icon, type IconName } from '@/components/icons/Icon';
import { Text } from './Text';
import { Badge, type Tone } from './Badge';

export interface StatTileProps {
  label: string;
  value: string;
  unit?: string;
  icon?: IconName;
  tone?: Tone;
  /** e.g. "+12 %" */
  delta?: { label: string; tone: Tone };
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

export function StatTile({ label, value, unit, icon, tone = 'primary', delta, children, style }: StatTileProps) {
  const { colors: c, radii } = useTheme();
  const accent = { primary: c.primary, success: c.success, warning: c.warning, danger: c.danger, info: c.info, water: c.water, camp: c.camp, accent: c.accent, neutral: c.textMuted }[tone];
  return (
    <View
      accessible
      accessibilityLabel={`${label}: ${value}${unit ? ' ' + unit : ''}`}
      style={[{ backgroundColor: c.surfaceAlt, borderRadius: radii.md, padding: 14, gap: 4, minWidth: 130, flexGrow: 1, flexBasis: 130 }, style]}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        {icon ? <Icon name={icon} size={16} color={accent} /> : null}
        <Text variant="caption" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
          {label}
        </Text>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4 }}>
        <Text variant="title" tabular>
          {value}
        </Text>
        {unit ? (
          <Text variant="label" tone="muted">
            {unit}
          </Text>
        ) : null}
      </View>
      {delta ? <Badge label={delta.label} tone={delta.tone} /> : null}
      {children}
    </View>
  );
}
