import React, { useState } from 'react';
import { PanResponder, View, type GestureResponderEvent } from 'react-native';
import Svg, { Circle, G, Line, Path, Rect, Text as SvgText } from 'react-native-svg';
import { useTheme } from '@/theme/ThemeProvider';
import { Text } from '@/components/ui/Text';
import { useLatest } from '@/lib/useLatest';
import { useGrow, useWidth } from './hooks';
import { areaPath, clamp, niceDomain, niceTicks, scaleLinear, smoothPath, type Pt } from './math';

export interface LineSeries {
  key: string;
  label: string;
  values: number[];
  color?: string;
}

export interface LineChartProps {
  series: LineSeries[];
  /** One label per x index (shown sparsely). */
  xLabels?: string[];
  height?: number;
  area?: boolean;
  smooth?: boolean;
  formatValue?: (v: number) => string;
  onScrub?: (index: number | null) => void;
}

const PAD = { left: 40, right: 12, top: 14, bottom: 26 };

export function LineChart({ series, xLabels, height = 200, area = true, smooth = true, formatValue = (v) => String(Math.round(v * 10) / 10), onScrub }: LineChartProps) {
  const { colors: c, fs } = useTheme();
  const [width, onLayout] = useWidth();
  const [idx, setIdx] = useState<number | null>(null);
  const grow = useGrow(JSON.stringify(series.map((s) => s.values)), 700);
  const n = Math.max(2, ...series.map((s) => s.values.length));
  const plotW = Math.max(10, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  const all = series.flatMap((s) => s.values);
  const [yMin, yMax] = niceDomain(Math.min(0, ...all), Math.max(1, ...all), 4);
  const x = scaleLinear([0, n - 1], [0, plotW]);
  const y = scaleLinear([yMin, yMax], [plotH, 0]);
  const colors = series.map((s, i) => s.color ?? c.days[i % c.days.length] ?? c.primary);

  const at = (lx: number) => {
    const i = clamp(Math.round(x.invert(lx - PAD.left)), 0, n - 1);
    setIdx(i);
    onScrub?.(i);
  };
  const end = () => {
    setIdx(null);
    onScrub?.(null);
  };
  const latest = useLatest({ at, end });
  const [pan] = useState(() =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e: GestureResponderEvent) => latest.current.at(e.nativeEvent.locationX),
      onPanResponderMove: (e: GestureResponderEvent) => latest.current.at(e.nativeEvent.locationX),
      onPanResponderRelease: () => latest.current.end(),
      onPanResponderTerminate: () => latest.current.end(),
    }),
  );

  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 54))));

  return (
    <View style={{ gap: 10 }} onLayout={onLayout}>
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={series.map((s) => `${s.label}: ${s.values.map(formatValue).join(', ')}`).join('; ')}
        style={{ height }}
      >
        {width > 0 ? (
          <Svg width={width} height={height}>
            <G x={PAD.left} y={PAD.top}>
              {niceTicks(yMin, yMax, 4).map((v) => (
                <G key={v}>
                  <Line x1={0} x2={plotW} y1={y(v)} y2={y(v)} stroke={c.border} strokeWidth={1} strokeDasharray="3 4" />
                  <SvgText x={-8} y={y(v) + 4} fontSize={fs(11)} fill={c.textSubtle} textAnchor="end">
                    {formatValue(v)}
                  </SvgText>
                </G>
              ))}
              {xLabels?.map((l, i) =>
                i % labelEvery === 0 ? (
                  <SvgText key={i} x={x(i)} y={plotH + 17} fontSize={fs(11)} fill={c.textMuted} textAnchor="middle">
                    {l}
                  </SvgText>
                ) : null,
              )}
              {series.map((s, si) => {
                const pts: Pt[] = s.values.map((v, i) => ({ x: x(i), y: y(yMin + (v - yMin) * grow) }));
                return (
                  <G key={s.key}>
                    {area && si === 0 ? <Path d={areaPath(pts, plotH)} fill={colors[si]} opacity={0.14} /> : null}
                    <Path d={smooth ? smoothPath(pts) : pts.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join('')} stroke={colors[si]} strokeWidth={2.6} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  </G>
                );
              })}
              {idx != null ? (
                <G>
                  <Line x1={x(idx)} x2={x(idx)} y1={0} y2={plotH} stroke={c.text} strokeWidth={1.2} />
                  {series.map((s, si) => (s.values[idx] != null ? <Circle key={s.key} cx={x(idx)} cy={y(s.values[idx] as number)} r={5.5} fill={colors[si]} stroke={c.surface} strokeWidth={2.5} /> : null))}
                  {(() => {
                    const w = 96;
                    const tx = clamp(x(idx) - w / 2, 0, plotW - w);
                    return (
                      <G>
                        <Rect x={tx} y={-10} width={w} height={22 + (series.length > 1 ? (series.length - 1) * 15 : 0)} rx={7} fill={c.isDark ? c.surfaceAlt : '#1D2420'} />
                        {series.map((s, si) => (
                          <SvgText key={s.key} x={tx + 8} y={5 + si * 15} fontSize={fs(11.5)} fontWeight="700" fill={c.isDark ? c.text : '#FFFFFF'}>
                            {`${xLabels?.[idx] ? xLabels[idx] + ': ' : ''}${formatValue(s.values[idx] ?? 0)}`}
                          </SvgText>
                        ))}
                      </G>
                    );
                  })()}
                </G>
              ) : null}
            </G>
          </Svg>
        ) : null}
        <View {...pan.panHandlers} style={{ position: 'absolute', left: PAD.left, right: PAD.right, top: 0, bottom: 0 }} />
      </View>
      {series.length > 1 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14 }}>
          {series.map((s, i) => (
            <View key={s.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <View style={{ width: 14, height: 4, borderRadius: 2, backgroundColor: colors[i] }} />
              <Text variant="caption" tone="muted">
                {s.label}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
