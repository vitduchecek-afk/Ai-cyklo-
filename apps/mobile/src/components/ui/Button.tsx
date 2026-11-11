import React from 'react';
import { ActivityIndicator, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { MIN_TOUCH } from '@trailpack/ui';
import { useTheme } from '@/theme/ThemeProvider';
import { Icon, type IconName } from '@/components/icons/Icon';
import { Text } from './Text';
import { Touch } from './Touch';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  size?: 'md' | 'lg';
  icon?: IconName;
  iconRight?: IconName;
  loading?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  icon,
  iconRight,
  loading,
  disabled,
  fullWidth,
  accessibilityHint,
  style,
  testID,
}: ButtonProps) {
  const { colors: c, radii, shadows } = useTheme();
  const inactive = disabled || loading;
  const scheme = {
    primary: { bg: c.primary, fg: c.onPrimary, border: c.primary },
    secondary: { bg: c.surface, fg: c.text, border: c.borderStrong },
    ghost: { bg: 'transparent', fg: c.primary, border: 'transparent' },
    danger: { bg: c.danger, fg: c.onDanger, border: c.danger },
  }[variant];
  const height = size === 'lg' ? 56 : MIN_TOUCH;
  return (
    <Touch
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!inactive, busy: !!loading }}
      disabled={inactive}
      onPress={onPress}
      hapticType="light"
      style={[
        styles.base,
        {
          minHeight: height,
          backgroundColor: scheme.bg,
          borderColor: scheme.border,
          borderRadius: radii.md,
          opacity: inactive && !loading ? 0.5 : 1,
          alignSelf: fullWidth ? 'stretch' : 'flex-start',
          boxShadow: variant === 'primary' || variant === 'danger' ? shadows.sm : undefined,
        },
        style,
      ]}
    >
      <View style={styles.row}>
        {loading ? <ActivityIndicator size="small" color={scheme.fg} /> : icon ? <Icon name={icon} size={20} color={scheme.fg} /> : null}
        <Text variant="bodyStrong" color={scheme.fg} numberOfLines={1} style={styles.label}>
          {label}
        </Text>
        {iconRight && !loading ? <Icon name={iconRight} size={20} color={scheme.fg} /> : null}
      </View>
    </Touch>
  );
}

const styles = StyleSheet.create({
  base: { borderWidth: 1.5, paddingHorizontal: 18, paddingVertical: 10, justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  label: { flexShrink: 1 },
});
