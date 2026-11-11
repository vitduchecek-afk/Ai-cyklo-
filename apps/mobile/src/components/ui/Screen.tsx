import React from 'react';
import { RefreshControl, ScrollView, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { layout } from '@trailpack/ui';
import { useTheme } from '@/theme/ThemeProvider';
import { AppHeader, type AppHeaderProps } from './AppHeader';
import { OfflineBanner } from './OfflineBanner';

export interface ScreenProps extends Partial<AppHeaderProps> {
  children: React.ReactNode;
  /** Scrollable body (default true). Set false for full-bleed content such as maps. */
  scroll?: boolean;
  /** Pull-to-refresh. */
  refreshing?: boolean;
  onRefresh?: () => void;
  /** Horizontal + vertical content padding (default true). */
  padded?: boolean;
  /** Limit content width on wide screens (default layout.maxContentWidth). */
  maxWidth?: number;
  /** Absolutely positioned overlay (e.g. <FAB/>). */
  overlay?: React.ReactNode;
  /** Vertical gap between direct children. */
  gap?: number;
  contentStyle?: StyleProp<ViewStyle>;
  hideHeader?: boolean;
}

/** Page scaffold: safe area, header, offline banner, optional scroll + pull-to-refresh, centred content. */
export function Screen({
  children,
  title,
  subtitle,
  back,
  actions,
  showMenu,
  leading,
  scroll = true,
  refreshing,
  onRefresh,
  padded = true,
  maxWidth = layout.maxContentWidth,
  overlay,
  gap = 16,
  contentStyle,
  hideHeader,
}: ScreenProps) {
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const body = (
    <View
      style={[
        { width: '100%', maxWidth, alignSelf: 'center', gap },
        padded ? { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 28 } : null,
        !scroll ? { flex: 1 } : null,
        contentStyle,
      ]}
    >
      {children}
    </View>
  );
  return (
    <View style={{ flex: 1, backgroundColor: c.bg, paddingTop: insets.top }}>
      {!hideHeader && title ? (
        <View style={{ width: '100%', maxWidth, alignSelf: 'center' }}>
          <AppHeader title={title} subtitle={subtitle} back={back} actions={actions} showMenu={showMenu} leading={leading} />
        </View>
      ) : null}
      <OfflineBanner />
      {scroll ? (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ flexGrow: 1 }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={c.primary} colors={[c.primary]} /> : undefined}
        >
          {body}
        </ScrollView>
      ) : (
        body
      )}
      {overlay}
    </View>
  );
}
