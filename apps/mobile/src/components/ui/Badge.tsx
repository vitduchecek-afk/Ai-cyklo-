import React from 'react';
import { View } from 'react-native';
import { useTheme } from '@/theme/ThemeProvider';
import { Icon, type IconName } from '@/components/icons/Icon';
import { Text } from './Text';

export type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'water' | 'camp' | 'accent';

export function useToneColors(tone: Tone): { bg: string; fg: string; solid: string } {
  const { colors: c } = useTheme();
  switch (tone) {
    case 'primary':
      return { bg: c.primarySoft, fg: c.onPrimarySoft, solid: c.primary };
    case 'success':
      return { bg: c.successSoft, fg: c.success, solid: c.success };
    case 'warning':
      return { bg: c.warningSoft, fg: c.warning, solid: c.warning };
    case 'danger':
      return { bg: c.dangerSoft, fg: c.danger, solid: c.danger };
    case 'info':
      return { bg: c.infoSoft, fg: c.info, solid: c.info };
    case 'water':
      return { bg: c.waterSoft, fg: c.water, solid: c.water };
    case 'camp':
      return { bg: c.campSoft, fg: c.camp, solid: c.camp };
    case 'accent':
      return { bg: c.accentSoft, fg: c.onAccentSoft, solid: c.accent };
    default:
      return { bg: c.surfaceAlt, fg: c.textMuted, solid: c.textSubtle };
  }
}

export interface BadgeProps {
  label?: string;
  tone?: Tone;
  icon?: IconName;
  /** Small numeric/dot badge style. */
  dot?: boolean;
}

export function Badge({ label, tone = 'neutral', icon, dot }: BadgeProps) {
  const t = useToneColors(tone);
  if (dot) {
    return <View accessibilityLabel={label} style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: t.solid }} />;
  }
  return (
    <View
      accessible
      accessibilityLabel={label}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        gap: 4,
        backgroundColor: t.bg,
        paddingHorizontal: 9,
        paddingVertical: 3,
        borderRadius: 999,
      }}
    >
      {icon ? <Icon name={icon} size={14} color={t.fg} strokeWidth={2.2} /> : null}
      {label ? (
        <Text variant="caption" color={t.fg} style={{ fontWeight: '700' }}>
          {label}
        </Text>
      ) : null}
    </View>
  );
}
