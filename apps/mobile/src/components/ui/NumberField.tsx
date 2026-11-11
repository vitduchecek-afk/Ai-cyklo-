import React, { useState } from 'react';
import { TextInput, View } from 'react-native';
import { MIN_TOUCH } from '@trailpack/ui';
import { useTheme } from '@/theme/ThemeProvider';
import { useT } from '@/i18n';
import { IconButton } from './IconButton';
import { Text } from './Text';

export interface NumberFieldProps {
  label?: string;
  value: number | null;
  onChange: (v: number | null) => void;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  /** Decimals shown/kept. Default 0. */
  decimals?: number;
  error?: string;
  helper?: string;
}

const clamp = (v: number, min?: number, max?: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));

/** Numeric input with unit suffix and +/- steppers (48dp targets). */
export function NumberField({ label, value, onChange, unit, min, max, step = 1, decimals = 0, error, helper }: NumberFieldProps) {
  const { colors: c, radii, fs } = useTheme();
  const { t, locale } = useT();
  const [draft, setDraft] = useState<string | null>(null);
  const fmt = (v: number | null) => (v === null ? '' : v.toLocaleString(locale, { maximumFractionDigits: decimals, useGrouping: false }));
  const round = (v: number) => Number(v.toFixed(decimals));
  const bump = (dir: 1 | -1) => onChange(round(clamp((value ?? min ?? 0) + dir * step, min, max)));
  const commit = (text: string) => {
    const n = Number(text.replace(',', '.').replace(/\s/g, ''));
    setDraft(null);
    if (text.trim() === '' || Number.isNaN(n)) return onChange(null);
    onChange(round(clamp(n, min, max)));
  };
  return (
    <View style={{ gap: 6 }}>
      {label ? (
        <Text variant="label" tone="muted">
          {label}
        </Text>
      ) : null}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          borderWidth: 1.5,
          borderColor: error ? c.danger : c.borderStrong,
          borderRadius: radii.md,
          backgroundColor: c.surface,
          minHeight: MIN_TOUCH + 4,
          overflow: 'hidden',
        }}
      >
        <IconButton icon="minus" label={t('common.decrease')} onPress={() => bump(-1)} disabled={min !== undefined && value !== null && value <= min} />
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'baseline', justifyContent: 'center', gap: 4 }}>
          <TextInput
            accessibilityLabel={label ?? t('common.value')}
            value={draft ?? fmt(value)}
            onChangeText={setDraft}
            onFocus={() => setDraft(fmt(value))}
            onBlur={() => draft !== null && commit(draft)}
            onSubmitEditing={() => draft !== null && commit(draft)}
            keyboardType={decimals > 0 ? 'decimal-pad' : 'number-pad'}
            selectTextOnFocus
            style={[
              { color: c.text, fontSize: fs(18), fontWeight: '700', textAlign: 'center', minWidth: 56, paddingVertical: 8 },
              { outlineStyle: 'none' } as object,
            ]}
          />
          {unit ? (
            <Text variant="label" tone="muted">
              {unit}
            </Text>
          ) : null}
        </View>
        <IconButton icon="plus" label={t('common.increase')} onPress={() => bump(1)} disabled={max !== undefined && value !== null && value >= max} />
      </View>
      {error || helper ? (
        <Text variant="caption" tone={error ? 'danger' : 'subtle'}>
          {error ?? helper}
        </Text>
      ) : null}
    </View>
  );
}
