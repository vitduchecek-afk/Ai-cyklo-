/**
 * RainViewer precipitation radar (free public API, attribution required:
 * "RainViewer.com"). Only the frame index is fetched here; tiles are loaded by
 * the map renderer on demand – tiles must not be bulk-downloaded.
 */
import { z } from 'zod';
import { ENDPOINTS, HttpClient, TrailPackError } from '@trailpack/shared';

export const RAINVIEWER_ATTRIBUTION = 'Radar: RainViewer.com';

const FrameSchema = z.object({ time: z.number().int(), path: z.string() });
const ResponseSchema = z.object({
  version: z.string().optional(),
  generated: z.number().int().optional(),
  host: z.string().url(),
  radar: z.object({ past: z.array(FrameSchema).default([]), nowcast: z.array(FrameSchema).default([]) }),
});

export interface RadarFrame {
  /** Unix time (seconds) of the radar image. */
  time: number;
  /** ISO 8601 UTC time of the radar image. */
  isoTime: string;
  kind: 'past' | 'nowcast';
  path: string;
  /** MapLibre raster tile template (`{z}/{x}/{y}` placeholders kept). */
  tileUrl: string;
}

export interface RadarFrames {
  /** Unix time (seconds) when RainViewer generated the index. */
  generated: number;
  host: string;
  /** Past frames followed by nowcast frames, ordered by time. */
  frames: RadarFrame[];
  attribution: string;
}

export interface RadarTileOptions {
  /** Tile size in px (256 or 512, default 256). */
  size?: 256 | 512;
  /** RainViewer colour scheme id (default 2 = Universal Blue). */
  color?: number;
  /** Smooth the radar (default true). */
  smooth?: boolean;
  /** Draw snow in a separate colour (default true). */
  snow?: boolean;
}

/** Builds the tile URL template for a frame path. */
export function radarTileUrl(host: string, path: string, o: RadarTileOptions = {}): string {
  const size = o.size ?? 256;
  return `${host}${path}/${size}/{z}/{x}/{y}/${o.color ?? 2}/${o.smooth === false ? 0 : 1}_${o.snow === false ? 0 : 1}.png`;
}

/**
 * Fetches the list of available radar frames (≈ 2 h of past images, optionally nowcast).
 * @throws TrailPackError `parse_error` when the index has an unexpected format.
 */
export async function fetchRainViewerFrames(http: HttpClient, opts: RadarTileOptions & { signal?: AbortSignal } = {}): Promise<RadarFrames> {
  const raw = await http.json(ENDPOINTS.rainviewerMaps, { provider: 'rainviewer', signal: opts.signal });
  const parsed = ResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new TrailPackError('parse_error', 'Index radarových snímků má neočekávaný formát.', { provider: 'rainviewer', details: parsed.error.issues.slice(0, 3) });
  }
  const { host, radar } = parsed.data;
  const toFrame = (f: z.infer<typeof FrameSchema>, kind: 'past' | 'nowcast'): RadarFrame => ({
    time: f.time,
    isoTime: new Date(f.time * 1000).toISOString(),
    kind,
    path: f.path,
    tileUrl: radarTileUrl(host, f.path, opts),
  });
  const frames = [...radar.past.map((f) => toFrame(f, 'past')), ...radar.nowcast.map((f) => toFrame(f, 'nowcast'))].sort((a, b) => a.time - b.time);
  return { generated: parsed.data.generated ?? Math.floor(Date.now() / 1000), host, frames, attribution: RAINVIEWER_ATTRIBUTION };
}
