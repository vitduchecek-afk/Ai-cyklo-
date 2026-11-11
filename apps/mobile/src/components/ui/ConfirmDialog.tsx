import React, { useCallback, useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '@/theme/ThemeProvider';
import { translate } from '@/i18n';
import { haptic } from '@/lib/haptics';
import { Button } from './Button';
import { Text } from './Text';
import { Icon } from '@/components/icons/Icon';

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

interface Pending extends ConfirmOptions {
  resolve: (v: boolean) => void;
}

let open: ((o: ConfirmOptions) => Promise<boolean>) | null = null;

/**
 * Promise-based confirmation dialog (works outside React once <ConfirmProvider> is mounted).
 *   if (await confirm({ title: 'Smazat?', destructive: true })) remove();
 */
export function confirm(o: ConfirmOptions): Promise<boolean> {
  if (!open) {
    console.warn('[confirm] ConfirmProvider is not mounted');
    return Promise.resolve(false);
  }
  return open(o);
}

export const useConfirm = () => confirm;

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [queue, setQueue] = useState<Pending[]>([]);
  const current = queue[0];

  const ask = useCallback(
    (o: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        if (o.destructive) haptic.warning();
        setQueue((q) => [...q, { ...o, resolve }]);
      }),
    [],
  );
  useEffect(() => {
    open = ask;
    return () => {
      open = null;
    };
  }, [ask]);

  const close = (v: boolean) => {
    current?.resolve(v);
    setQueue((q) => q.slice(1));
  };

  return (
    <>
      {children}
      {current ? <Dialog opts={current} onResult={close} /> : null}
    </>
  );
}

function Dialog({ opts, onResult }: { opts: ConfirmOptions; onResult: (v: boolean) => void }) {
  const { colors: c, radii, shadows } = useTheme();
  return (
    <Modal transparent visible animationType="fade" onRequestClose={() => onResult(false)} statusBarTranslucent>
      <View style={[styles.backdrop, { backgroundColor: c.overlay }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={() => onResult(false)} accessibilityElementsHidden importantForAccessibility="no" />
        <View
          accessibilityViewIsModal
          accessibilityRole="alert"
          style={[styles.dialog, { backgroundColor: c.surface, borderRadius: radii.xl, boxShadow: shadows.lg }]}
        >
          {opts.destructive ? (
            <View style={[styles.badge, { backgroundColor: c.dangerSoft }]}>
              <Icon name="warning" size={26} color={c.danger} />
            </View>
          ) : null}
          <Text variant="heading" accessibilityRole="header">
            {opts.title}
          </Text>
          {opts.message ? (
            <Text variant="body" tone="muted">
              {opts.message}
            </Text>
          ) : null}
          <View style={styles.actions}>
            <Button label={opts.cancelLabel ?? translate('common.cancel')} variant="ghost" onPress={() => onResult(false)} />
            <Button
              label={opts.confirmLabel ?? translate('common.ok')}
              variant={opts.destructive ? 'danger' : 'primary'}
              onPress={() => onResult(true)}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  dialog: { width: '100%', maxWidth: 420, padding: 22, gap: 10 },
  badge: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 10 },
});
