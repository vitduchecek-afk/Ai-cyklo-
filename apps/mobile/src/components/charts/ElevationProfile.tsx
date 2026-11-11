import React, { useMemo, useState } from 'react';
import { PanResponder, Platform, View, type GestureResponderEvent } from 'react-native';
import Svg, { Circle, ClipPath, Defs, G, Line, Path, Rect, Text as SvgText } from 'react-native-svg';
import { KM_PER_MILE, M_PER_FT, type Units } from '@trailpack/shared';
import { useTheme } from '@/theme/ThemeProvider';
import { useT } from '@/i18n';
import { useSettingsStore } from '@/stores/settings';
import { useLatest } from '@/lib/useLatest';
import type { IconName } from '@/components/icons/Icon';
import { SvgIcon } from '@/components/icons/SvgIcon';
import { IconButton } from '@/components/ui/IconButton';
import { useWidth } from './hooks';
import {
  areaPath,
  clamp,
  downsample,
  gradeColor,
  linePath,
  nearestIndex,
  niceDomain,
  niceTicks,
  panWindow,
  scaleLinear,
  zoomWindow,
  type Pt,
  type Window,
} from './math';

export interface ElevationPoint {
  /** Distance from start, metres */
  d: number;
  /** Elevation, metres */
  ele: number;
  gradePct: number;
}
export interface ElevationStage {
  fromD: number;
  toD: number;
  color: string;
  label: string;
}
export type MarkerKind = 'water' | 'camp' | 'summit' | 'danger' | 'poi';
export interface ElevationMarker {
  d: number;
  kind: MarkerKind;
  label: string;
}

export interface ElevationProfileProps {
  points: ElevationPoint[];
  stages?: ElevationStage[];
  markers?: ElevationMarker[];
  /** Called with the scrubbed point index (into `points`) or null when released. */
  onScrub?: (index: number | null) => void;
  /** Externally controlled highlight (e.g. a map hover). */
  highlightIndex?: number | null;
  height?: number;
  /** Override units (defaults to the app setting). */
  units?: Units;
  zoomable?: boolean;
}

const PAD = { left: 44, right: 12, top: 22, bottom: 24 };
const MARKER_ICON: Record<MarkerKind, IconName> = { water: 'water', camp: 'tent', summit: 'mountain', danger: 'warning', poi: 'pin' };

export function ElevationProfile({
  points,
  stages,
  markers,
  onScrub,
  highlightIndex,
  height = 230,
  units: unitsProp,
  zoomable = true,
}: ElevationProfileProps) {
  const { colors: c, fs } = useTheme();
  const { t, locale } = useT();
  const settingsUnits = useSettingsStore((s) => s.settings.units);
  const units = unitsProp ?? settingsUnits;
  const [width, onLayout] = useWidth();
  const total = points.length ? (points[points.length - 1] as ElevationPoint).d : 0;
  const bounds: Window = [0, Math.max(1, total)];
  const [win, setWin] = useState<Window>(bounds);
  const [scrub, setScrub] = useState<number | null>(null);

  // Reset the window when the dataset changes length.
  const [lastTotal, setLastTotal] = useState(total);
  if (lastTotal !== total) {
    setLastTotal(total);
    setWin([0, Math.max(1, total)]);
  }

  const dUnit = units === 'imperial' ? KM_PER_MILE * 1000 : 1000;
  const dLabel = units === 'imperial' ? 'mi' : 'km';
  const eUnit = units === 'imperial' ? M_PER_FT : 1;
  const eLabel = units === 'imperial' ? 'ft' : 'm';
  const fmtNum = (v: number, max = 1) => v.toLocaleString(locale, { maximumFractionDigits: max });

  const plotW = Math.max(10, width - PAD.left - PAD.right);
  const plotH = Math.max(10, height - PAD.top - PAD.bottom - (win[1] - win[0] < total - 1 ? 0 : 0));
  const minSpan = Math.max(250, total / 60);
  const zoomed = win[1] - win[0] < total - 1;

  const ds = useMemo(() => points.map((p) => p.d), [points]);

  // visible slice (+1 neighbour each side so lines reach the edge)
  const { visible } = useMemo(() => {
    if (!points.length) return { visible: [] as ElevationPoint[] };
    let a = nearestIndex(ds, win[0]);
    let b = nearestIndex(ds, win[1]);
    if ((ds[a] as number) > win[0]) a = Math.max(0, a - 1);
    if ((ds[b] as number) < win[1]) b = Math.min(points.length - 1, b + 1);
    a = Math.max(0, a - 1);
    b = Math.min(points.length - 1, b + 1);
    return { visible: points.slice(a, b + 1) };
  }, [points, ds, win]);

  const x = scaleLinear(win, [0, plotW]);
  const eles = visible.map((p) => p.ele);
  const [yMin, yMax] = niceDomain(Math.min(...eles, Infinity) === Infinity ? 0 : Math.min(...eles), Math.max(...eles, -Infinity) === -Infinity ? 1 : Math.max(...eles), 4);
  const y = scaleLinear([yMin, yMax], [plotH, 0]);

  const dsPts: Pt[] = useMemo(
    () => downsample(visible.map((p) => ({ x: p.d, y: p.ele })), Math.max(30, Math.round(plotW * 1.2))),
    [visible, plotW],
  );
  const px: Pt[] = dsPts.map((p) => ({ x: x(p.x), y: y(p.y) }));
  // grade for each downsampled point = nearest original grade
  const gradeOf = (d: number) => (points[nearestIndex(ds, d)] as ElevationPoint | undefined)?.gradePct ?? 0;

  // runs of equal grade colour → one polygon each
  const runs = useMemo(() => {
    const out: { color: string; pts: Pt[] }[] = [];
    for (let i = 0; i < dsPts.length - 1; i++) {
      const a = dsPts[i] as Pt;
      const b = dsPts[i + 1] as Pt;
      const color = gradeColor(gradeOf((a.x + b.x) / 2));
      const pa = { x: x(a.x), y: y(a.y) };
      const pb = { x: x(b.x), y: y(b.y) };
      const last = out[out.length - 1];
      if (last && last.color === color) last.pts.push(pb);
      else out.push({ color, pts: [pa, pb] });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dsPts, win, yMin, yMax, plotW, plotH]);

  const active = scrub ?? (highlightIndex != null && highlightIndex >= 0 && highlightIndex < points.length ? highlightIndex : null);
  const activePt = active != null ? points[active] : undefined;

  const scrubAt = (lx: number) => {
    if (!points.length) return;
    const idx = nearestIndex(ds, x.invert(clamp(lx - PAD.left, 0, plotW)));
    setScrub(idx);
    onScrub?.(idx);
  };
  const endScrub = () => {
    setScrub(null);
    onScrub?.(null);
  };

  const latest = useLatest({ scrubAt, endScrub });
  const [pan] = useState(() =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e: GestureResponderEvent) => latest.current.scrubAt(e.nativeEvent.locationX),
      onPanResponderMove: (e: GestureResponderEvent) => latest.current.scrubAt(e.nativeEvent.locationX),
      onPanResponderRelease: () => latest.current.endScrub(),
      onPanResponderTerminate: () => latest.current.endScrub(),
    }),
  );

  const zoomBy = (f: number, center?: number) => setWin((w) => zoomWindow(w, f, center ?? (w[0] + w[1]) / 2, bounds, minSpan));

  // overview strip drag (pan the window)
  const [stripW, onStripLayout] = useWidth();
  const stripScale = scaleLinear(bounds, [0, Math.max(1, stripW)]);
  const winRef = useLatest({ win, stripScale, bounds });
  const [stripPan] = useState(() => {
    let startWin: Window = [0, 1];
    let startX = 0;
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => {
        const { win: w, stripScale: s } = winRef.current;
        const d = s.invert(e.nativeEvent.locationX);
        startWin = w;
        startX = e.nativeEvent.pageX;
        // tap outside window → centre it there
        if (d < w[0] || d > w[1]) {
          const half = (w[1] - w[0]) / 2;
          setWin(zoomWindow([d - half, d + half], 1, d, winRef.current.bounds, 1));
          startWin = [d - half, d + half];
        }
      },
      onPanResponderMove: (e) => {
        const { stripScale: s, bounds: b } = winRef.current;
        const dd = s.invert(e.nativeEvent.pageX) - s.invert(startX);
        setWin(panWindow(startWin, dd, b));
      },
    });
  });

  const webWheel =
    Platform.OS === 'web' && zoomable
      ? ({
          onWheel: (e: { deltaY: number; nativeEvent?: { offsetX: number }; preventDefault?: () => void }) => {
            const off = (e.nativeEvent?.offsetX ?? 0) - PAD.left;
            zoomBy(e.deltaY < 0 ? 1.25 : 0.8, x.invert(clamp(off, 0, plotW)));
          },
          onMouseMove: (e: { nativeEvent: { offsetX: number } }) => scrubAt(e.nativeEvent.offsetX),
          onMouseLeave: () => endScrub(),
        } as object)
      : null;

  const xTicks = niceTicks(win[0] / dUnit, win[1] / dUnit, Math.max(3, Math.floor(plotW / 80))).map((v) => v * dUnit);
  const yTicks = niceTicks(yMin / eUnit, yMax / eUnit, 4).map((v) => v * eUnit);

  const ascent = useMemo(() => {
    let a = 0;
    for (let i = 1; i < points.length; i++) a += Math.max(0, (points[i] as ElevationPoint).ele - (points[i - 1] as ElevationPoint).ele);
    return a;
  }, [points]);

  const tipLines = activePt
    ? [
        `${fmtNum(activePt.d / dUnit, 2)} ${dLabel}`,
        `${fmtNum(activePt.ele / eUnit, 0)} ${eLabel}  ·  ${activePt.gradePct > 0 ? '+' : ''}${fmtNum(activePt.gradePct, 1)} %`,
      ]
    : [];
  const tipW = 132 * Math.max(1, fs(1) * 0.95);
  const tipH = 20 + 16 * fs(1);

  if (!points.length) return <View style={{ height }} onLayout={onLayout} />;

  return (
    <View onLayout={onLayout} style={{ gap: 8 }}>
      <View
        {...webWheel}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={`${t('routes.elevation')}: ${fmtNum(total / dUnit, 1)} ${dLabel}, +${fmtNum(ascent / eUnit, 0)} ${eLabel}`}
        accessibilityValue={activePt ? { text: tipLines.join(', ') } : undefined}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(e) => {
          const step = Math.max(1, Math.round(points.length / 40));
          const cur = scrub ?? 0;
          const next = clamp(cur + (e.nativeEvent.actionName === 'increment' ? step : -step), 0, points.length - 1);
          setScrub(next);
          onScrub?.(next);
        }}
        style={{ height, width: '100%' }}
      >
        {width > 0 ? (
          <Svg width={width} height={height}>
            <Defs>
              <ClipPath id="plot">
                <Rect x={0} y={0} width={plotW} height={plotH} />
              </ClipPath>
            </Defs>
            <G x={PAD.left} y={PAD.top}>
              {/* grid + y labels */}
              {yTicks.map((v) => (
                <G key={`y${v}`}>
                  <Line x1={0} x2={plotW} y1={y(v)} y2={y(v)} stroke={c.border} strokeWidth={1} strokeDasharray="3 4" />
                  <SvgText x={-8} y={y(v) + 4} fontSize={fs(11)} fill={c.textSubtle} textAnchor="end">
                    {fmtNum(v / eUnit, 0)}
                  </SvgText>
                </G>
              ))}
              {xTicks.map((v) => (
                <SvgText key={`x${v}`} x={x(v)} y={plotH + 16} fontSize={fs(11)} fill={c.textSubtle} textAnchor="middle">
                  {fmtNum(v / dUnit, v / dUnit < 10 ? 1 : 0)} {dLabel}
                </SvgText>
              ))}
              <SvgText x={-8} y={-8} fontSize={fs(10)} fill={c.textSubtle} textAnchor="end">
                {eLabel}
              </SvgText>

              <G clipPath="url(#plot)">
                {stages?.map((s, i) => {
                  const x0 = clamp(x(s.fromD), 0, plotW);
                  const x1 = clamp(x(s.toD), 0, plotW);
                  if (x1 <= x0) return null;
                  return (
                    <G key={`s${i}`}>
                      <Rect x={x0} y={0} width={x1 - x0} height={plotH} fill={s.color} opacity={0.12} />
                      <Line x1={x0} x2={x0} y1={0} y2={plotH} stroke={s.color} strokeWidth={1.5} strokeDasharray="5 4" />
                      <SvgText x={x0 + 6} y={14} fontSize={fs(11)} fontWeight="700" fill={s.color}>
                        {s.label}
                      </SvgText>
                    </G>
                  );
                })}
                {runs.map((r, i) => (
                  <Path key={i} d={areaPath(r.pts, plotH)} fill={r.color} opacity={0.62} />
                ))}
                <Path d={linePath(px)} stroke={c.text} strokeWidth={2.2} fill="none" strokeLinejoin="round" strokeLinecap="round" />
              </G>

              {/* markers */}
              {markers?.map((m, i) => {
                if (m.d < win[0] || m.d > win[1]) return null;
                const mx = x(m.d);
                const my = y((points[nearestIndex(ds, m.d)] as ElevationPoint).ele);
                const col = m.kind === 'water' ? c.water : m.kind === 'camp' ? c.camp : m.kind === 'danger' ? c.danger : m.kind === 'summit' ? c.text : c.info;
                return (
                  <G key={`m${i}`}>
                    <Line x1={mx} x2={mx} y1={my} y2={-2} stroke={col} strokeWidth={1.2} strokeDasharray="2 3" />
                    <Circle cx={mx} cy={-2} r={11} fill={c.surface} stroke={col} strokeWidth={1.6} />
                    <SvgIcon name={MARKER_ICON[m.kind]} x={mx - 7} y={-9} size={14} color={col} strokeWidth={2} />
                  </G>
                );
              })}

              {/* crosshair */}
              {activePt ? (
                <G>
                  <Line x1={x(activePt.d)} x2={x(activePt.d)} y1={0} y2={plotH} stroke={c.text} strokeWidth={1.2} />
                  <Circle cx={x(activePt.d)} cy={y(activePt.ele)} r={6} fill={gradeColor(activePt.gradePct)} stroke={c.surface} strokeWidth={2.5} />
                  {(() => {
                    const ax = x(activePt.d);
                    const tx = clamp(ax - tipW / 2, 0, plotW - tipW);
                    const ty = y(activePt.ele) > tipH + 24 ? y(activePt.ele) - tipH - 12 : y(activePt.ele) + 14;
                    return (
                      <G>
                        <Rect x={tx} y={ty} width={tipW} height={tipH} rx={8} fill={c.isDark ? c.surfaceAlt : '#1D2420'} opacity={0.96} />
                        {tipLines.map((l, i) => (
                          <SvgText key={i} x={tx + 10} y={ty + 8 + (i + 1) * fs(14)} fontSize={fs(i === 0 ? 12 : 11.5)} fontWeight={i === 0 ? '700' : '500'} fill={c.isDark ? c.text : '#FFFFFF'}>
                            {l}
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
        {/* gesture surface */}
        <View {...pan.panHandlers} style={{ position: 'absolute', left: PAD.left, right: PAD.right, top: 0, bottom: 0 }} />
        {zoomable ? (
          <View style={{ position: 'absolute', right: 4, top: -2, flexDirection: 'row' }}>
            {zoomed ? <IconButton icon="close" label={t('common.reset')} size={40} iconSize={18} onPress={() => setWin(bounds)} /> : null}
            <IconButton icon="plus" label={t('map.zoomIn')} size={40} iconSize={18} variant="surface" onPress={() => zoomBy(1.6)} />
            <IconButton icon="minus" label={t('map.zoomOut')} size={40} iconSize={18} variant="surface" onPress={() => zoomBy(1 / 1.6)} />
          </View>
        ) : null}
      </View>

      {zoomed ? (
        <View onLayout={onStripLayout} {...stripPan.panHandlers} style={{ height: 34, marginLeft: PAD.left, marginRight: PAD.right, justifyContent: 'center' }}>
          {stripW > 0 ? (
            <Svg width={stripW} height={34}>
              <Rect x={0} y={4} width={stripW} height={26} rx={6} fill={c.surfaceAlt} />
              <Path
                d={linePath(
                  downsample(points.map((p) => ({ x: p.d, y: p.ele })), 60).map((p) => ({
                    x: stripScale(p.x),
                    y: 28 - ((p.y - Math.min(...points.map((q) => q.ele))) / Math.max(1, Math.max(...points.map((q) => q.ele)) - Math.min(...points.map((q) => q.ele)))) * 22,
                  })),
                )}
                stroke={c.textSubtle}
                strokeWidth={1.5}
                fill="none"
              />
              <Rect x={stripScale(win[0])} y={2} width={Math.max(8, stripScale(win[1]) - stripScale(win[0]))} height={30} rx={7} fill={c.primary} opacity={0.22} stroke={c.primary} strokeWidth={2} />
            </Svg>
          ) : null}
        </View>
      ) : null}

    </View>
  );
}
