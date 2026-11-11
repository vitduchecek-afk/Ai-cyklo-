import React from 'react';
import { StyleSheet, Switch, View } from 'react-native';
import { MIN_TOUCH } from '@trailpack/ui';
import { useTheme } from '@/theme/ThemeProvider';
import { haptic } from '@/lib/haptics';
import { Icon, type IconName } from '@/components/icons/Icon';
import { Text } from './Text';
import { Touch } from './Touch';

export interface SwitchRowProps {
  title: string;
  subtitle?: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
  icon?: IconName;
  disabled?: boolean;
}

export function SwitchRow({ title, subtitle, value, onValueChange, icon, disabled }: SwitchRowProps) {
  const { colors: c } = useTheme();
  const toggle = () => {
    haptic.select();
    onValueChange(!value);
  };
  return (
    <Touch
      accessibilityRole="switch"
      accessibilityLabel={title}
      accessibilityHint={subtitle}
      accessibilityState={{ checked: value, disabled: !!disabled }}
      disabled={disabled}
      onPress={toggle}
      hapticType={false}
      scale={false}
      style={[styles.row, { opacity: disabled ? 0.5 : 1 }]}
    >
      {icon ? <Icon name={icon} size={22} color={c.textMuted} /> : null}
      <View style={styles.body}>
        <Text variant="bodyStrong">{title}</Text>
        {subtitle ? (
          <Text variant="caption" tone="muted">
            {subtitle}
          </Text>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={toggle}
        disabled={disabled}
        accessible={false}
        importantForAccessibility="no"
        trackColor={{ false: c.borderStrong, true: c.primary }}
        thumbColor={c.surface}
        // @ts-expect-error react-native-web only prop
        activeThumbColor={c.surface}
      />
    </Touch>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: MIN_TOUCH + 8, paddingVertical: 8 },
  body: { flex: 1, gap: 2 },
});
