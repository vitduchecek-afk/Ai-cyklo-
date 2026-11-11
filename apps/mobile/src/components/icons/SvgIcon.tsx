import React from 'react';
import { G, Path } from 'react-native-svg';
import { ICON_PATHS, type IconName } from './paths';

/** Draw an icon inside an existing <Svg> (e.g. chart markers). `x`,`y` = top-left. */
export function SvgIcon({ name, x, y, size = 16, color, strokeWidth = 2 }: { name: IconName; x: number; y: number; size?: number; color: string; strokeWidth?: number }) {
  const s = size / 24;
  const shapes: readonly string[] = ICON_PATHS[name];
  return (
    <G transform={`translate(${x} ${y}) scale(${s})`}>
      {shapes.map((d, i) =>
        d.startsWith('f:') ? (
          <Path key={i} d={d.slice(2)} fill={color} stroke={color} strokeWidth={1} />
        ) : (
          <Path key={i} d={d} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
        ),
      )}
    </G>
  );
}
