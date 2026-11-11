import React, { useRef, useState } from 'react';
import { Animated, Easing, PanResponder, Platform, StyleSheet, View } from 'react-native';
import { useTheme } from '@/theme/ThemeProvider';
import { useT } from '@/i18n';
import { haptic } from '@/lib/haptics';
import { useLatest } from '@/lib/useLatest';
import { Icon } from '@/components/icons/Icon';
import { Text } from './Text';
import { Touch } from './Touch';

export interface SwipeableRowProps {
  children: React.ReactNode;
  /** Called after the row has animated out. Pair with `toast.undo` to restore. */
  onDelete: () => void;
  deleteLabel?: string;
}

const ACTION_W = 96;

/** Swipe left to reveal / trigger delete. Also exposes a "delete" accessibility action. */
export function SwipeableRow({ children, onDelete, deleteLabel }: SwipeableRowProps) {
  const { colors: c, radii } = useTheme();
  const { t } = useT();
  const [x] = useState(() => new Animated.Value(0));
  const [h] = useState(() => new Animated.Value(1));
  const [width, setWidth] = useState(360);
  const [measured, setMeasured] = useState<number | null>(null);
  const [removing, setRemoving] = useState(false);
  const base = useLatest({ width, onDelete });
  const open = useRef({ v: false });
  const label = deleteLabel ?? t('common.delete');

  const remove = () => {
    if (removing) return;
    setRemoving(true);
    haptic.warning();
    Animated.parallel([
      Animated.timing(x, { toValue: -base.current.width, duration: 180, easing: Easing.out(Easing.quad), useNativeDriver: false }),
      Animated.timing(h, { toValue: 0, duration: 220, delay: 120, easing: Easing.out(Easing.quad), useNativeDriver: false }),
    ]).start(() => base.current.onDelete());
  };
  const removeRef = useLatest(remove);

  const snap = (to: number) => {
    open.current.v = to !== 0;
    Animated.spring(x, { toValue: to, useNativeDriver: false, damping: 22, stiffness: 300 }).start();
  };

  const [pan] = useState(() =>
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 10 && Math.abs(g.dx) > Math.abs(g.dy) * 1.6,
      onPanResponderMove: (_e, g) => {
        const start = open.current.v ? -ACTION_W : 0;
        x.setValue(Math.min(0, start + g.dx));
      },
      onPanResponderRelease: (_e, g) => {
        const start = open.current.v ? -ACTION_W : 0;
        const pos = start + g.dx;
        if (pos < -base.current.width * 0.55) removeRef.current();
        else if (pos < -ACTION_W / 2) snap(-ACTION_W);
        else snap(0);
      },
    }),
  );

  return (
    <Animated.View
      style={[
        { overflow: 'hidden', borderRadius: radii.md },
        measured ? { height: h.interpolate({ inputRange: [0, 1], outputRange: [0, measured] }) } : null,
      ]}
    >
      <View
        onLayout={(e) => {
          setWidth(e.nativeEvent.layout.width);
          if (!removing) setMeasured(e.nativeEvent.layout.height);
        }}
        accessibilityActions={[{ name: 'delete', label }]}
        onAccessibilityAction={(e) => e.nativeEvent.actionName === 'delete' && remove()}
      >
        <View style={[StyleSheet.absoluteFill, styles.action, { backgroundColor: c.danger, borderRadius: radii.md }]}>
          <Touch
            accessibilityRole="button"
            accessibilityLabel={label}
            onPress={remove}
            style={styles.actionBtn}
          >
            <Icon name="trash" size={22} color={c.onDanger} />
            <Text variant="caption" color={c.onDanger} style={{ fontWeight: '700' }}>
              {label}
            </Text>
          </Touch>
        </View>
        <Animated.View
          {...pan.panHandlers}
          style={{ transform: [{ translateX: x }], backgroundColor: c.surface, borderRadius: radii.md, cursor: Platform.OS === 'web' ? 'grab' : undefined } as object}
        >
          {children}
        </Animated.View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  action: { alignItems: 'flex-end', justifyContent: 'center' },
  actionBtn: { width: ACTION_W, height: '100%', alignItems: 'center', justifyContent: 'center', gap: 2 },
});
