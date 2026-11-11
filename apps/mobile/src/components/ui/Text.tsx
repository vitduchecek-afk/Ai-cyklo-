import React from 'react';
import { Platform, Text as RNText, type TextProps as RNTextProps, type TextStyle } from 'react-native';
import { monoFamily, type TextVariant } from '@trailpack/ui';
import { useTheme } from '@/theme/ThemeProvider';

export type TextTone =
  | 'default'
  | 'muted'
  | 'subtle'
  | 'primary'
  | 'onPrimary'
  | 'inverse'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'water'
  | 'camp';

export interface TextProps extends RNTextProps {
  variant?: TextVariant;
  tone?: TextTone;
  /** Explicit colour override (prefer `tone`). */
  color?: string;
  align?: TextStyle['textAlign'];
  /** Tabular numerals for values that change (distances, weights). */
  tabular?: boolean;
}

export function Text({ variant = 'body', tone = 'default', color, align, tabular, style, children, ...rest }: TextProps) {
  const theme = useTheme();
  const c = theme.colors;
  const toneColor: Record<TextTone, string> = {
    default: c.text,
    muted: c.textMuted,
    subtle: c.textSubtle,
    primary: c.primary,
    onPrimary: c.onPrimary,
    inverse: c.textInverse,
    success: c.success,
    warning: c.warning,
    danger: c.danger,
    info: c.info,
    water: c.water,
    camp: c.camp,
  };
  const base = theme.textStyle(variant);
  const isMono = variant === 'mono';
  return (
    <RNText
      maxFontSizeMultiplier={1.3}
      allowFontScaling
      {...rest}
      style={[
        base,
        { color: color ?? toneColor[tone], textAlign: align },
        isMono && Platform.OS === 'web' ? { fontFamily: monoFamily } : null,
        isMono && Platform.OS !== 'web' ? { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) } : null,
        tabular ? { fontVariant: ['tabular-nums'] } : null,
        variant === 'overline' ? { textTransform: 'uppercase' } : null,
        style,
      ]}
    >
      {children}
    </RNText>
  );
}
