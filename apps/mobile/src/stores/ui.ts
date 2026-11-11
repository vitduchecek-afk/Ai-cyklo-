import { create } from 'zustand';

interface UiState {
  moreOpen: boolean;
  openMore(): void;
  closeMore(): void;
}

/** Ephemeral UI state (not persisted). */
export const useUiStore = create<UiState>()((set) => ({
  moreOpen: false,
  openMore: () => set({ moreOpen: true }),
  closeMore: () => set({ moreOpen: false }),
}));
