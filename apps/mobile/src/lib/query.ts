import { QueryClient } from '@tanstack/react-query';

/** Offline-first: queries/mutations run against local data without waiting for connectivity. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      networkMode: 'offlineFirst',
      staleTime: 60_000,
      gcTime: 24 * 60 * 60 * 1000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
    mutations: { networkMode: 'offlineFirst' },
  },
});
