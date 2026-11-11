import { describe, expect, it } from 'vitest';
import { TrailPackError } from '@trailpack/shared';
import {
  detectFormat,
  exportGeoJson,
  exportGpx,
  exportKml,
  importRouteFile,
  parseGeoJson,
  parseGpx,
  parseKml,
  renderTripReportHtml,
} from '../src';
import type { TripReportData } from '../src';

const GPX11 = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Test" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
  <metadata><name>Krkonoše &amp; okolí</name><desc>Popis</desc><time>2024-07-01T06:00:00Z</time></metadata>
  <wpt lat="50.736" lon="15.739"><ele>1603</ele><name>Sněžka</name><sym>Summit</sym></wpt>
  <trk><name>Den 1</name>
    <trkseg>
      <trkpt lat="50.7000" lon="15.7000"><ele>900</ele><time>2024-07-01T06:00:00Z</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>120</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>
      <trkpt lat="50.7100" lon="15.7000"><ele>1000</ele><time>2024-07-01T06:20:00Z</time></trkpt>
    </trkseg>
    <trkseg>
      <trkpt lat="50.7200" lon="15.7000"><ele>1100</ele></trkpt>
      <trkpt lat="999" lon="15.7000"><ele>1100</ele></trkpt>
    </trkseg>
  </trk>
  <rte><name>R</name><rtept lat="50.1" lon="14.1"/><rtept lat="50.2" lon="14.2"/></rte>
</gpx>`;

describe('parseGpx', () => {
  it('parses GPX 1.1 tracks, segments, routes, waypoints and ignores extensions', () => {
    const g = parseGpx(GPX11);
    expect(g.name).toBe('Krkonoše & okolí');
    expect(g.time).toBe('2024-07-01T06:00:00.000Z');
    expect(g.tracks).toHaveLength(1);
    expect(g.tracks[0]!.segments).toHaveLength(2);
    expect(g.tracks[0]!.segments[0]![0]).toMatchObject({ lat: 50.7, lon: 15.7, ele: 900, time: Date.parse('2024-07-01T06:00:00Z') });
    expect(g.routes[0]!.points).toHaveLength(2);
    expect(g.waypoints[0]).toMatchObject({ name: 'Sněžka', sym: 'Summit', ele: 1603 });
    expect(g.warnings.join(' ')).toContain('neplatnými souřadnicemi');
  });

  it('handles prefixed namespaces and GPX 1.0', () => {
    const g = parseGpx(
      `<gpx:gpx version="1.0" creator="x" xmlns:gpx="http://www.topografix.com/GPX/1/0"><gpx:name>Old</gpx:name><gpx:trk><gpx:trkseg><gpx:trkpt lat="1" lon="2"><gpx:ele>3</gpx:ele></gpx:trkpt></gpx:trkseg></gpx:trk></gpx:gpx>`,
    );
    expect(g.version).toBe('1.0');
    expect(g.name).toBe('Old');
    expect(g.tracks[0]!.segments[0]![0]).toMatchObject({ lat: 1, lon: 2, ele: 3 });
  });

  it('rejects DOCTYPE / ENTITY (XXE, billion laughs)', () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE gpx [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><gpx version="1.1"><metadata><name>&xxe;</name></metadata></gpx>`;
    expect(() => parseGpx(xxe)).toThrowError(TrailPackError);
    try {
      parseGpx(xxe);
    } catch (e) {
      expect((e as TrailPackError).code).toBe('parse_error');
      expect((e as TrailPackError).message).toMatch(/entit/);
    }
    expect(() => parseGpx('<?xml version="1.0"?><!DOCTYPE gpx><gpx version="1.1"/>')).toThrow(/DOCTYPE/);
  });

  it('reports malformed XML, non-GPX and oversize in Czech', () => {
    expect(() => parseGpx('<gpx><trk>')).toThrow(/není platné XML/);
    expect(() => parseGpx('<kml/>')).toThrow(/není ve formátu GPX/);
    expect(() => parseGpx('')).toThrow(/prázdný/);
    try {
      parseGpx(GPX11, { maxBytes: 100 });
      expect.unreachable();
    } catch (e) {
      expect((e as TrailPackError).code).toBe('too_large');
      expect((e as TrailPackError).message).toMatch(/příliš velký/);
    }
  });
});

describe('exportGpx', () => {
  it('produces valid GPX 1.1 that round-trips and escapes text', () => {
    const xml = exportGpx({
      name: 'Trasa <A&B> "x"',
      description: 'Popis',
      author: 'Jan',
      time: '2024-07-01T06:00:00Z',
      tracks: [{ name: 'T', points: [[15.7, 50.7, 900], { lat: 50.71, lon: 15.7, ele: 1000.04, time: Date.parse('2024-07-01T06:20:00Z') }] }],
      routes: [{ name: 'R', points: [[14.1, 50.1], [14.2, 50.2]] }],
      waypoints: [{ lat: 50.736, lon: 15.739, ele: 1603, name: 'Sněžka & <b>' }],
    });
    expect(xml).toContain('creator="TrailPack"');
    expect(xml).toContain('xmlns="http://www.topografix.com/GPX/1/1"');
    expect(xml).toContain('<name>Trasa &lt;A&amp;B&gt; &quot;x&quot;</name>');
    expect(xml).toContain('<time>2024-07-01T06:00:00.000Z</time>');
    expect(xml).toContain('<ele>1000</ele>');
    const back = parseGpx(xml);
    expect(back.name).toBe('Trasa <A&B> "x"');
    expect(back.author).toBe('Jan');
    expect(back.tracks[0]!.segments[0]).toHaveLength(2);
    expect(back.tracks[0]!.segments[0]![1]!.time).toBe(Date.parse('2024-07-01T06:20:00Z'));
    expect(back.routes[0]!.points).toHaveLength(2);
    expect(back.waypoints[0]!.name).toBe('Sněžka & <b>');
  });

  it('rejects invalid coordinates', () => {
    expect(() => exportGpx({ name: 'x', tracks: [{ points: [[0, 95]] }] })).toThrow(TrailPackError);
  });
});

describe('KML', () => {
  const KML = `<?xml version="1.0"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2"><Document><name>Doc</name>
 <Folder><Placemark><name>Line</name><LineString><coordinates>15.7,50.7,900 15.7,50.71,950</coordinates></LineString></Placemark></Folder>
 <Placemark><name>Pt</name><Point><coordinates>15.739,50.736,1603</coordinates></Point></Placemark>
 <Placemark><name>Multi</name><MultiGeometry><LineString><coordinates>1,2 3,4</coordinates></LineString><LineString><coordinates>5,6 7,8</coordinates></LineString></MultiGeometry></Placemark>
 <Placemark><name>Track</name><gx:Track><when>2024-07-01T06:00:00Z</when><when>2024-07-01T06:10:00Z</when><gx:coord>15.7 50.7 900</gx:coord><gx:coord>15.71 50.7 910</gx:coord></gx:Track></Placemark>
</Document></kml>`;

  it('parses LineString, MultiGeometry, Point and gx:Track', () => {
    const k = parseKml(KML);
    expect(k.name).toBe('Doc');
    expect(k.lines.map((l) => l.kind).sort()).toEqual(['LineString', 'LineString', 'LineString', 'Track']);
    expect(k.lines.find((l) => l.name === 'Line')!.points[1]).toMatchObject({ lon: 15.7, lat: 50.71, ele: 950 });
    expect(k.points[0]).toMatchObject({ name: 'Pt', ele: 1603 });
    const track = k.lines.find((l) => l.kind === 'Track')!;
    expect(track.points[1]).toMatchObject({ lon: 15.71, ele: 910, time: Date.parse('2024-07-01T06:10:00Z') });
  });

  it('export → parse round trip', () => {
    const xml = exportKml({ name: 'A & B', lines: [{ name: 'L', points: [[15, 50, 100], [15.1, 50.1, 120]] }], points: [{ lat: 50, lon: 15, name: 'P' }] });
    const k = parseKml(xml);
    expect(k.name).toBe('A & B');
    expect(k.lines[0]!.points).toHaveLength(2);
    expect(k.points[0]!.name).toBe('P');
  });

  it('rejects DOCTYPE', () => {
    expect(() => parseKml('<!DOCTYPE kml [<!ENTITY a "b">]><kml/>')).toThrow(/entit/);
  });
});

describe('GeoJSON', () => {
  it('parses FeatureCollection with lines and points and validates ranges', () => {
    const g = parseGeoJson({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { name: 'L' }, geometry: { type: 'LineString', coordinates: [[15, 50, 100], [15.1, 50.1, 120], [200, 50]] } },
        { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: [[[1, 2], [3, 4]], [[5, 6], [7, 8]]] } },
        { type: 'Feature', properties: { name: 'P' }, geometry: { type: 'Point', coordinates: [15, 50, 10] } },
      ],
    });
    expect(g.lines).toHaveLength(3);
    expect(g.lines[0]!.positions).toHaveLength(2);
    expect(g.points[0]).toMatchObject({ name: 'P', ele: 10 });
    expect(g.warnings.join(' ')).toContain('neplatnými');
  });

  it('accepts bare geometry and rejects garbage', () => {
    expect(parseGeoJson('{"type":"LineString","coordinates":[[1,2],[3,4]]}').lines).toHaveLength(1);
    expect(() => parseGeoJson('nope')).toThrow(/platný JSON/);
    expect(() => parseGeoJson('{"a":1}')).toThrow(/GeoJSON/);
  });

  it('export round trip', () => {
    const s = exportGeoJson({ name: 'x', lines: [{ name: 'L', positions: [[15, 50, 100], [15.1, 50.1, 120]] }], points: [{ lat: 1, lon: 2, name: 'P' }] });
    const g = parseGeoJson(s);
    expect(g.lines[0]!.positions[1]).toEqual([15.1, 50.1, 120]);
    expect(g.points[0]!.name).toBe('P');
  });
});

describe('importRouteFile', () => {
  it('detects formats', () => {
    expect(detectFormat(GPX11)).toBe('gpx');
    expect(detectFormat('<kml/>')).toBe('kml');
    expect(detectFormat('{"type":"Point"}')).toBe('geojson');
    expect(detectFormat('???', 'a.gpx')).toBe('gpx');
    expect(detectFormat('???')).toBeNull();
  });

  it('imports GPX with distance, ascent and flags', () => {
    const r = importRouteFile(GPX11, 'x.gpx');
    expect(r.sourceFormat).toBe('gpx');
    expect(r.name).toBe('Den 1');
    expect(r.pointCount).toBe(3);
    expect(r.hasElevation).toBe(true);
    expect(r.hasTime).toBe(true);
    expect(r.distanceM).toBeGreaterThan(2200);
    expect(r.distanceM).toBeLessThan(2300);
    expect(r.ascentM).toBe(200);
    expect(r.waypoints).toHaveLength(1);
    expect(r.warnings.join(' ')).toContain('úseků');
  });

  it('simplifies huge tracks but keeps the real distance', () => {
    const coords = Array.from({ length: 6000 }, (_, i) => [15 + i * 0.00002, 50 + Math.sin(i / 50) * 0.0005, 500 + (i % 7)]);
    const json = JSON.stringify({ type: 'LineString', coordinates: coords });
    const full = importRouteFile(json, undefined, { maxPoints: 100000 });
    const r = importRouteFile(json, undefined, { maxPoints: 500 });
    expect(r.geometry.length).toBeLessThanOrEqual(500);
    expect(r.pointCount).toBe(6000);
    expect(r.distanceM).toBeCloseTo(full.distanceM, 3);
    expect(r.warnings.join(' ')).toContain('zjednodušena');
  });

  it('warns when there is no elevation and fails when there is no line', () => {
    const r = importRouteFile('{"type":"LineString","coordinates":[[1,2],[1.01,2.01]]}');
    expect(r.hasElevation).toBe(false);
    expect(r.warnings.join(' ')).toContain('nadmořské výšky');
    expect(() => importRouteFile('{"type":"Point","coordinates":[1,2]}')).toThrow(/neobsahuje žádnou trasu/);
    expect(() => importRouteFile('hello')).toThrow(/rozpoznán/);
    expect(() => importRouteFile(GPX11, 'a.gpx', { maxBytes: 50 })).toThrow(/příliš velký/);
  });
});

describe('renderTripReportHtml', () => {
  const data: TripReportData = {
    title: 'Krkonoše <script>alert(1)</script>',
    startDate: '2024-07-01',
    endDate: '2024-07-02',
    participants: ['Jan', 'Eva & Petr'],
    summary: { distanceM: 42000, ascentM: 1800, descentM: 1700, days: 2, movingTimeMin: 600 },
    days: [
      { index: 1, date: '2024-07-01', start: 'Špindlerův Mlýn', end: 'Luční bouda', distanceM: 20000, ascentM: 1000, descentM: 400, movingTimeMin: 300, campsite: 'Bivak', schedule: ['07:00 start'], weather: 'Jasno', water: 'Pramen u cesty', notes: '<b>x</b>' },
      { index: 2, distanceM: 22000, ascentM: 800, descentM: 1300 },
    ],
    gear: [{ category: 'Spaní', items: [{ name: 'Stan', quantity: 1, weightG: 1200 }, { name: 'Bunda', quantity: 1, weightG: 400, worn: true }] }],
    food: { totalKcal: 6000, totalWeightG: 1500, perDay: [{ day: 1, kcal: 3000, weightG: 750 }] },
    checklist: [{ category: 'Před odjezdem', items: [{ text: 'Nabít powerbanku', done: true }, { text: 'Říct rodině plán' }] }],
    risks: [{ severity: 'danger', title: 'Bouřky', mitigation: 'Sestoupit z hřebene' }],
    emergency: { contacts: [{ name: 'Marie', phone: '+420 123 456 789' }] },
    attribution: ['© přispěvatelé OpenStreetMap'],
    generatedAt: '2024-06-20T10:00:00Z',
  };

  it('renders a self-contained, escaped Czech document', () => {
    const html = renderTripReportHtml(data);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('lang="cs"');
    expect(html).toContain('@page { size: A4');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Eva &amp; Petr');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    for (const label of ['Shrnutí', 'Etapy', 'Vybavení', 'Jídlo', 'Kontrolní seznam', 'Rizika', 'Nouzové kontakty', 'Horská služba', '1210', '112', 'Marie', 'OpenStreetMap']) {
      expect(html).toContain(label);
    }
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org)[^"' ]*\.(?:css|js)/);
    expect(html).toContain('Celková hmotnost');
  });

  it('omits optional sections', () => {
    const html = renderTripReportHtml({ ...data, gear: undefined, food: undefined, checklist: undefined, risks: undefined });
    expect(html).not.toContain('<h2>Vybavení');
    expect(html).not.toContain('Kontrolní seznam');
    expect(html).toContain('Nouzové kontakty');
  });
});
