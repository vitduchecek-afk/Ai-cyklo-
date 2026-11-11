import React, { useEffect, useState } from 'react';
import { Animated, Platform, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { MIN_TOUCH } from '@trailpack/ui';
import { useTheme } from '@/theme/ThemeProvider';
import { Text } from './Text';
import { Touch } from './Touch';

export interface SegmentOption<V extends string> {
  value: V;
  label: string;
}

export interface SegmentedControlProps<V extends string> {
  options: SegmentOption<V>[];
  value: V;
  onChange: (v: V) => void;
  accessibilityLabel?: string;
}

export function SegmentedControl<V extends string>({ options, value, onChange, accessibilityLabel }: SegmentedControlProps<V>) {
  const { colors: c, radii } = useTheme();
  const [width, setWidth] = useState(0);
  const [x] = useState(() => new Animated.Value(0));
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  const seg = width > 0 ? (width - 8) / options.length : 0;

  useEffect(() => {
    Animated.spring(x, { toValue: index * seg, useNativeDriver: Platform.OS !== 'web', damping: 20, stiffness: 260, mass: 0.8 }).start();
  }, [index, seg, x]);

  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel}
      onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
      style={[styles.wrap, { backgroundColor: c.surfaceAlt, borderRadius: radii.md, borderColor: c.border }]}
    >
      {seg > 0 ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.thumb,
            { width: seg, backgroundColor: c.surface, borderRadius: radii.sm, transform: [{ translateX: x }] },
            { borderWidth: 1.5, borderColor: c.primary },
          ]}
        />
      ) : null}
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <Touch
            key={o.value}
            accessibilityRole="radio"
            accessibilityLabel={o.label}
            accessibilityState={{ selected }}
            onPress={() => onChange(o.value)}
            scale={false}
            style={styles.seg}
          >
            <Text variant="label" tone={selected ? 'primary' : 'muted'} numberOfLines={1} style={selected ? { fontWeight: '700' } : null}>
              {o.label}
            </Text>
          </Touch>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', padding: 4, borderWidth: 1 },
  thumb: { position: 'absolute', top: 4, bottom: 4, left: 4 },
  seg: { flex: 1, minHeight: MIN_TOUCH - 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
});
