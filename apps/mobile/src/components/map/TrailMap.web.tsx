import 'maplibre-gl/dist/maplibre-gl.css';

import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import { View } from 'react-native';

import { DEFAULT_MAP_STYLE, WAYPOINT_COLORS, type MapFeatureCollection, type TrailMapHandle, type TrailMapProps } from './types';

const EMPTY: MapFeatureCollection = { type: 'FeatureCollection', features: [] };

function waypointsFc(p: TrailMapProps) {
  return {
    type: 'FeatureCollection' as const,
    features: (p.waypoints ?? []).map((w) => ({
      type: 'Feature' as const,
      properties: { color: WAYPOINT_COLORS[w.type] ?? '#2C6A3E', name: w.name ?? '' },
      geometry: { type: 'Point' as const, coordinates: [w.lon, w.lat] },
    })),
  };
}
function pinFc(p: TrailMapProps) {
  return {
    type: 'FeatureCollection' as const,
    features: p.pin ? [{ type: 'Feature' as const, properties: {}, geometry: { type: 'Point' as const, coordinates: [p.pin.lon, p.pin.lat] } }] : [],
  };
}

export function TrailMap(props: TrailMapProps & { ref?: Ref<TrailMapHandle> }) {
  const host = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MlMap | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  useImperativeHandle(props.ref, () => ({
    flyTo: (lat, lon, zoom) => mapRef.current?.flyTo({ center: [lon, lat], zoom: zoom ?? mapRef.current.getZoom() }),
    fitBounds: (b, padding = 40) => mapRef.current?.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding }),
  }));

  useEffect(() => {
    if (!host.current) return;
    const cam = propsRef.current.initialCamera;
    const map = new maplibregl.Map({
      container: host.current,
      style: (propsRef.current.mapStyle ?? DEFAULT_MAP_STYLE) as string,
      ...('bounds' in cam
        ? { bounds: [[cam.bounds[0], cam.bounds[1]], [cam.bounds[2], cam.bounds[3]]] as [[number, number], [number, number]], fitBoundsOptions: { padding: cam.padding ?? 40 } }
        : { center: cam.center, zoom: cam.zoom }),
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right');
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

    map.on('load', () => {
      map.addSource('routes', { type: 'geojson', data: (propsRef.current.routes ?? EMPTY) as never });
      map.addLayer({ id: 'routes-casing', type: 'line', source: 'routes', paint: { 'line-color': '#fff', 'line-width': 8, 'line-opacity': 0.8 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
      map.addLayer({ id: 'routes-line', type: 'line', source: 'routes', paint: { 'line-color': ['coalesce', ['get', 'color'], '#2C6A3E'], 'line-width': 5 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
      map.addSource('wps', { type: 'geojson', data: waypointsFc(propsRef.current) });
      map.addLayer({ id: 'wps-circle', type: 'circle', source: 'wps', paint: { 'circle-radius': 8, 'circle-color': ['get', 'color'], 'circle-stroke-width': 3, 'circle-stroke-color': '#fff' } });
      map.addSource('pin', { type: 'geojson', data: pinFc(propsRef.current) });
      map.addLayer({ id: 'pin-circle', type: 'circle', source: 'pin', paint: { 'circle-radius': 9, 'circle-color': '#C8352B', 'circle-stroke-width': 3, 'circle-stroke-color': '#fff' } });
    });

    // Long-press: right click / context menu, plus a touch & mouse hold timer.
    map.on('contextmenu', (e: maplibregl.MapMouseEvent) => propsRef.current.onLongPress?.(e.lngLat.lat, e.lngLat.lng));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    };
    map.on('touchstart', (e: maplibregl.MapTouchEvent) => {
      if (e.originalEvent.touches.length !== 1) return;
      cancel();
      timer = setTimeout(() => propsRef.current.onLongPress?.(e.lngLat.lat, e.lngLat.lng), 600);
    });
    for (const ev of ['touchend', 'touchmove', 'touchcancel', 'dragstart', 'zoomstart'] as const) map.on(ev, cancel);
    map.on('click', (e: maplibregl.MapMouseEvent) => propsRef.current.onPress?.(e.lngLat.lat, e.lngLat.lng));

    const ro = new ResizeObserver(() => map.resize());
    ro.observe(host.current);
    return () => {
      cancel();
      ro.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  const { routes, waypoints, pin } = props;
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      (map.getSource('routes') as GeoJSONSource | undefined)?.setData((routes ?? EMPTY) as never);
      (map.getSource('wps') as GeoJSONSource | undefined)?.setData(waypointsFc(propsRef.current));
      (map.getSource('pin') as GeoJSONSource | undefined)?.setData(pinFc(propsRef.current));
    };
    if (map.isStyleLoaded() && map.getSource('routes')) apply();
    else map.once('load', apply);
  }, [routes, waypoints, pin]);

  return (
    <View style={[{ flex: 1, minHeight: 200, overflow: 'hidden' }, props.style]}>
      <div ref={host} style={{ position: 'absolute', inset: 0 }} />
    </View>
  );
}
