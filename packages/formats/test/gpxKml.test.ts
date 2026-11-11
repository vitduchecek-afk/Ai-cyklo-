import { describe, expect, it } from 'vitest';
import { TrailPackError } from '@trailpack/shared';
import { exportGpx, exportKml, hexToKmlColor, parseGpx, parseKml } from '../src';

const GPX11 = `<?xml version="1.0" encoding="UTF-8"?>
<gpx:gpx version="1.1" creator="test" xmlns:gpx="http://www.topografix.com/GPX/1/1">
  <gpx:metadata><gpx:name>Krkono&#x161;e &amp; okol&#237;</gpx:name><gpx:time>2026-07-01T06:00:00Z</gpx:time></gpx:metadata>
  <gpx:wpt lat="50.7360" lon="15.7397"><gpx:ele>1603</gpx:ele><gpx:name>Sněžka</gpx:name><gpx:sym>Summit</gpx:sym></gpx:wpt>
  <gpx:trk><gpx:name>Den 1</gpx:name>
    <gpx:trkseg>
      <gpx:trkpt lat="50.7360" lon="15.7397"><gpx:ele>1600</gpx:ele><gpx:time>2026-07-01T06:00:00Z</gpx:time><gpx:extensions><x>1</x></gpx:extensions></gpx:trkpt>
      <gpx:trkpt lat="50.7300" lon="15.7400"><gpx:ele>1410</gpx:ele></gpx:trkpt>
      <gpx:trkpt lat="999" lon="15.7400"/>
    </gpx:trkseg>
  </gpx:trk>
</gpx:gpx>`;

const GPX10 = `<?xml version="1.0"?><gpx version="1.0" xmlns="http://www.topografix.com/GPX/1/0"><name>Stará</name><author>Já</author>
<rte><name>R</name><rtept lat="50" lon="14"/><rtept lat="50.1" lon="14.1"/></rte>
<trk><trkseg><trkpt lat="50" lon="14"><speed>1.2</speed></trkpt></trkseg></trk></gpx>`;

describe('parseGpx', () => {
  it('reads GPX 1.1 with prefixes, entities and ignores extensions', () => {
    const doc = parseGpx(GPX11);
    expect(doc.name).toBe('Krkonoše & okolí');
    expect(doc.time).toBe('2026-07-01T06:00:00.000Z');
    expect(doc.waypoints).toEqual([{ lat: 50.736, lon: 15.7397, ele: 1603, name: 'Sněžka', sym: 'Summit' }]);
    expect(doc.tracks[0]!.name).toBe('Den 1');
    expect(doc.tracks[0]!.segments[0]).toHaveLength(2);
    expect(doc.tracks[0]!.segments[0]![0]!.time).toBe(Date.parse('2026-07-01T06:00:00Z'));
    expect(doc.warnings[0]).toMatch(/neplatnými/);
  });
  it('reads GPX 1.0 root metadata, routes and speed', () => {
    const doc = parseGpx(GPX10);
    expect(doc.name).toBe('Stará');
    expect(doc.author).toBe('Já');
    expect(doc.routes[0]!.points).toHaveLength(2);
    expect(doc.tracks[0]!.segments[0]![0]!.speed).toBe(1.2);
  });
  it('rejects DTD entities, malformed XML, non-GPX and oversize input', () => {
    const xxe = '<?xml version="1.0"?><!DOCTYPE gpx [<!ENTITY x SYSTEM "file:///etc/passwd">]><gpx><name>&x;</name></gpx>';
    expect(() => parseGpx(xxe)).toThrow(/entit/);
    expect(() => parseGpx('<gpx><trk></gpx>')).toThrow(TrailPackError);
    expect(() => parseGpx('<kml></kml>')).toThrow(/GPX/);
    try {
      parseGpx(GPX11, { maxBytes: 100 });
      expect.fail('should throw');
    } catch (e) {
      expect((e as TrailPackError).code).toBe('too_large');
    }
  });
  it('round-trips through exportGpx with escaping', () => {
    const xml = exportGpx({
      name: 'Trasa <A&B>',
      author: 'TrailPack',
      time: Date.UTC(2026, 6, 1),
      tracks: [{ name: 'T', points: [[15.7, 50.7, 1000], { lat: 50.71, lon: 15.71, ele: 1010.26, time: Date.UTC(2026, 6, 1, 8) }] }],
      waypoints: [{ lat: 50.7, lon: 15.7, name: 'Pramen "U buku"' }],
    });
    expect(xml).toContain('creator="TrailPack"');
    expect(xml).toContain('<name>Trasa &lt;A&amp;B&gt;</name>');
    const back = parseGpx(xml);
    expect(back.name).toBe('Trasa <A&B>');
    expect(back.waypoints[0]!.name).toBe('Pramen "U buku"');
    expect(back.tracks[0]!.segments[0]![1]).toEqual({ lat: 50.71, lon: 15.71, ele: 1010.3, time: Date.UTC(2026, 6, 1, 8) });
  });
});

describe('KML', () => {
  it('parses Placemarks, MultiGeometry and gx:Track in nested folders', () => {
    const kml = `<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2"><Document><name>Doc</name>
      <Folder><Placemark><name>Line</name><MultiGeometry><LineString><coordinates>15.7,50.7,0 15.8,50.8,0</coordinates></LineString></MultiGeometry></Placemark>
      <Placemark><name>Bod</name><Point><coordinates>15.7397,50.736,1603</coordinates></Point></Placemark>
      <Placemark><gx:Track><when>2026-07-01T06:00:00Z</when><when>2026-07-01T06:01:00Z</when><gx:coord>15.7 50.7 800</gx:coord><gx:coord>15.71 50.71 810</gx:coord></gx:Track></Placemark>
      </Folder></Document></kml>`;
    const doc = parseKml(kml);
    expect(doc.name).toBe('Doc');
    expect(doc.lines).toHaveLength(2);
    expect(doc.lines[0]!.points[0]).toEqual({ lat: 50.7, lon: 15.7 });
    expect(doc.lines[1]!.points[1]).toEqual({ lat: 50.71, lon: 15.71, ele: 810, time: Date.parse('2026-07-01T06:01:00Z') });
    expect(doc.points[0]).toEqual({ lat: 50.736, lon: 15.7397, ele: 1603, name: 'Bod' });
  });
  it('exports a Document with style, clampToGround and round-trips', () => {
    const kml = exportKml({ name: 'A & B', lines: [{ name: 'Trasa', points: [[15.7, 50.7, 900], [15.8, 50.8, 950]] }], points: [{ lat: 50.7, lon: 15.7, name: 'Start' }] });
    expect(kml).toContain('<altitudeMode>clampToGround</altitudeMode>');
    expect(kml).toContain('<Style id="trailpack-route">');
    const back = parseKml(kml);
    expect(back.name).toBe('A & B');
    expect(back.lines[0]!.points).toHaveLength(2);
    expect(back.points[0]!.name).toBe('Start');
    expect(hexToKmlColor('#2F6B3A')).toBe('ff3a6b2f');
  });
});
