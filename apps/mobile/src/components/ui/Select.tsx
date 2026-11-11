import React, { useState } from 'react';
import { View } from 'react-native';
import { MIN_TOUCH } from '@trailpack/ui';
import { useTheme } from '@/theme/ThemeProvider';
import { Icon, type IconName } from '@/components/icons/Icon';
import { Sheet } from './Sheet';
import { Text } from './Text';
import { Touch } from './Touch';

export interface SelectOption<V extends string> {
  value: V;
  label: string;
  description?: string;
  icon?: IconName;
}

export interface SelectProps<V extends string> {
  label?: string;
  value: V | null;
  options: SelectOption<V>[];
  onChange: (v: V) => void;
  placeholder?: string;
  sheetTitle?: string;
  error?: string;
}

/** Dropdown replacement: tap opens a bottom sheet with a radio list. */
export function Select<V extends string>({ label, value, options, onChange, placeholder, sheetTitle, error }: SelectProps<V>) {
  const { colors: c, radii } = useTheme();
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  return (
    <View style={{ gap: 6 }}>
      {label ? (
        <Text variant="label" tone="muted">
          {label}
        </Text>
      ) : null}
      <Touch
        accessibilityRole="combobox"
        accessibilityLabel={label}
        accessibilityValue={{ text: current?.label }}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(true)}
        scale={false}
        style={{
          minHeight: MIN_TOUCH + 4,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          paddingHorizontal: 14,
          backgroundColor: c.surface,
          borderRadius: radii.md,
          borderWidth: 1.5,
          borderColor: error ? c.danger : c.borderStrong,
        }}
      >
        {current?.icon ? <Icon name={current.icon} size={20} color={c.textMuted} /> : null}
        <Text variant="body" tone={current ? 'default' : 'subtle'} style={{ flex: 1 }} numberOfLines={1}>
          {current?.label ?? placeholder ?? '—'}
        </Text>
        <Icon name="chevron-down" size={20} color={c.textMuted} />
      </Touch>
      {error ? (
        <Text variant="caption" tone="danger">
          {error}
        </Text>
      ) : null}
      <Sheet visible={open} onClose={() => setOpen(false)} title={sheetTitle ?? label}>
        <View accessibilityRole="radiogroup">
          {options.map((o) => {
            const selected = o.value === value;
            return (
              <Touch
                key={o.value}
                accessibilityRole="radio"
                accessibilityLabel={o.label}
                accessibilityState={{ selected }}
                scale={false}
                onPress={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
                style={{
                  minHeight: 56,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  paddingHorizontal: 12,
                  borderRadius: radii.md,
                  backgroundColor: selected ? c.primarySoft : 'transparent',
                }}
              >
                {o.icon ? <Icon name={o.icon} size={22} color={selected ? c.onPrimarySoft : c.textMuted} /> : null}
                <View style={{ flex: 1 }}>
                  <Text variant="bodyStrong" color={selected ? c.onPrimarySoft : c.text}>
                    {o.label}
                  </Text>
                  {o.description ? (
                    <Text variant="caption" tone="muted">
                      {o.description}
                    </Text>
                  ) : null}
                </View>
                {selected ? <Icon name="check" size={22} color={c.onPrimarySoft} strokeWidth={2.4} /> : null}
              </Touch>
            );
          })}
        </View>
      </Sheet>
    </View>
  );
}
