/** Design tokens: spacing, radii, typography, shadows, motion. Pure data. */

export const spacing = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 } as const;

export const radii = { xs: 6, sm: 10, md: 14, lg: 20, xl: 28, pill: 999 } as const;

/** Minimum touch target in dp (WCAG 2.5.5 / Material 48dp). */
export const MIN_TOUCH = 48;

export const FONT_SCALE_MIN = 0.8;
export const FONT_SCALE_MAX = 1.6;
export const clampFontScale = (v: number): number => Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, v));

export type TextVariant =
  | 'display'
  | 'title'
  | 'heading'
  | 'subheading'
  | 'body'
  | 'bodyStrong'
  | 'label'
  | 'caption'
  | 'overline'
  | 'mono';

export interface TypeStyle {
  size: number;
  lineHeight: number;
  weight: '400' | '500' | '600' | '700' | '800';
  letterSpacing?: number;
  uppercase?: boolean;
}

export const typography: Record<TextVariant, TypeStyle> = {
  display: { size: 34, lineHeight: 40, weight: '800', letterSpacing: -0.6 },
  title: { size: 26, lineHeight: 32, weight: '700', letterSpacing: -0.3 },
  heading: { size: 20, lineHeight: 26, weight: '700', letterSpacing: -0.15 },
  subheading: { size: 17, lineHeight: 23, weight: '600' },
  body: { size: 16, lineHeight: 23, weight: '400' },
  bodyStrong: { size: 16, lineHeight: 23, weight: '600' },
  label: { size: 14, lineHeight: 19, weight: '600', letterSpacing: 0.1 },
  caption: { size: 13, lineHeight: 18, weight: '400' },
  overline: { size: 12, lineHeight: 16, weight: '700', letterSpacing: 1, uppercase: true },
  mono: { size: 14, lineHeight: 20, weight: '500' },
};

export const monoFamily = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/** Cross-platform CSS box shadows (React Native >= 0.76 `boxShadow`). */
export const shadows = {
  none: 'none',
  sm: '0 1px 2px rgba(20,30,22,0.08), 0 1px 3px rgba(20,30,22,0.06)',
  md: '0 4px 12px rgba(20,30,22,0.10), 0 2px 4px rgba(20,30,22,0.06)',
  lg: '0 12px 28px rgba(20,30,22,0.18), 0 4px 10px rgba(20,30,22,0.08)',
} as const;

export const shadowsDark = {
  none: 'none',
  sm: '0 1px 2px rgba(0,0,0,0.5)',
  md: '0 4px 12px rgba(0,0,0,0.55)',
  lg: '0 12px 28px rgba(0,0,0,0.65)',
} as const;

export const motion = {
  duration: { instant: 80, fast: 140, base: 220, slow: 340 },
  /** cubic-bezier control points */
  easing: {
    standard: [0.2, 0, 0, 1] as const,
    decelerate: [0, 0, 0, 1] as const,
    accelerate: [0.3, 0, 1, 1] as const,
  },
  spring: { gentle: { damping: 20, stiffness: 180 }, snappy: { damping: 18, stiffness: 320 } },
} as const;

export const layout = {
  /** Width at which the app switches to the sidebar layout. */
  wideBreakpoint: 900,
  maxContentWidth: 1040,
  tabBarHeight: 64,
  sidebarWidth: 248,
} as const;
