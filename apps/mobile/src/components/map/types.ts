import type { StyleProp, ViewStyle } from 'react-native';

export const DEFAULT_MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';

export interface MapGeometry {
  type: string;
  coordinates: unknown;
}
export interface MapFeature {
  type: 'Feature';
  id?: string | number;
  properties: Record<string, unknown> | null;
  geometry: MapGeometry;
}
export interface MapFeatureCollection {
  type: 'FeatureCollection';
  features: MapFeature[];
}

export type PoiKind = 'water' | 'camp' | 'summit' | 'danger' | 'hut' | 'poi' | (string & {});

export interface MapWaypoint {
  id: string;
  lat: number;
  lon: number;
  /** start | via | end | poi | camp | water | avoid */
  type: string;
  name?: string;
}

export interface MapCamera {
  center: [number, number];
  zoom: number;
}
export type MapBounds = [number, number, number, number];

export type InitialCamera = MapCamera | { bounds: MapBounds; padding?: number };

export interface UserPosition {
  lat: number;
  lon: number;
  accuracy?: number;
  heading?: number | null;
}

export interface TrailMapProps {
  /** Style URL or inline style JSON. Default OpenFreeMap "liberty". */
  mapStyle?: string | object;
  initialCamera: InitialCamera;
  /** LineString features; `properties.color` sets the line colour, `properties.id` / `name` are passed back. */
  routes?: MapFeatureCollection;
  /** Point features with `properties.kind` (water, camp, summit, danger, hut, poi), `name`, `id`. */
  pois?: MapFeatureCollection;
  waypoints?: MapWaypoint[];
  draggableWaypoints?: boolean;
  onWaypointDrag?: (id: string, lat: number, lon: number) => void;
  /** Cursor synchronised with an elevation profile. */
  highlightPoint?: { lat: number; lon: number } | null;
  userLocation?: UserPosition | null;
  /** Keep the camera centred on `userLocation`. */
  followUser?: boolean;
  /** A temporary dropped pin (e.g. from long-press). */
  pin?: { lat: number; lon: number } | null;
  onLongPress?: (lat: number, lon: number) => void;
  onPress?: (lat: number, lon: number) => void;
  onFeaturePress?: (feature: MapFeature) => void;
  onRegionChange?: (bbox: MapBounds, zoom: number) => void;
  /** Tap points to measure distance (haversine). */
  measureMode?: boolean;
  onMeasureChange?: (meters: number, points: [number, number][]) => void;
  onOpenLayers?: () => void;
  /** Called when the locate button is pressed. */
  onLocate?: () => void;
  locating?: boolean;
  style?: StyleProp<ViewStyle>;
  /** Hide the overlay controls (e.g. mini-maps). */
  hideControls?: boolean;
}

/** Imperative handle (React 19 `ref` prop). */
export interface TrailMapHandle {
  flyTo(lat: number, lon: number, zoom?: number): void;
  fitBounds(bbox: MapBounds, padding?: number): void;
}

/** Colours per POI kind (shared by native + web renderers). */
export const POI_COLORS: Record<string, string> = {
  water: '#1D8FBF',
  camp: '#8A5A2B',
  summit: '#4A5A68',
  danger: '#C8352B',
  hut: '#B8935A',
  poi: '#2C6A3E',
};

export const WAYPOINT_COLORS: Record<string, string> = {
  start: '#2C6A3E',
  end: '#C8352B',
  via: '#1D5CA3',
  poi: '#2C6A3E',
  camp: '#8A5A2B',
  water: '#1D8FBF',
  avoid: '#4A5A68',
};
