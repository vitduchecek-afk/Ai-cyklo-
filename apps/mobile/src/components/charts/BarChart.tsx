import React, { useState } from 'react';
import { View } from 'react-native';
import Svg, { G, Line, Rect, Text as SvgText } from 'react-native-svg';
import { useTheme } from '@/theme/ThemeProvider';
import { Text } from '@/components/ui/Text';
import { useGrow, useWidth } from './hooks';
import { clamp, groupedBars, niceDomain, niceTicks, scaleLinear } from './math';

export interface BarSeries {
  key: string;
  label: string;
  values: number[];
  color?: string;
}

export interface BarChartProps {
  categories: string[];
  series: BarSeries[];
  height?: number;
  formatValue?: (v: number) => string;
  /** Called when a bar is tapped. */
  onSelect?: (sel: { group: number; series: number } | null) => void;
  legend?: boolean;
}

const PAD = { left: 40, right: 8, top: 16, bottom: 26 };

/** Grouped bar chart (compare series per category), tap a bar to inspect. */
export function BarChart({ categories, series, height = 220, formatValue = (v) => String(Math.round(v * 10) / 10), onSelect, legend = true }: BarChartProps) {
  const { colors: c, fs } = useTheme();
  const [width, onLayout] = useWidth();
  const [sel, setSel] = useState<{ group: number; series: number } | null>(null);
  const grow = useGrow(JSON.stringify(series.map((s) => s.values)), 600);
  const plotW = Math.max(10, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const [, yMax] = niceDomain(0, max, 4);
  const y = scaleLinear([0, yMax], [plotH, 0]);
  const values = categories.map((_, g) => series.map((s) => (s.values[g] ?? 0) * grow));
  const rects = groupedBars(values, { width: plotW, height: plotH }, yMax);
  const colors = series.map((s, i) => s.color ?? c.days[i % c.days.length] ?? c.primary);
  const selRect = sel ? rects.find((r) => r.group === sel.group && r.series === sel.series) : undefined;

  const pick = (g: number, s: number) => {
    const same = sel?.group === g && sel.series === s;
    const next = same ? null : { group: g, series: s };
    setSel(next);
    onSelect?.(next);
  };

  return (
    <View style={{ gap: 10 }} onLayout={onLayout}>
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={categories.map((cat, g) => `${cat}: ${series.map((s) => `${s.label} ${formatValue(s.values[g] ?? 0)}`).join(', ')}`).join('; ')}
      >
        {width > 0 ? (
          <Svg width={width} height={height}>
            <G x={PAD.left} y={PAD.top}>
              {niceTicks(0, yMax, 4).map((v) => (
                <G key={v}>
                  <Line x1={0} x2={plotW} y1={y(v)} y2={y(v)} stroke={c.border} strokeWidth={1} strokeDasharray={v === 0 ? undefined : '3 4'} />
                  <SvgText x={-8} y={y(v) + 4} fontSize={fs(11)} fill={c.textSubtle} textAnchor="end">
                    {formatValue(v)}
                  </SvgText>
                </G>
              ))}
              {rects.map((r) => {
                const isSel = sel?.group === r.group && sel.series === r.series;
                return (
                  <Rect
                    key={`${r.group}-${r.series}`}
                    x={r.x}
                    y={r.y}
                    width={r.width}
                    height={Math.max(0, r.height)}
                    rx={Math.min(6, r.width / 2)}
                    fill={colors[r.series]}
                    opacity={sel && !isSel ? 0.4 : 1}
                    stroke={isSel ? c.text : 'none'}
                    strokeWidth={isSel ? 2 : 0}
                    onPress={() => pick(r.group, r.series)}
                  />
                );
              })}
              {categories.map((cat, g) => (
                <SvgText key={cat + g} x={(g + 0.5) * (plotW / categories.length)} y={plotH + 17} fontSize={fs(11)} fill={c.textMuted} textAnchor="middle">
                  {cat}
                </SvgText>
              ))}
              {selRect ? (
                <G>
                  <Rect
                    x={clamp(selRect.x + selRect.width / 2 - 36, 0, plotW - 72)}
                    y={Math.max(-12, selRect.y - 30)}
                    width={72}
                    height={24}
                    rx={7}
                    fill={c.isDark ? c.surfaceAlt : '#1D2420'}
                  />
                  <SvgText
                    x={clamp(selRect.x + selRect.width / 2, 36, plotW - 36)}
                    y={Math.max(-12, selRect.y - 30) + 16}
                    fontSize={fs(12)}
                    fontWeight="700"
                    fill={c.isDark ? c.text : '#FFFFFF'}
                    textAnchor="middle"
                  >
                    {formatValue(selRect.value / Math.max(grow, 0.0001))}
                  </SvgText>
                </G>
              ) : null}
            </G>
          </Svg>
        ) : (
          <View style={{ height }} />
        )}
      </View>
      {legend && series.length > 1 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14 }}>
          {series.map((s, i) => (
            <View key={s.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <View style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: colors[i] }} />
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
