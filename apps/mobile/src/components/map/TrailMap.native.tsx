import { Camera, GeoJSONSource, Layer, Map, type CameraRef, type PressEvent } from '@maplibre/maplibre-react-native';
import { useImperativeHandle, useRef, type Ref } from 'react';
import type { NativeSyntheticEvent } from 'react-native';

import { DEFAULT_MAP_STYLE, WAYPOINT_COLORS, type MapFeatureCollection, type TrailMapHandle, type TrailMapProps } from './types';

const EMPTY: MapFeatureCollection = { type: 'FeatureCollection', features: [] };

export function TrailMap(props: TrailMapProps & { ref?: Ref<TrailMapHandle> }) {
  const cam = useRef<CameraRef | null>(null);
  useImperativeHandle(props.ref, () => ({
    flyTo: (lat, lon, zoom) => cam.current?.flyTo({ center: [lon, lat], zoom }),
    fitBounds: (b, padding = 40) => cam.current?.fitBounds([b[0], b[1], b[2], b[3]], { padding: { top: padding, right: padding, bottom: padding, left: padding } }),
  }));

  const ic = props.initialCamera;
  const initialViewState =
    'bounds' in ic
      ? { bounds: [ic.bounds[0], ic.bounds[1], ic.bounds[2], ic.bounds[3]] as [number, number, number, number], padding: { top: 40, right: 40, bottom: 40, left: 40 } }
      : { center: ic.center, zoom: ic.zoom };

  const wps = {
    type: 'FeatureCollection' as const,
    features: (props.waypoints ?? []).map((w) => ({
      type: 'Feature' as const,
      properties: { color: WAYPOINT_COLORS[w.type] ?? '#2C6A3E' },
      geometry: { type: 'Point' as const, coordinates: [w.lon, w.lat] },
    })),
  };
  const pin = {
    type: 'FeatureCollection' as const,
    features: props.pin ? [{ type: 'Feature' as const, properties: {}, geometry: { type: 'Point' as const, coordinates: [props.pin.lon, props.pin.lat] } }] : [],
  };

  return (
    <Map
      style={[{ flex: 1 }, props.style]}
      mapStyle={(props.mapStyle ?? DEFAULT_MAP_STYLE) as string}
      attribution
      logo
      onLongPress={(e: NativeSyntheticEvent<PressEvent>) => props.onLongPress?.(e.nativeEvent.lngLat[1], e.nativeEvent.lngLat[0])}
      onPress={(e: NativeSyntheticEvent<PressEvent>) => props.onPress?.(e.nativeEvent.lngLat[1], e.nativeEvent.lngLat[0])}
    >
      <Camera ref={cam} initialViewState={initialViewState} />
      <GeoJSONSource id="routes" data={(props.routes ?? EMPTY) as never}>
        <Layer id="routes-casing" type="line" paint={{ 'line-color': '#ffffff', 'line-width': 8, 'line-opacity': 0.8 }} layout={{ 'line-cap': 'round', 'line-join': 'round' }} />
        <Layer id="routes-line" type="line" paint={{ 'line-color': ['coalesce', ['get', 'color'], '#2C6A3E'], 'line-width': 5 }} layout={{ 'line-cap': 'round', 'line-join': 'round' }} />
      </GeoJSONSource>
      <GeoJSONSource id="wps" data={wps as never}>
        <Layer id="wps-circle" type="circle" paint={{ 'circle-radius': 8, 'circle-color': ['get', 'color'], 'circle-stroke-width': 3, 'circle-stroke-color': '#ffffff' }} />
      </GeoJSONSource>
      <GeoJSONSource id="pin" data={pin as never}>
        <Layer id="pin-circle" type="circle" paint={{ 'circle-radius': 9, 'circle-color': '#C8352B', 'circle-stroke-width': 3, 'circle-stroke-color': '#ffffff' }} />
      </GeoJSONSource>
    </Map>
  );
}
