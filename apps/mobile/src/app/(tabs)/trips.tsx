import { splitIntoStages } from '@trailpack/calculations';
import type { GeocodingResult } from '@trailpack/maps';
import { routeToEntity } from '@trailpack/routing';
import { formatDuration } from '@trailpack/shared';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { Button, Card, EmptyState, ListItem, NumberField, Screen, SegmentedControl, Sheet, SwipeableRow, Text, TextField, toast } from '@/components/ui';
import { geocoder, routing } from '@/data/services';
import { useCreateTrip, useDeleteTrip, useTrips } from '@/data/hooks';
import { errorMessage, useT } from '@/i18n';
import { useTheme } from '@/theme/ThemeProvider';

type Activity = 'hiking' | 'bikepacking';

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

function PlaceField({ label, query, setQuery, place, setPlace }: { label: string; query: string; setQuery: (q: string) => void; place: GeocodingResult | null; setPlace: (p: GeocodingResult | null) => void }) {
  const [results, setResults] = useState<GeocodingResult[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (place || query.trim().length < 3) {
      setResults([]);
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      setBusy(true);
      geocoder
        .search(query.trim(), { limit: 5, signal: ctrl.signal })
        .then(setResults)
        .catch(() => undefined)
        .finally(() => setBusy(false));
    }, 350);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [query, place]);

  return (
    <View>
      <TextField
        label={label}
        value={query}
        onChangeText={(t) => {
          setQuery(t);
          setPlace(null);
        }}
        helper={place ? `Vybráno: ${place.label}` : busy ? 'Hledám…' : 'Začněte psát název místa'}
      />
      {results.map((r) => (
        <ListItem
          key={r.id}
          title={r.name}
          subtitle={r.label}
          onPress={() => {
            setPlace(r);
            setQuery(r.name);
            setResults([]);
          }}
        />
      ))}
    </View>
  );
}

export default function TripsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { t } = useT();
  const params = useLocalSearchParams<{ new?: string; name?: string; days?: string; maxKm?: string; activity?: string; region?: string; startDate?: string }>();
  const { data: trips = [], isLoading } = useTrips();
  const create = useCreateTrip();
  const del = useDeleteTrip();

  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [startQ, setStartQ] = useState('');
  const [endQ, setEndQ] = useState('');
  const [start, setStart] = useState<GeocodingResult | null>(null);
  const [end, setEnd] = useState<GeocodingResult | null>(null);
  const [activity, setActivity] = useState<Activity>('hiking');
  const [days, setDays] = useState<number | null>(3);
  const [maxKm, setMaxKm] = useState<number | null>(20);
  const [startDate, setStartDate] = useState('');
  const [busy, setBusy] = useState(false);

  // Prefill from the AI tab.
  useEffect(() => {
    if (params.new !== '1') return;
    if (params.name) setName(params.name);
    if (params.days) setDays(Number(params.days) || 3);
    if (params.maxKm) setMaxKm(Number(params.maxKm) || 20);
    if (params.activity) setActivity(params.activity === 'bikepacking' || params.activity === 'cycling' ? 'bikepacking' : 'hiking');
    if (params.region) {
      setEndQ(params.region);
      setStartQ(params.region);
    }
    if (params.startDate) setStartDate(params.startDate);
    setOpen(true);
    router.setParams({ new: undefined });
  }, [params, router]);

  const submit = async () => {
    if (!start || !end) {
      toast.error('Vyberte začátek i cíl z výsledků vyhledávání.');
      return;
    }
    const nDays = Math.max(1, Math.round(days ?? 1));
    setBusy(true);
    try {
      const tripName = name.trim() || `${start.name} – ${end.name}`;
      const outcome = await routing.route({
        waypoints: [
          { lat: start.lat, lon: start.lon },
          { lat: end.lat, lon: end.lon },
        ],
        activity,
        preference: 'fastest',
      });
      const result = outcome.results[0];
      if (!result) throw new Error('no_route');
      const route = routeToEntity(result, {
        name: tripName,
        activity,
        waypoints: [
          { lat: start.lat, lon: start.lon, name: start.name },
          { lat: end.lat, lon: end.lon, name: end.name },
        ],
      });
      const stages = splitIntoStages(result.geometry, {
        days: nDays,
        maxDailyDistanceM: (maxKm ?? 20) * 1000,
        timeParams: { activity, fitness: 'moderate' },
      });
      const date = /^\d{4}-\d{2}-\d{2}$/.test(startDate) ? startDate : undefined;
      const trip = await create.mutateAsync({
        name: tripName,
        route,
        trip: { activityType: activity, status: 'planning', startDate: date, endDate: date ? addDays(date, nDays - 1) : undefined, settings: { dailyDistanceKm: maxKm ?? 20 } as never },
        days: stages.map((s, i) => {
          const a = result.geometry[s.fromIdx]!;
          const b = result.geometry[s.toIdx]!;
          return {
            dayIndex: i,
            date: date ? addDays(date, i) : undefined,
            startName: i === 0 ? start.name : undefined,
            endName: i === stages.length - 1 ? end.name : undefined,
            start: { lat: a[1], lon: a[0] },
            end: { lat: b[1], lon: b[0] },
            fromIdx: s.fromIdx,
            toIdx: s.toIdx,
            distanceM: s.distanceM,
            ascentM: s.ascentM,
            descentM: s.descentM,
            movingTimeMin: s.movingMin,
            totalTimeMin: Math.round(s.movingMin * 1.25),
            notes: s.exceedsLimits.join(' ') || undefined,
          };
        }),
      });
      setOpen(false);
      toast.success(`Výprava uložena (${formatDuration(stages.reduce((a, s) => a + s.movingMin, 0))} v pohybu)`);
      router.push(`/trip/${trip.id}` as never);
    } catch (e) {
      toast.error(e instanceof Error && e.message === 'no_route' ? 'Trasa nenalezena.' : errorMessage(t, e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="Výpravy" subtitle={`${trips.length} výprav`} actions={<Button label="Nová výprava" icon="plus" onPress={() => setOpen(true)} />}>
      {!isLoading && trips.length === 0 ? (
        <EmptyState icon="route" title="Zatím žádná výprava" body="Zadejte začátek a cíl a TrailPack vypočítá trasu a rozdělí ji na etapy." actionLabel="Nová výprava" onAction={() => setOpen(true)} />
      ) : (
        trips.map((tr) => (
          <SwipeableRow key={tr.id} onDelete={() => del.mutate(tr.id, { onSuccess: () => toast.info(`Smazáno: ${tr.name}`) })}>
            <ListItem
              title={tr.name}
              subtitle={`${tr.activityType === 'hiking' ? 'Pěší turistika' : tr.activityType}${tr.startDate ? ` · ${tr.startDate}` : ''}`}
              chevron
              leading="route"
              onPress={() => router.push(`/trip/${tr.id}` as never)}
            />
          </SwipeableRow>
        ))
      )}
      <Sheet visible={open} onClose={() => setOpen(false)} title="Nová výprava">
        <View style={{ gap: theme.spacing.md }}>
          <TextField label="Název (volitelné)" value={name} onChangeText={setName} />
          <PlaceField label="Začátek" query={startQ} setQuery={setStartQ} place={start} setPlace={setStart} />
          <PlaceField label="Cíl" query={endQ} setQuery={setEndQ} place={end} setPlace={setEnd} />
          <SegmentedControl<Activity>
            value={activity}
            onChange={setActivity}
            options={[
              { value: 'hiking', label: 'Pěšky' },
              { value: 'bikepacking', label: 'Bikepacking' },
            ]}
          />
          <NumberField label="Počet dní" value={days} onChange={setDays} min={1} max={30} />
          <NumberField label="Max. km za den" unit="km" value={maxKm} onChange={setMaxKm} min={1} max={400} />
          <TextField label="Datum začátku (RRRR-MM-DD, volitelné)" value={startDate} onChangeText={setStartDate} autoCapitalize="none" />
          <Text variant="caption" tone="muted">
            Trasu počítá BRouter (s automatickým záložním poskytovatelem). Vyžaduje připojení k internetu.
          </Text>
          <Button label="Vypočítat trasu a uložit" onPress={() => void submit()} loading={busy} fullWidth />
        </View>
      </Sheet>
      <Card variant="outlined" padding={10}>
        <Text variant="caption" tone="muted">
          Data tras: OpenStreetMap contributors.
        </Text>
      </Card>
    </Screen>
  );
}
