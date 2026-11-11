import { Platform } from 'react-native';
import { create } from 'zustand';

const KEY = 'trailpack.aiKey';

interface AiKeyState {
  apiKey: string;
  hydrated: boolean;
  setApiKey(key: string): void;
  hydrate(): Promise<void>;
}

/** API key: expo-secure-store on native, memory only on web (never persisted). */
export const useAiKeyStore = create<AiKeyState>()((set) => ({
  apiKey: '',
  hydrated: false,
  setApiKey(key) {
    set({ apiKey: key });
    if (Platform.OS !== 'web') {
      void import('expo-secure-store').then((s) => (key ? s.setItemAsync(KEY, key) : s.deleteItemAsync(KEY))).catch(() => undefined);
    }
  },
  async hydrate() {
    if (Platform.OS !== 'web') {
      try {
        const s = await import('expo-secure-store');
        const v = await s.getItemAsync(KEY);
        if (v) set({ apiKey: v });
      } catch {
        /* ignore */
      }
    }
    set({ hydrated: true });
  },
}));
