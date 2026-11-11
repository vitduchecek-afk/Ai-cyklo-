import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import Svg, { Rect, Text as SvgText } from 'react-native-svg';
import { blend } from '@trailpack/ui';
import { useTheme } from '@/theme/ThemeProvider';
import { useT } from '@/i18n';
import { Text } from '@/components/ui/Text';
import { useWidth } from './hooks';
import { buildCalendarGrid } from './math';

export interface CalendarHeatmapProps {
  /** `YYYY-MM-DD` → value (e.g. km walked) */
  data: Record<string, number>;
  /** Last day shown (default today). */
  endDate?: string;
  weeks?: number;
  onSelect?: (date: string, value: number) => void;
  formatValue?: (v: number) => string;
}

const LABEL_W = 22;

export function CalendarHeatmap({ data, endDate, weeks = 20, onSelect, formatValue = (v) => String(Math.round(v * 10) / 10) }: CalendarHeatmapProps) {
  const { colors: c, fs } = useTheme();
  const { locale } = useT();
  const [width, onLayout] = useWidth();
  const [sel, setSel] = useState<string | null>(null);
  const end = endDate ?? new Date().toISOString().slice(0, 10);
  const cells = useMemo(() => buildCalendarGrid(data, end, weeks), [data, end, weeks]);
  const gap = 3;
  const cell = Math.max(8, Math.min(22, (width - LABEL_W - gap * (weeks - 1)) / weeks));
  const top = 16;
  const height = top + 7 * (cell + gap);
  const base = c.surfaceAlt;
  const color = (level: number) => (level <= 0 ? c.surfaceSunken : blend(c.primary, base, 0.28 + 0.72 * level));
  const dayNames = useMemo(() => {
    const f = new Intl.DateTimeFormat(locale, { weekday: 'narrow' });
    return Array.from({ length: 7 }, (_, i) => f.format(new Date(Date.UTC(2024, 0, 1 + i))));
  }, [locale]);
  const monthFmt = useMemo(() => new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }), [locale]);
  const selected = cells.find((x) => x.date === sel);
  return (
    <View onLayout={onLayout} style={{ gap: 8 }}>
      {width > 0 ? (
        <Svg width={width} height={height} accessibilityLabel={Object.keys(data).length + ' days'}>
          {[0, 2, 4, 6].map((r) => (
            <SvgText key={r} x={0} y={top + r * (cell + gap) + cell * 0.8} fontSize={fs(10)} fill={c.textSubtle}>
              {dayNames[r]}
            </SvgText>
          ))}
          {cells.map((cl, i) => {
            const monthStart = cl.row === 0 && (cl.date.slice(8) <= '07') && (i === 0 || cells[i - 7]?.date.slice(5, 7) !== cl.date.slice(5, 7));
            return (
              <React.Fragment key={cl.date}>
                {monthStart ? (
                  <SvgText x={LABEL_W + cl.col * (cell + gap)} y={11} fontSize={fs(10)} fill={c.textMuted}>
                    {monthFmt.format(new Date(cl.date + 'T00:00:00Z'))}
                  </SvgText>
                ) : null}
                <Rect
                  x={LABEL_W + cl.col * (cell + gap)}
                  y={top + cl.row * (cell + gap)}
                  width={cell}
                  height={cell}
                  rx={Math.min(5, cell / 3)}
                  fill={color(cl.level)}
                  stroke={sel === cl.date ? c.text : 'none'}
                  strokeWidth={sel === cl.date ? 2 : 0}
                  onPress={() => {
                    setSel(cl.date);
                    onSelect?.(cl.date, cl.value);
                  }}
                />
              </React.Fragment>
            );
          })}
        </Svg>
      ) : (
        <View style={{ height }} />
      )}
      <Text variant="caption" tone="muted" accessibilityLiveRegion="polite">
        {selected ? `${new Date(selected.date + 'T00:00:00Z').toLocaleDateString(locale, { dateStyle: 'medium', timeZone: 'UTC' })}: ${formatValue(selected.value)}` : ' '}
      </Text>
    </View>
  );
}
