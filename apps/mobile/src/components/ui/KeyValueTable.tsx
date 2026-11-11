import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '@/theme/ThemeProvider';
import { Text } from './Text';

export interface KeyValueRow {
  label: string;
  value: string;
  hint?: string;
  /** Emphasised (bold) row, e.g. totals. */
  strong?: boolean;
}

export function KeyValueTable({ rows }: { rows: KeyValueRow[] }) {
  const { colors: c } = useTheme();
  return (
    <View accessibilityRole="list">
      {rows.map((r, i) => (
        <View
          key={r.label + i}
          accessible
          accessibilityRole="text"
          accessibilityLabel={`${r.label}: ${r.value}`}
          style={[styles.row, i < rows.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border }]}
        >
          <View style={styles.k}>
            <Text variant="body" tone="muted">
              {r.label}
            </Text>
            {r.hint ? (
              <Text variant="caption" tone="subtle">
                {r.hint}
              </Text>
            ) : null}
          </View>
          <Text variant={r.strong ? 'bodyStrong' : 'body'} tabular align="right" style={styles.v}>
            {r.value}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  k: { flex: 1 },
  v: { flexShrink: 1, maxWidth: '55%' },
});
