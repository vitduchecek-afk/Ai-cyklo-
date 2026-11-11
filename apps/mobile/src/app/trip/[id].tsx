import { buildProfile, calculateWaterNeeds } from '@trailpack/calculations';
import { exportGpx } from '@trailpack/formats';
import { formatDistance, formatDuration } from '@trailpack/shared';
import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { View } from 'react-native';

import { ElevationProfile } from '@/components/charts';
import { TrailMap } from '@/components/map/TrailMap';
import { Button, Card, KeyValueTable, ListItem, Screen, SectionHeader, StatTile, Text, toast } from '@/components/ui';
import { useRoute, useTrip, useTripDays } from '@/data/hooks';
import { weather } from '@/data/services';
import { errorMessage, useT } from '@/i18n';
import { saveTextFile } from '@/lib/exportFile';
import { useTheme } from '@/theme/ThemeProvider';

const STAGE_COLORS = ['#2C6A3E', '#1D5CA3', '#8A5A2B', '#C8352B', '#6B4FA0', '#B8935A'];
const DAY_MS = 86400000;

export default function TripDetail() {
  const theme = useTheme();
  const { t } = useT();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: trip, isLoading } = useTrip(id);
  const { data: route } = useRoute(trip?.routeId);
  const { data: days = [] } = useTripDays(id);

  const geometry = route?.geometry;
  const profile = useMemo(() => (geometry ? buildProfile(geometry) : []), [geometry]);
  const points = useMemo(() => profile.filter((p) => p.ele !== undefined).map((p) => ({ d: p.d, ele: p.ele as number, gradePct: p.gradePct })), [profile]);
  const stages = useMemo(() => {
    let acc = 0;
    return days.map((d, i) => {
      const s = { fromD: acc, toD: acc + d.distanceM, color: STAGE_COLORS[i % STAGE_COLORS.length]!, label: `Den ${i + 1}` };
      acc += d.distanceM;
      return s;
    });
  }, [days]);
  const routes = useMemo(
    () =>
      geometry
        ? ({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { color: '#2C6A3E' }, geometry: { type: 'LineString', coordinates: geometry.map((p) => [p[0], p[1]]) } }] } as const)
        : undefined,
    [geometry],
  );
  const bounds = useMemo(() => {
    if (!geometry) return null;
    let w = 180, s = 90, e = -180, n = -90;
    for (const p of geometry) {
      w = Math.min(w, p[0]); e = Math.max(e, p[0]); s = Math.min(s, p[1]); n = Math.max(n, p[1]);
    }
    return [w, s, e, n] as [number, number, number, number];
  }, [geometry]);

  const first = geometry?.[0];
  const daysUntil = trip?.startDate ? Math.floor((new Date(`${trip.startDate}T12:00:00Z`).getTime() - Date.now()) / DAY_MS) : null;
  const inRange = daysUntil !== null && daysUntil >= 0 && daysUntil <= 15;
  const forecast = useQuery({
    queryKey: ['forecast', first?.[1], first?.[0]],
    enabled: !!first && inRange,
    queryFn: () => weather.getForecast({ lat: first![1], lon: first![0], days: 16 }),
  });
  const tripDaily = (forecast.data?.daily ?? []).filter((d) => !trip?.startDate || (d.date >= trip.startDate && d.date <= (trip.endDate ?? trip.startDate))).slice(0, 7);

  const water = useMemo(() => {
    const d0 = days[0];
    if (!d0) return null;
    const tempMax = tripDaily[0]?.tempMaxC ?? 20;
    return {
      assumedTemp: tripDaily[0]?.tempMaxC == null,
      res: calculateWaterNeeds({
        durationH: d0.totalTimeMin / 60,
        movingH: d0.movingTimeMin / 60,
        ascentM: d0.ascentM,
        tempMaxC: tempMax,
        intensity: 'moderate',
        people: trip?.participantsCount ?? 1,
        totalKm: d0.distanceM / 1000,
      }),
    };
  }, [days, tripDaily, trip?.participantsCount]);

  const exportFile = async () => {
    if (!route) return;
    try {
      const gpx = exportGpx({ name: route.name, tracks: [{ name: route.name, points: route.geometry }] });
      const ok = await saveTextFile(`${route.name.replace(/[^\w-]+/g, '_')}.gpx`, gpx);
      if (ok) toast.success('GPX exportován');
      else toast.warning('Sdílení souborů není na tomto zařízení dostupné.');
    } catch (e) {
      toast.error(errorMessage(t, e));
    }
  };

  if (isLoading || !trip) {
    return (
      <Screen title="Výprava" back>
        <Text>{isLoading ? 'Načítám…' : 'Výprava nenalezena.'}</Text>
      </Screen>
    );
  }

  const totalMoving = days.reduce((a, d) => a + d.movingTimeMin, 0);
  return (
    <Screen title={trip.name} subtitle={trip.startDate ?? 'Bez data'} back>
      {route ? (
        <>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
            <StatTile label="Vzdálenost" value={formatDistance(route.distanceM)} icon="ruler" />
            <StatTile label="Stoupání" value={`${Math.round(route.ascentM)}`} unit="m" icon="mountain" />
            <StatTile label="Čas v pohybu" value={formatDuration(totalMoving)} icon="clock" />
          </View>
          <View style={{ height: 320, borderRadius: theme.radii.lg, overflow: 'hidden' }}>
            {bounds ? <TrailMap initialCamera={{ bounds, padding: 40 }} routes={routes as never} hideControls /> : null}
          </View>
          {points.length > 1 ? (
            <Card>
              <SectionHeader title="Výškový profil" />
              <ElevationProfile points={points} stages={stages} />
            </Card>
          ) : null}
        </>
      ) : (
        <Text tone="muted">Trasa není k dispozici.</Text>
      )}

      <Card>
        <SectionHeader title="Etapy" />
        {days.map((d, i) => (
          <ListItem
            key={d.id}
            title={`Den ${i + 1}${d.date ? ` · ${d.date}` : ''}`}
            subtitle={`${formatDistance(d.distanceM)} · +${Math.round(d.ascentM)} m · ${formatDuration(d.movingTimeMin)}${d.notes ? ` · ${d.notes}` : ''}`}
            divider
          />
        ))}
      </Card>

      <Card>
        <SectionHeader title="Předpověď počasí (Open-Meteo)" />
        {!trip.startDate ? (
          <Text tone="muted">Výprava nemá datum začátku, předpověď proto nelze zobrazit.</Text>
        ) : !inRange ? (
          <Text tone="muted">Pro termín {trip.startDate} zatím neexistuje předpověď (Open-Meteo dává maximálně 16 dní dopředu).</Text>
        ) : forecast.isLoading ? (
          <Text tone="muted">Načítám předpověď…</Text>
        ) : forecast.isError ? (
          <Text tone="danger">Předpověď se nepodařilo načíst: {errorMessage(t, forecast.error)}</Text>
        ) : (
          <KeyValueTable
            rows={tripDaily.map((d) => ({
              label: d.date,
              value: `${d.tempMinC?.toFixed(0) ?? '–'}…${d.tempMaxC?.toFixed(0) ?? '–'} °C · srážky ${d.precipitationSumMm?.toFixed(1) ?? '0'} mm`,
            }))}
          />
        )}
      </Card>

      {water ? (
        <Card>
          <SectionHeader title="Odhad potřeby vody (1. den)" />
          <KeyValueTable
            rows={[
              { label: 'Na osobu a den', value: `${water.res.perPersonL.toFixed(1)} l` },
              { label: 'Nést na startu', value: `${water.res.carryAtStartL.toFixed(1)} l` },
              { label: 'Celkem (pití + vaření)', value: `${water.res.totalL.toFixed(1)} l` },
            ]}
          />
          <Text variant="caption" tone="muted">
            {water.assumedTemp ? 'Bez předpovědi počítáno s 20 °C, střední intenzitou. ' : ''}Orientační odhad, zdroje vody nejsou zahrnuty.
          </Text>
        </Card>
      ) : null}

      <Button label="Export GPX" icon="export" onPress={() => void exportFile()} disabled={!route} fullWidth />
    </Screen>
  );
}
