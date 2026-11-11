import React, { useState } from 'react';
import { View } from 'react-native';
import Svg, { G, Path } from 'react-native-svg';
import { useTheme } from '@/theme/ThemeProvider';
import { Text } from '@/components/ui/Text';
import { Touch } from '@/components/ui/Touch';
import { useGrow } from './hooks';
import { donutArcs, donutSegmentPath } from './math';

export interface DonutDatum {
  key: string;
  label: string;
  value: number;
  color?: string;
}

export interface DonutChartProps {
  data: DonutDatum[];
  size?: number;
  thickness?: number;
  /** Controlled selection; uncontrolled when omitted. */
  selectedKey?: string | null;
  onSelect?: (key: string | null) => void;
  formatValue?: (v: number) => string;
  /** Centre text when nothing is selected. */
  centerLabel?: string;
  centerValue?: string;
  legend?: boolean;
}

export function DonutChart({
  data,
  size = 180,
  thickness = 26,
  selectedKey,
  onSelect,
  formatValue = (v) => String(Math.round(v)),
  centerLabel,
  centerValue,
  legend = true,
}: DonutChartProps) {
  const { colors: c } = useTheme();
  const [inner, setInner] = useState<string | null>(null);
  const selected = selectedKey !== undefined ? selectedKey : inner;
  const grow = useGrow(data.map((d) => d.value).join(','), 700);
  const colors = data.map((d, i) => d.color ?? c.days[i % c.days.length] ?? c.primary);
  const arcs = donutArcs(data.map((d) => d.value), 2.5);
  const total = data.reduce((a, d) => a + Math.max(0, d.value), 0);
  const select = (key: string) => {
    const next = selected === key ? null : key;
    setInner(next);
    onSelect?.(next);
  };
  const cx = size / 2;
  const rOuter = size / 2 - 8;
  const rInner = rOuter - thickness;
  const sel = data.find((d) => d.key === selected);

  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 20 }}>
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={data.map((d) => `${d.label} ${formatValue(d.value)}`).join(', ')}
        style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}
      >
        <Svg width={size} height={size}>
          <G>
            {arcs.map((a) => {
              const d = data[a.index] as DonutDatum;
              const isSel = d.key === selected;
              const ro = rOuter + (isSel ? 6 : 0);
              const start = a.startDeg * grow;
              const end = a.endDeg * grow;
              if (end - start < 0.1) return null;
              return (
                <Path
                  key={d.key}
                  d={donutSegmentPath(cx, cx, ro, rInner, start, end)}
                  fill={colors[a.index]}
                  opacity={selected && !isSel ? 0.35 : 1}
                  onPress={() => select(d.key)}
                />
              );
            })}
          </G>
        </Svg>
        <View pointerEvents="none" style={{ position: 'absolute', alignItems: 'center', maxWidth: rInner * 1.7 }}>
          <Text variant="title" tabular align="center" numberOfLines={1} adjustsFontSizeToFit>
            {sel ? formatValue(sel.value) : (centerValue ?? formatValue(total))}
          </Text>
          <Text variant="caption" tone="muted" align="center" numberOfLines={2}>
            {sel ? `${sel.label} · ${Math.round((sel.value / Math.max(1, total)) * 100)} %` : centerLabel}
          </Text>
        </View>
      </View>
      {legend ? (
        <View style={{ flex: 1, minWidth: 150, gap: 2 }} accessibilityRole="list">
          {data.map((d, i) => {
            const isSel = d.key === selected;
            return (
              <Touch
                key={d.key}
                accessibilityRole="button"
                accessibilityLabel={`${d.label}, ${formatValue(d.value)}`}
                accessibilityState={{ selected: isSel }}
                onPress={() => select(d.key)}
                scale={false}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 10,
                  minHeight: 44,
                  paddingHorizontal: 8,
                  borderRadius: 10,
                  backgroundColor: isSel ? c.surfaceAlt : 'transparent',
                }}
              >
                <View style={{ width: 14, height: 14, borderRadius: 4, backgroundColor: colors[i] }} />
                <Text variant="body" style={{ flex: 1 }} numberOfLines={1}>
                  {d.label}
                </Text>
                <Text variant="bodyStrong" tabular>
                  {formatValue(d.value)}
                </Text>
              </Touch>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}
