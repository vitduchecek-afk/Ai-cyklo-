import { create } from 'zustand';
import {
  AppSettingsSchema,
  DEFAULT_SETTINGS,
  type AppSettings,
  type DashboardCard,
  type Language,
  type ThemeMode,
  type Units,
} from '@trailpack/shared';

/**
 * Persistence port. The data-layer engineer plugs a SQLite implementation in
 * with `useSettingsStore.getState().setPersistence(impl)` at app start.
 */
export interface SettingsPersistence {
  load(): Promise<Partial<AppSettings> | null>;
  save(settings: AppSettings): Promise<void>;
}

/** Default: keeps the last saved value in memory only. */
export class InMemorySettingsPersistence implements SettingsPersistence {
  private value: Partial<AppSettings> | null = null;
  async load(): Promise<Partial<AppSettings> | null> {
    return this.value;
  }
  async save(settings: AppSettings): Promise<void> {
    this.value = settings;
  }
}

interface SettingsState {
  settings: AppSettings;
  /** true once `hydrate()` finished (success or not). */
  hydrated: boolean;
  persistence: SettingsPersistence;
  setPersistence(p: SettingsPersistence): void;
  /** Load persisted settings (validated, unknown/invalid fields fall back to defaults). */
  hydrate(initialOverrides?: Partial<AppSettings>): Promise<void>;
  update(patch: Partial<AppSettings>): void;
  setTheme(theme: ThemeMode): void;
  setLanguage(language: Language): void;
  setUnits(units: Units): void;
  setFontScale(scale: number): void;
  setHaptics(enabled: boolean): void;
  setDashboardCards(cards: DashboardCard[]): void;
  toggleDashboardCard(card: DashboardCard): void;
  reset(): void;
}

function sanitize(raw: Partial<AppSettings> | null | undefined): AppSettings {
  const merged = { ...DEFAULT_SETTINGS, ...(raw ?? {}) };
  const parsed = AppSettingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

export const useSettingsStore = create<SettingsState>()((set, get) => {
  const commit = (patch: Partial<AppSettings>) => {
    const next = sanitize({ ...get().settings, ...patch });
    set({ settings: next });
    get()
      .persistence.save(next)
      .catch((e: unknown) => console.warn('[settings] save failed', e));
  };

  return {
    settings: DEFAULT_SETTINGS,
    hydrated: false,
    persistence: new InMemorySettingsPersistence(),
    setPersistence: (persistence) => set({ persistence }),
    hydrate: async (initialOverrides) => {
      try {
        const loaded = await get().persistence.load();
        // First run (nothing stored): apply overrides such as the device language.
        set({ settings: sanitize(loaded ?? { ...get().settings, ...initialOverrides }), hydrated: true });
      } catch (e) {
        console.warn('[settings] load failed', e);
        set({ hydrated: true });
      }
    },
    update: commit,
    setTheme: (theme) => commit({ theme }),
    setLanguage: (language) => commit({ language }),
    setUnits: (units) => commit({ units }),
    setFontScale: (fontScale) => commit({ fontScale }),
    setHaptics: (hapticsEnabled) => commit({ hapticsEnabled }),
    setDashboardCards: (dashboardCards) => commit({ dashboardCards }),
    toggleDashboardCard: (card) => {
      const cur = get().settings.dashboardCards;
      commit({ dashboardCards: cur.includes(card) ? cur.filter((c) => c !== card) : [...cur, card] });
    },
    reset: () => commit({ ...DEFAULT_SETTINGS }),
  };
});

export const useSettings = () => useSettingsStore((s) => s.settings);
