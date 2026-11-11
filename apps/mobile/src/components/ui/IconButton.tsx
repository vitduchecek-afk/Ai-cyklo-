import React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { MIN_TOUCH } from '@trailpack/ui';
import { useTheme } from '@/theme/ThemeProvider';
import { Icon, type IconName } from '@/components/icons/Icon';
import { Touch } from './Touch';

export interface IconButtonProps {
  icon: IconName;
  /** Required accessible name. */
  label: string;
  onPress?: () => void;
  variant?: 'plain' | 'tonal' | 'filled' | 'surface';
  size?: number;
  iconSize?: number;
  color?: string;
  disabled?: boolean;
  selected?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function IconButton({
  icon,
  label,
  onPress,
  variant = 'plain',
  size = MIN_TOUCH,
  iconSize = 24,
  color,
  disabled,
  selected,
  style,
  testID,
}: IconButtonProps) {
  const { colors: c, shadows } = useTheme();
  const bg =
    selected || variant === 'filled'
      ? c.primary
      : variant === 'tonal'
        ? c.primarySoft
        : variant === 'surface'
          ? c.surface
          : 'transparent';
  const fg = color ?? (selected || variant === 'filled' ? c.onPrimary : variant === 'tonal' ? c.onPrimarySoft : c.text);
  return (
    <Touch
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, selected: !!selected }}
      disabled={disabled}
      onPress={onPress}
      hapticType="light"
      style={[
        {
          width: Math.max(size, MIN_TOUCH),
          height: Math.max(size, MIN_TOUCH),
          borderRadius: 999,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: bg,
          opacity: disabled ? 0.45 : 1,
          boxShadow: variant === 'surface' ? shadows.md : undefined,
        },
        style,
      ]}
    >
      <Icon name={icon} size={iconSize} color={fg} />
    </Touch>
  );
}
