import React, { useEffect, useState } from 'react';
import { Animated, Easing, Platform, View, type DimensionValue, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '@/theme/ThemeProvider';
import { useT } from '@/i18n';

export interface SkeletonProps {
  width?: DimensionValue;
  height?: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}

/** Shimmering placeholder block. */
export function Skeleton({ width = '100%', height = 16, radius = 8, style }: SkeletonProps) {
  const { colors: c } = useTheme();
  const { t } = useT();
  const [pulse] = useState(() => new Animated.Value(0));
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 800, easing: Easing.inOut(Easing.quad), useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(pulse, { toValue: 0, duration: 800, easing: Easing.inOut(Easing.quad), useNativeDriver: Platform.OS !== 'web' }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  return (
    <Animated.View
      accessibilityLabel={t('a11y.loading')}
      accessibilityRole="progressbar"
      style={[{ width, height, borderRadius: radius, backgroundColor: c.surfaceSunken, opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.55, 1] }) }, style]}
    />
  );
}

export function SkeletonCard() {
  const { colors: c, radii } = useTheme();
  return (
    <View style={{ backgroundColor: c.surface, borderRadius: radii.lg, padding: 16, gap: 10, borderWidth: 1, borderColor: c.border }}>
      <Skeleton width="55%" height={20} />
      <Skeleton height={14} />
      <Skeleton width="80%" height={14} />
    </View>
  );
}
