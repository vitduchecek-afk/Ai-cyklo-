import React, { createContext, useContext, useMemo } from 'react';
import { useColorScheme, type TextStyle } from 'react-native';
import {
  clampFontScale,
  layout,
  motion,
  palettes,
  radii,
  shadows,
  shadowsDark,
  spacing,
  typography,
  type Palette,
  type PaletteName,
  type TextVariant,
  type TypeStyle,
} from '@trailpack/ui';
import { useSettingsStore } from '@/stores/settings';

export interface Theme {
  colors: Palette;
  scheme: PaletteName;
  isDark: boolean;
  fontScale: number;
  spacing: typeof spacing;
  radii: typeof radii;
  shadows: typeof shadows | typeof shadowsDark;
  motion: typeof motion;
  layout: typeof layout;
  /** Scale a font-ish size by the user's font scale. */
  fs: (size: number) => number;
  /** Resolve a text variant into RN style (font scale applied). */
  textStyle: (variant: TextVariant) => TextStyle;
}

const buildTextStyle = (t: TypeStyle, scale: number): TextStyle => ({
  fontSize: Math.round(t.size * scale * 10) / 10,
  lineHeight: Math.round(t.lineHeight * scale),
  fontWeight: t.weight,
  letterSpacing: t.letterSpacing,
});

function createTheme(scheme: PaletteName, fontScale: number): Theme {
  const colors = palettes[scheme];
  return {
    colors,
    scheme,
    isDark: colors.isDark,
    fontScale,
    spacing,
    radii,
    shadows: colors.isDark ? shadowsDark : shadows,
    motion,
    layout,
    fs: (n) => Math.round(n * fontScale * 10) / 10,
    textStyle: (v) => buildTextStyle(typography[v], fontScale),
  };
}

const ThemeContext = createContext<Theme>(createTheme('light', 1));

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const system = useColorScheme();
  const mode = useSettingsStore((s) => s.settings.theme);
  const fontScale = useSettingsStore((s) => s.settings.fontScale);
  const scheme: PaletteName = mode === 'system' ? (system === 'dark' ? 'dark' : 'light') : mode;
  const theme = useMemo(() => createTheme(scheme, clampFontScale(fontScale)), [scheme, fontScale]);
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export const useTheme = (): Theme => useContext(ThemeContext);
