import React, { useEffect, useState } from 'react';
import {
  Animated,
  Easing,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/theme/ThemeProvider';
import { useT } from '@/i18n';
import { useLatest } from '@/lib/useLatest';
import { Text } from './Text';
import { IconButton } from './IconButton';

export interface SheetProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  /** Wrap children in a ScrollView (default true). */
  scroll?: boolean;
  /** Max height as a fraction of the window (default 0.88). */
  maxHeightRatio?: number;
}

const native = Platform.OS !== 'web';

/**
 * Bottom sheet with drag handle (drag down or tap backdrop to dismiss).
 * Built on RN Animated + PanResponder so it behaves identically on web.
 */
export function Sheet({ visible, onClose, title, children, scroll = true, maxHeightRatio = 0.88 }: SheetProps) {
  const { colors: c, radii, shadows } = useTheme();
  const { t } = useT();
  const insets = useSafeAreaInsets();
  const { height, width } = useWindowDimensions();
  const [mounted, setMounted] = useState(visible);
  const [progress] = useState(() => new Animated.Value(0));
  const [drag] = useState(() => new Animated.Value(0));
  const closeRef = useLatest(onClose);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      drag.setValue(0);
      Animated.timing(progress, { toValue: 1, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: native }).start();
    } else if (mounted) {
      Animated.timing(progress, { toValue: 0, duration: 200, easing: Easing.in(Easing.cubic), useNativeDriver: native }).start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const [pan] = useState(() =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 4,
      onPanResponderMove: (_e, g) => drag.setValue(Math.max(0, g.dy)),
      onPanResponderRelease: (_e, g) => {
        if (g.dy > 90 || g.vy > 0.9) {
          closeRef.current();
        } else {
          Animated.spring(drag, { toValue: 0, useNativeDriver: native, damping: 20, stiffness: 300 }).start();
        }
      },
      onPanResponderTerminate: () => Animated.spring(drag, { toValue: 0, useNativeDriver: native }).start(),
    }),
  );

  if (!mounted) return null;
  const translateY = Animated.add(
    progress.interpolate({ inputRange: [0, 1], outputRange: [height, 0] }),
    drag,
  );
  const wide = width >= 700;
  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose} statusBarTranslucent supportedOrientations={['portrait', 'landscape']}>
      <View style={styles.root}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: c.overlay, opacity: progress }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel={t('common.close')} />
        </Animated.View>
        <Animated.View
          accessibilityViewIsModal
          style={[
            styles.sheet,
            {
              backgroundColor: c.surface,
              borderTopLeftRadius: radii.xl,
              borderTopRightRadius: radii.xl,
              maxHeight: height * maxHeightRatio,
              paddingBottom: Math.max(insets.bottom, 12),
              boxShadow: shadows.lg,
              width: wide ? 560 : '100%',
              transform: [{ translateY }],
            },
          ]}
        >
          <View {...pan.panHandlers} style={styles.handleArea} accessibilityRole="adjustable" accessibilityLabel={t('common.dragHandle')}>
            <View style={[styles.handle, { backgroundColor: c.borderStrong }]} />
          </View>
          {title ? (
            <View style={styles.titleRow}>
              <Text variant="heading" style={{ flex: 1 }} accessibilityRole="header">
                {title}
              </Text>
              <IconButton icon="close" label={t('common.close')} onPress={onClose} />
            </View>
          ) : null}
          {scroll ? (
            <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              {children}
            </ScrollView>
          ) : (
            <View style={styles.content}>{children}</View>
          )}
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end', alignItems: 'center' },
  sheet: { overflow: 'hidden' },
  handleArea: { height: 28, alignItems: 'center', justifyContent: 'center' },
  handle: { width: 44, height: 5, borderRadius: 3 },
  titleRow: { flexDirection: 'row', alignItems: 'center', paddingLeft: 20, paddingRight: 8 },
  content: { paddingHorizontal: 20, paddingBottom: 8, gap: 4 },
});
