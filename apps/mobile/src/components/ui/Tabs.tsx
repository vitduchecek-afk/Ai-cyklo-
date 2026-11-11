import React from 'react';
import { ScrollView, View } from 'react-native';
import { MIN_TOUCH } from '@trailpack/ui';
import { useTheme } from '@/theme/ThemeProvider';
import { Icon, type IconName } from '@/components/icons/Icon';
import { Text } from './Text';
import { Touch } from './Touch';
import { Badge } from './Badge';

export interface TabItem<K extends string> {
  key: K;
  label: string;
  icon?: IconName;
  badge?: string;
}

export interface TabsProps<K extends string> {
  items: TabItem<K>[];
  value: K;
  onChange: (k: K) => void;
}

/** In-screen underline tabs (horizontally scrollable on narrow screens). */
export function Tabs<K extends string>({ items, value, onChange }: TabsProps<K>) {
  const { colors: c } = useTheme();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityRole="tablist"
      style={{ flexGrow: 0, borderBottomWidth: 1, borderBottomColor: c.border }}
      contentContainerStyle={{ gap: 4 }}
    >
      {items.map((it) => {
        const active = it.key === value;
        return (
          <Touch
            key={it.key}
            accessibilityRole="tab"
            accessibilityLabel={it.label}
            accessibilityState={{ selected: active }}
            onPress={() => onChange(it.key)}
            scale={false}
            style={{
              minHeight: MIN_TOUCH,
              paddingHorizontal: 14,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              borderBottomWidth: 3,
              borderBottomColor: active ? c.primary : 'transparent',
            }}
          >
            {it.icon ? <Icon name={it.icon} size={18} color={active ? c.primary : c.textMuted} /> : null}
            <Text variant="label" tone={active ? 'primary' : 'muted'} style={active ? { fontWeight: '700' } : null}>
              {it.label}
            </Text>
            {it.badge ? <Badge label={it.badge} tone={active ? 'primary' : 'neutral'} /> : null}
          </Touch>
        );
      })}
      <View style={{ width: 4 }} />
    </ScrollView>
  );
}
