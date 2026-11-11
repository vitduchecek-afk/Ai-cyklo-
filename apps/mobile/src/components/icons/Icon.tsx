import React from 'react';
import Svg, { Path } from 'react-native-svg';
import { ICON_PATHS, type IconName } from './paths';
import { useTheme } from '@/theme/ThemeProvider';

export interface IconProps {
  name: IconName;
  size?: number;
  /** Defaults to the theme text colour. */
  color?: string;
  strokeWidth?: number;
  /** Accessibility label; icons are decorative (hidden) unless given. */
  label?: string;
}

export const Icon = React.memo(function Icon({ name, size = 24, color, strokeWidth = 1.8, label }: IconProps) {
  const theme = useTheme();
  const c = color ?? theme.colors.text;
  const shapes: readonly string[] = ICON_PATHS[name];
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      accessibilityElementsHidden={!label}
      importantForAccessibility={label ? 'yes' : 'no-hide-descendants'}
      accessibilityLabel={label}
      accessibilityRole={label ? 'image' : undefined}
    >
      {shapes.map((s, i) =>
        s.startsWith('f:') ? (
          <Path key={i} d={s.slice(2)} fill={c} stroke={c} strokeWidth={1} strokeLinejoin="round" />
        ) : (
          <Path key={i} d={s} stroke={c} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
        ),
      )}
    </Svg>
  );
});

export type { IconName };
export { ICON_NAMES } from './paths';
