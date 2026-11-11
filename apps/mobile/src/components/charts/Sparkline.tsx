import React from 'react';
import { View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { useTheme } from '@/theme/ThemeProvider';
import { useWidth } from './hooks';
import { areaPath, extent, scaleLinear, smoothPath } from './math';

export interface SparklineProps {
  values: number[];
  height?: number;
  /** Fixed width; fills the container when omitted. */
  width?: number;
  color?: string;
  fill?: boolean;
  label?: string;
}

export function Sparkline({ values, height = 36, width: fixed, color, fill = true, label }: SparklineProps) {
  const { colors: c } = useTheme();
  const [measured, onLayout] = useWidth();
  const width = fixed ?? measured;
  const col = color ?? c.primary;
  const [lo, hi] = extent(values);
  const pad = 4;
  const x = scaleLinear([0, Math.max(1, values.length - 1)], [pad, Math.max(pad + 1, width - pad)]);
  const y = scaleLinear([lo, hi === lo ? lo + 1 : hi], [height - pad, pad]);
  const pts = values.map((v, i) => ({ x: x(i), y: y(v) }));
  const last = pts[pts.length - 1];
  return (
    <View onLayout={fixed ? undefined : onLayout} style={{ height, width: fixed ?? '100%' }} accessible={!!label} accessibilityLabel={label} accessibilityRole="image">
      {width > 0 && pts.length > 1 ? (
        <Svg width={width} height={height}>
          {fill ? <Path d={areaPath(pts, height)} fill={col} opacity={0.14} /> : null}
          <Path d={smoothPath(pts)} stroke={col} strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" />
          {last ? <Circle cx={last.x} cy={last.y} r={3.5} fill={col} stroke={c.surface} strokeWidth={1.5} /> : null}
        </Svg>
      ) : null}
    </View>
  );
}
