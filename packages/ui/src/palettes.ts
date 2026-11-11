/**
 * TrailPack colour palettes. Brand: forest green, dark green, sand, soft beige,
 * white, graphite. Every text/background pairing is covered by the contrast
 * test in `packages/ui/test` (WCAG AA 4.5:1 text, 3:1 graphics; `outdoor` AAA).
 */
export type PaletteName = 'light' | 'dark' | 'outdoor';

export interface Palette {
  name: PaletteName;
  isDark: boolean;
  /** App background (soft beige / deep forest night). */
  bg: string;
  surface: string;
  surfaceAlt: string;
  surfaceSunken: string;
  border: string;
  /** Border of interactive controls (>= 3:1 on surface). */
  borderStrong: string;
  overlay: string;
  text: string;
  textMuted: string;
  textSubtle: string;
  textInverse: string;
  primary: string;
  primaryPressed: string;
  onPrimary: string;
  primarySoft: string;
  onPrimarySoft: string;
  /** Sand accent. */
  accent: string;
  accentSoft: string;
  onAccentSoft: string;
  success: string;
  successSoft: string;
  warning: string;
  warningSoft: string;
  danger: string;
  dangerSoft: string;
  onDanger: string;
  info: string;
  infoSoft: string;
  water: string;
  waterSoft: string;
  camp: string;
  campSoft: string;
  focus: string;
  /** Eight distinguishable day / series colours (>= 3:1 on surface). */
  days: [string, string, string, string, string, string, string, string];
}

export const lightPalette: Palette = {
  name: 'light',
  isDark: false,
  bg: '#F5F1E6',
  surface: '#FFFFFF',
  surfaceAlt: '#EEE8D8',
  surfaceSunken: '#E7E0CC',
  border: '#DDD5BF',
  borderStrong: '#7B806F',
  overlay: 'rgba(16,24,18,0.5)',
  text: '#1D2420',
  textMuted: '#454E48',
  textSubtle: '#5C655E',
  textInverse: '#FFFFFF',
  primary: '#2C6A3E',
  primaryPressed: '#1F5230',
  onPrimary: '#FFFFFF',
  primarySoft: '#DCEBDC',
  onPrimarySoft: '#1B4A2A',
  accent: '#B8935A',
  accentSoft: '#F0E4C8',
  onAccentSoft: '#5A4318',
  success: '#1C7336',
  successSoft: '#DDF0E0',
  warning: '#8A5300',
  warningSoft: '#FCEBC6',
  danger: '#B3261E',
  dangerSoft: '#FADDDA',
  onDanger: '#FFFFFF',
  info: '#1D5CA3',
  infoSoft: '#DCE9F8',
  water: '#0A6B94',
  waterSoft: '#D6EEF8',
  camp: '#7A4824',
  campSoft: '#F1E1D2',
  focus: '#1D5CA3',
  days: ['#C2410C', '#1D5CA3', '#2C6A3E', '#7E3FA0', '#9A6700', '#0E7490', '#BE185D', '#4D5A68'],
};

export const darkPalette: Palette = {
  name: 'dark',
  isDark: true,
  bg: '#0F1511',
  surface: '#171F19',
  surfaceAlt: '#1F2922',
  surfaceSunken: '#0B100D',
  border: '#2B382E',
  borderStrong: '#7D8D80',
  overlay: 'rgba(0,0,0,0.65)',
  text: '#EDF1EA',
  textMuted: '#B5BFB6',
  textSubtle: '#98A39A',
  textInverse: '#0B1A10',
  primary: '#7CC48B',
  primaryPressed: '#97D3A4',
  onPrimary: '#0B1A10',
  primarySoft: '#21402B',
  onPrimarySoft: '#B4E2BD',
  accent: '#D3B27A',
  accentSoft: '#3A3020',
  onAccentSoft: '#EBD6AC',
  success: '#6FCF86',
  successSoft: '#1B3A24',
  warning: '#F0B84F',
  warningSoft: '#41300E',
  danger: '#FF8A80',
  dangerSoft: '#4A1D1A',
  onDanger: '#2B0705',
  info: '#8DB9F0',
  infoSoft: '#1B2F4A',
  water: '#6CC4E8',
  waterSoft: '#14323F',
  camp: '#D9A579',
  campSoft: '#3A2818',
  focus: '#8DB9F0',
  days: ['#FF9466', '#7FB0F0', '#7CC48B', '#C79BE0', '#E3B341', '#5CC8DC', '#F27AAE', '#A9B6C4'],
};

/** High-contrast "outdoor" palette for direct sunlight (AAA text). */
export const outdoorPalette: Palette = {
  name: 'outdoor',
  isDark: false,
  bg: '#FFFFFF',
  surface: '#FFFFFF',
  surfaceAlt: '#F0EDE2',
  surfaceSunken: '#E2DDCC',
  border: '#1D2420',
  borderStrong: '#000000',
  overlay: 'rgba(0,0,0,0.6)',
  text: '#000000',
  textMuted: '#1D2420',
  textSubtle: '#33403A',
  textInverse: '#FFFFFF',
  primary: '#0F4A22',
  primaryPressed: '#0A3517',
  onPrimary: '#FFFFFF',
  primarySoft: '#D5EBD9',
  onPrimarySoft: '#06240F',
  accent: '#8A5F1C',
  accentSoft: '#F3E6C6',
  onAccentSoft: '#3A2605',
  success: '#0B5B22',
  successSoft: '#D5EBD9',
  warning: '#6B3F00',
  warningSoft: '#FBE7B5',
  danger: '#8F1410',
  dangerSoft: '#F8D3D0',
  onDanger: '#FFFFFF',
  info: '#0F4580',
  infoSoft: '#D3E4F8',
  water: '#074F70',
  waterSoft: '#CBE8F5',
  camp: '#5E3416',
  campSoft: '#EFDAC6',
  focus: '#0F4580',
  days: ['#A63200', '#0F4580', '#0F4A22', '#5C1F80', '#7A5000', '#085A70', '#9B1049', '#2F3A46'],
};

export const palettes: Record<PaletteName, Palette> = {
  light: lightPalette,
  dark: darkPalette,
  outdoor: outdoorPalette,
};

/** Colours of the elevation grade ramp (theme independent, used on charts/maps). */
export const gradeRamp = {
  steepDown: '#2C7FB8',
  down: '#5AB4AC',
  flat: '#6BAF5B',
  up: '#E0B93A',
  steepUp: '#E8832A',
  extreme: '#C8352B',
} as const;

/** Legal status colours map onto semantic palette keys. */
export type LegalStatus = 'verified_allowed' | 'conditional' | 'prohibited' | 'unverified';
