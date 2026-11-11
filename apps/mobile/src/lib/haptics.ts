import { Platform } from 'react-native';
import * as Haptics from 'expo-haptics';
import { useSettingsStore } from '@/stores/settings';

const enabled = () => Platform.OS !== 'web' && useSettingsStore.getState().settings.hapticsEnabled;

const run = (fn: () => Promise<void>) => {
  if (!enabled()) return;
  try {
    fn().catch(() => undefined);
  } catch {
    /* haptics unavailable */
  }
};

/** Haptic feedback that respects the `hapticsEnabled` setting and is a no-op on web. */
export const haptic = {
  light: () => run(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  medium: () => run(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)),
  heavy: () => run(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy)),
  select: () => run(() => Haptics.selectionAsync()),
  success: () => run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  warning: () => run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)),
  error: () => run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)),
};
