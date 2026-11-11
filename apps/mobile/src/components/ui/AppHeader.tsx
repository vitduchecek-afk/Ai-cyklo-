import React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '@/theme/ThemeProvider';
import { useT } from '@/i18n';
import { useUiStore } from '@/stores/ui';
import { Text } from './Text';
import { IconButton } from './IconButton';

export interface AppHeaderProps {
  title: string;
  subtitle?: string;
  /** Show a back button (uses router.back, falls back to home). */
  back?: boolean | (() => void);
  /** Right-aligned action buttons. */
  actions?: React.ReactNode;
  /** Show the "Více" menu button (default true unless `back`). */
  showMenu?: boolean;
  /** Leading brand / visual element for the home screen. */
  leading?: React.ReactNode;
}

export function AppHeader({ title, subtitle, back, actions, showMenu, leading }: AppHeaderProps) {
  const router = useRouter();
  const { t } = useT();
  const { colors: c } = useTheme();
  const openMore = useUiStore((s) => s.openMore);
  const menu = showMenu ?? !back;
  const goBack = () => {
    if (typeof back === 'function') return back();
    if (router.canGoBack()) router.back();
    else router.replace('/' as never);
  };
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 64, paddingLeft: back ? 4 : 20, paddingRight: 8 }}>
      {back ? <IconButton icon="arrow-left" label={t('common.back')} onPress={goBack} /> : null}
      {leading}
      <View style={{ flex: 1, paddingVertical: 8 }}>
        <Text variant={back ? 'heading' : 'title'} numberOfLines={1} accessibilityRole="header" color={c.text}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="caption" tone="muted" numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {actions}
      {menu ? <IconButton icon="menu" label={t('a11y.menu')} onPress={openMore} /> : null}
    </View>
  );
}
