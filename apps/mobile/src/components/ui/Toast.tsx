import React, { useCallback, useEffect, useState } from 'react';
import { Animated, Easing, Platform, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { layout } from '@trailpack/ui';
import { useTheme } from '@/theme/ThemeProvider';
import { translate, useT } from '@/i18n';
import { haptic } from '@/lib/haptics';
import { Icon, type IconName } from '@/components/icons/Icon';
import { Text } from './Text';
import { Touch } from './Touch';

export type ToastKind = 'info' | 'success' | 'error' | 'warning';

export interface ToastOptions {
  message: string;
  kind?: ToastKind;
  /** Optional action button, e.g. Undo. */
  actionLabel?: string;
  onAction?: () => void;
  /** ms, default 4500 (6000 with an action). 0 = sticky. */
  duration?: number;
}

interface ToastItem extends ToastOptions {
  id: number;
}

type Handler = { push(o: ToastOptions): number; dismiss(id?: number): void };
let handler: Handler | null = null;

/**
 * Imperative toast API; usable anywhere after <ToastProvider> mounted.
 *   toast.success('Uloženo'); toast.undo('Smazáno', () => restore());
 */
export const toast = {
  show: (o: ToastOptions) => handler?.push(o) ?? -1,
  info: (message: string) => handler?.push({ message, kind: 'info' }) ?? -1,
  success: (message: string) => handler?.push({ message, kind: 'success' }) ?? -1,
  warning: (message: string) => handler?.push({ message, kind: 'warning' }) ?? -1,
  error: (message: string) => handler?.push({ message, kind: 'error' }) ?? -1,
  /** Message with an "Undo" action (label localised). */
  undo: (message: string, onUndo: () => void) =>
    handler?.push({ message, kind: 'info', actionLabel: translate('common.undo'), onAction: onUndo, duration: 6000 }) ?? -1,
  dismiss: (id?: number) => handler?.dismiss(id),
};

export const useToast = () => toast;

let counter = 1;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const wide = width >= layout.wideBreakpoint;

  const dismiss = useCallback((id?: number) => {
    setItems((cur) => (id === undefined ? [] : cur.filter((t) => t.id !== id)));
  }, []);

  useEffect(() => {
    handler = {
      push: (o) => {
        const id = counter++;
        if (o.kind === 'error') haptic.error();
        else if (o.kind === 'success') haptic.success();
        setItems((cur) => [...cur.slice(-2), { ...o, id }]);
        return id;
      },
      dismiss,
    };
    return () => {
      handler = null;
    };
  }, [dismiss]);

  return (
    <>
      {children}
      <View
        pointerEvents="box-none"
        style={[styles.host, { bottom: (wide ? 24 : layout.tabBarHeight + 16) + insets.bottom }]}
      >
        {items.map((it) => (
          <ToastView key={it.id} item={it} onDismiss={() => dismiss(it.id)} />
        ))}
      </View>
    </>
  );
}

function ToastView({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const { colors: c, radii, shadows } = useTheme();
  const { t } = useT();
  const [anim] = useState(() => new Animated.Value(0));
  const kind = item.kind ?? 'info';

  useEffect(() => {
    Animated.timing(anim, { toValue: 1, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: Platform.OS !== 'web' }).start();
    const d = item.duration ?? (item.actionLabel ? 6000 : 4500);
    if (d === 0) return;
    const timer = setTimeout(onDismiss, d);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const icon: IconName = kind === 'success' ? 'check' : kind === 'error' ? 'warning' : kind === 'warning' ? 'warning' : 'info';
  const accent = kind === 'success' ? c.success : kind === 'error' ? c.danger : kind === 'warning' ? c.warning : c.info;
  // Inverse surface: always high contrast against the app.
  const bg = c.isDark ? c.surfaceAlt : '#1D2420';
  const fg = c.isDark ? c.text : '#FFFFFF';
  return (
    <Animated.View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      accessibilityLabel={`${t('a11y.toast')}: ${item.message}`}
      style={[
        styles.toast,
        {
          backgroundColor: bg,
          borderRadius: radii.md,
          boxShadow: shadows.lg,
          opacity: anim,
          transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }],
        },
      ]}
    >
      <View style={[styles.stripe, { backgroundColor: accent }]} />
      <View style={{ paddingLeft: 6 }}>
        <Icon name={icon} size={20} color={fg} />
      </View>
      <Text variant="body" color={fg} style={styles.msg} numberOfLines={3}>
        {item.message}
      </Text>
      {item.actionLabel ? (
        <Touch
          accessibilityRole="button"
          accessibilityLabel={item.actionLabel}
          onPress={() => {
            item.onAction?.();
            onDismiss();
          }}
          style={styles.action}
        >
          <Text variant="label" color={c.isDark ? c.primary : '#9BE0A8'} style={{ fontWeight: '800' }}>
            {item.actionLabel}
          </Text>
        </Touch>
      ) : (
        <Touch accessibilityRole="button" accessibilityLabel={t('a11y.dismiss')} onPress={onDismiss} style={styles.action} hapticType={false}>
          <Icon name="close" size={18} color={fg} />
        </Touch>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  host: { position: 'absolute', left: 12, right: 12, alignItems: 'center', gap: 8 },
  toast: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingRight: 4, minHeight: 52, maxWidth: 520, width: '100%', overflow: 'hidden' },
  stripe: { width: 5, alignSelf: 'stretch' },
  msg: { flex: 1, paddingVertical: 10 },
  action: { minHeight: 48, minWidth: 48, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },
});
