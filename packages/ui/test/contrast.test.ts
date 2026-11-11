import { describe, expect, it } from 'vitest';
import { contrastRatio, palettes, type Palette } from '../src';

const text = (p: Palette): Array<[string, string, string]> => {
  const min = p.name === 'outdoor' ? 7 : 4.5;
  void min;
  const bgs = { bg: p.bg, surface: p.surface, surfaceAlt: p.surfaceAlt };
  const pairs: Array<[string, string, string]> = [];
  for (const [bn, b] of Object.entries(bgs)) {
    pairs.push([`text/${bn}`, p.text, b], [`textMuted/${bn}`, p.textMuted, b], [`textSubtle/${bn}`, p.textSubtle, b]);
    pairs.push([`primary/${bn}`, p.primary, b]);
  }
  pairs.push(['onPrimary/primary', p.onPrimary, p.primary]);
  pairs.push(['onPrimary/primaryPressed', p.onPrimary, p.primaryPressed]);
  pairs.push(['onPrimarySoft/primarySoft', p.onPrimarySoft, p.primarySoft]);
  pairs.push(['onAccentSoft/accentSoft', p.onAccentSoft, p.accentSoft]);
  pairs.push(['onDanger/danger', p.onDanger, p.danger]);
  pairs.push(['text/surfaceSunken', p.text, p.surfaceSunken]);
  pairs.push(['textMuted/surfaceSunken', p.textMuted, p.surfaceSunken]);
  for (const k of ['success', 'warning', 'danger', 'info', 'water', 'camp'] as const) {
    const soft = p[`${k}Soft` as const];
    pairs.push([`${k}/surface`, p[k], p.surface], [`${k}/bg`, p[k], p.bg], [`${k}/${k}Soft`, p[k], soft]);
  }
  return pairs;
};

describe.each(Object.values(palettes))('palette $name', (p) => {
  it.each(text(p))('text pair %s >= 4.5:1', (_n, fg, bg) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it('control borders and focus ring are >= 3:1 on surface', () => {
    expect(contrastRatio(p.borderStrong, p.surface)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(p.focus, p.surface)).toBeGreaterThanOrEqual(3);
  });

  it('has 8 distinct day colours, each >= 3:1 on surface and bg', () => {
    expect(new Set(p.days).size).toBe(8);
    for (const c of p.days) {
      expect(contrastRatio(c, p.surface)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(c, p.bg)).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('outdoor palette', () => {
  it('reaches AAA (7:1) for body text', () => {
    const p = palettes.outdoor;
    for (const c of [p.text, p.textMuted, p.textSubtle]) expect(contrastRatio(c, p.surface)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(p.onPrimary, p.primary)).toBeGreaterThanOrEqual(7);
  });
});

describe('contrastRatio', () => {
  it('black on white is 21', () => expect(contrastRatio('#000', '#fff')).toBeCloseTo(21, 5));
});
