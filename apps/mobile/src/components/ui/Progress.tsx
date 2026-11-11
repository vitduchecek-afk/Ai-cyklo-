import React, { useEffect, useState } from 'react';
import { Animated, Easing, Platform, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { useTheme } from '@/theme/ThemeProvider';
import { useT } from '@/i18n';
import { Text } from './Text';
import type { Tone } from './Badge';
import { useToneColors } from './Badge';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export interface ProgressBarProps {
  /** 0..1 */
  value: number;
  tone?: Tone;
  height?: number;
  label?: string;
}

export function ProgressBar({ value, tone = 'primary', height = 8, label }: ProgressBarProps) {
  const { colors: c } = useTheme();
  const { t } = useT();
  const t2 = useToneColors(tone);
  const [anim] = useState(() => new Animated.Value(0));
  useEffect(() => {
    Animated.timing(anim, { toValue: clamp01(value), duration: 420, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
  }, [value, anim]);
  const pct = Math.round(clamp01(value) * 100);
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label ?? t('a11y.progress', { value: pct })}
      accessibilityValue={{ min: 0, max: 100, now: pct }}
      style={{ height, borderRadius: height, backgroundColor: c.surfaceSunken, overflow: 'hidden' }}
    >
      <Animated.View
        style={{
          height,
          borderRadius: height,
          backgroundColor: t2.solid,
          width: anim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
        }}
      />
    </View>
  );
}

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

export interface ProgressRingProps {
  value: number;
  size?: number;
  thickness?: number;
  tone?: Tone;
  children?: React.ReactNode;
  label?: string;
}

export function ProgressRing({ value, size = 96, thickness = 10, tone = 'primary', children, label }: ProgressRingProps) {
  const { colors: c } = useTheme();
  const { t } = useT();
  const t2 = useToneColors(tone);
  const [anim] = useState(() => new Animated.Value(0));
  useEffect(() => {
    Animated.timing(anim, { toValue: clamp01(value), duration: 600, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
  }, [value, anim]);
  const r = (size - thickness) / 2;
  const circ = 2 * Math.PI * r;
  const pct = Math.round(clamp01(value) * 100);
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label ?? t('a11y.progress', { value: pct })}
      accessibilityValue={{ min: 0, max: 100, now: pct }}
      style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}
    >
      <Svg width={size} height={size} style={{ position: 'absolute', transform: [{ rotate: '-90deg' }] }}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={c.surfaceSunken} strokeWidth={thickness} fill="none" />
        <AnimatedCircle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={t2.solid}
          strokeWidth={thickness}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={`${circ} ${circ}`}
          strokeDashoffset={anim.interpolate({ inputRange: [0, 1], outputRange: [circ, 0] }) as unknown as number}
        />
      </Svg>
      {children ?? (
        <Text variant="subheading" tabular>
          {pct}%
        </Text>
      )}
    </View>
  );
}

// Platform is referenced to keep native/web parity explicit for future native-driver use.
void Platform;
