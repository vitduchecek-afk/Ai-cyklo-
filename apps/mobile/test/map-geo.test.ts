import { describe, expect, it } from 'vitest';
import { bboxOf, collectPositions, formatCoords, formatCoordsPlain, formatMeasure, haversine, normBearing, pathLength } from '../src/components/map/geo';

describe('haversine', () => {
  it('Prague → Brno is ~184 km', () => {
    const d = haversine([14.4378, 50.0755], [16.6068, 49.1951]);
    expect(d / 1000).toBeGreaterThan(183);
    expect(d / 1000).toBeLessThan(186);
  });
  it('is zero for identical points and symmetric', () => {
    expect(haversine([10, 10], [10, 10])).toBe(0);
    const a = haversine([0, 0], [1, 1]);
    expect(haversine([1, 1], [0, 0])).toBeCloseTo(a, 6);
  });
  it('one degree of latitude ≈ 111.2 km', () => {
    expect(haversine([0, 0], [0, 1])).toBeCloseTo(111_195, -2);
  });
});

describe('pathLength / bbox / positions', () => {
  const pts: [number, number][] = [
    [14, 50],
    [14, 51],
    [15, 51],
  ];
  it('sums segments', () => {
    expect(pathLength(pts)).toBeCloseTo(haversine(pts[0]!, pts[1]!) + haversine(pts[1]!, pts[2]!), 3);
    expect(pathLength([])).toBe(0);
  });
  it('computes bbox', () => {
    expect(bboxOf(pts)).toEqual([14, 50, 15, 51]);
    expect(bboxOf([])).toBeNull();
  });
  it('collects nested positions', () => {
    const fc = {
      features: [
        { geometry: { type: 'LineString', coordinates: [[1, 2], [3, 4]] } },
        { geometry: { type: 'Point', coordinates: [5, 6] } },
        { geometry: { type: 'MultiLineString', coordinates: [[[7, 8, 100]]] } },
      ],
    };
    expect(collectPositions(fc)).toEqual([[1, 2], [3, 4], [5, 6], [7, 8]]);
  });
});

describe('formatting', () => {
  it('formats coordinates with hemispheres', () => {
    expect(formatCoords(50.07554, 14.4378)).toBe('50.07554° N, 14.43780° E');
    expect(formatCoords(-33.8688, -70.5)).toBe('33.86880° S, 70.50000° W');
    expect(formatCoordsPlain(50.07554, 14.4378)).toBe('50.07554, 14.43780');
  });
  it('formats measure distance', () => {
    expect(formatMeasure(420, 'metric', 'en-GB')).toBe('420 m');
    expect(formatMeasure(12_345, 'metric', 'en-GB')).toBe('12.35 km');
    expect(formatMeasure(1609.344, 'imperial', 'en-GB')).toBe('1 mi');
  });
  it('normalises bearings', () => {
    expect(normBearing(-90)).toBe(270);
    expect(normBearing(450)).toBe(90);
  });
});
