import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from './Text';
import { Touch } from './Touch';
import { useTheme } from '@/theme/ThemeProvider';

export interface SectionHeaderProps {
  title: string;
  subtitle?: string;
  action?: { label: string; onPress: () => void };
}

export function SectionHeader({ title, subtitle, action }: SectionHeaderProps) {
  const { colors: c } = useTheme();
  return (
    <View style={styles.row}>
      <View style={styles.flex}>
        <Text variant="heading" accessibilityRole="header">
          {title}
        </Text>
        {subtitle ? (
          <Text variant="caption" tone="muted">
            {subtitle}
          </Text>
        ) : null}
      </View>
      {action ? (
        <Touch
          accessibilityRole="button"
          accessibilityLabel={action.label}
          onPress={action.onPress}
          style={styles.action}
          hitSlop={8}
        >
          <Text variant="label" color={c.primary}>
            {action.label}
          </Text>
        </Touch>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: 12, marginTop: 8 },
  flex: { flex: 1 },
  action: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 4 },
});
