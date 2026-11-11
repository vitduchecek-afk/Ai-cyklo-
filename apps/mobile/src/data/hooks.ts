import type { GearItem, Route, Trip, TripDay } from '@trailpack/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { getDb } from './db';

type Draft<T> = Omit<T, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>;

export const useGearItems = () =>
  useQuery({ queryKey: ['gearItems'], queryFn: async () => (await getDb()).gearItems.list() });

export const useTrips = () => useQuery({ queryKey: ['trips'], queryFn: async () => (await getDb()).trips.list() });

export const useTrip = (id: string) =>
  useQuery({ queryKey: ['trips', id], queryFn: async () => (await getDb()).trips.get(id) });

export const useRoute = (id: string | null | undefined) =>
  useQuery({
    queryKey: ['routes', id],
    enabled: !!id,
    queryFn: async () => (id ? (await getDb()).routes.get(id) : undefined),
  });

export const useTripDays = (tripId: string) =>
  useQuery({ queryKey: ['tripDays', tripId], queryFn: async () => (await getDb()).tripDays.byTrip(tripId) });

export function useAddGearItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (draft: Partial<Draft<GearItem>> & Pick<GearItem, 'name' | 'categoryKey' | 'weightG'>) =>
      (await getDb()).gearItems.insert(draft as never),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['gearItems'] }),
  });
}

export function useDeleteGearItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await getDb()).gearItems.softDelete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['gearItems'] }),
  });
}

export function useRestoreGearItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await getDb()).gearItems.restore(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['gearItems'] }),
  });
}

export interface CreateTripInput {
  name: string;
  route: Route;
  trip: Partial<Draft<Trip>>;
  days: Array<Partial<Draft<TripDay>> & { dayIndex: number }>;
}

/** Saves route + trip + days atomically and returns the new trip. */
export function useCreateTrip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateTripInput) => {
      const db = await getDb();
      return db.transaction(async (tx) => {
        const trip = await tx.trips.insert({ ...input.trip, name: input.name } as never);
        const route = await tx.routes.insert({ ...input.route, tripId: trip.id } as never);
        const saved = await tx.trips.update(trip.id, { routeId: route.id } as never);
        for (const d of input.days) await tx.tripDays.insert({ ...d, tripId: trip.id } as never);
        return saved;
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['trips'] });
      void qc.invalidateQueries({ queryKey: ['routes'] });
      void qc.invalidateQueries({ queryKey: ['tripDays'] });
    },
  });
}

export function useDeleteTrip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await getDb()).deleteTripCascade(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['trips'] }),
  });
}
