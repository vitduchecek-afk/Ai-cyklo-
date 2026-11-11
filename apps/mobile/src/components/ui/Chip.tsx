import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '@/theme/ThemeProvider';
import { Icon, type IconName } from '@/components/icons/Icon';
import { Text } from './Text';
import { Touch } from './Touch';

export interface ChipProps {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  icon?: IconName;
  disabled?: boolean;
}

export function Chip({ label, selected, onPress, icon, disabled }: ChipProps) {
  const { colors: c } = useTheme();
  const fg = selected ? c.onPrimary : c.text;
  return (
    <Touch
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !!selected, disabled: !!disabled }}
      disabled={disabled || !onPress}
      onPress={onPress}
      style={[
        styles.chip,
        {
          backgroundColor: selected ? c.primary : c.surface,
          borderColor: selected ? c.primary : c.borderStrong,
          opacity: disabled ? 0.5 : 1,
        },
      ]}
    >
      {selected ? <Icon name="check" size={16} color={fg} strokeWidth={2.4} /> : icon ? <Icon name={icon} size={16} color={fg} /> : null}
      <Text variant="label" color={fg}>
        {label}
      </Text>
    </Touch>
  );
}

export interface ChipOption<V extends string> {
  value: V;
  label: string;
  icon?: IconName;
}

export type ChipGroupProps<V extends string> =
  | { options: ChipOption<V>[]; multiple?: false; value: V | null; onChange: (v: V) => void; wrap?: boolean }
  | { options: ChipOption<V>[]; multiple: true; value: V[]; onChange: (v: V[]) => void; wrap?: boolean };

export function ChipGroup<V extends string>(props: ChipGroupProps<V>) {
  const { options, wrap = true } = props;
  const isSelected = (v: V) => (props.multiple ? props.value.includes(v) : props.value === v);
  const press = (v: V) => {
    if (props.multiple) props.onChange(props.value.includes(v) ? props.value.filter((x) => x !== v) : [...props.value, v]);
    else props.onChange(v);
  };
  return (
    <View style={[styles.group, wrap ? { flexWrap: 'wrap' } : null]} accessibilityRole="radiogroup">
      {options.map((o) => (
        <Chip key={o.value} label={o.label} icon={o.icon} selected={isSelected(o.value)} onPress={() => press(o.value)} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    minHeight: 40,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1.5,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  group: { flexDirection: 'row', gap: 8 },
});
