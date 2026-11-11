import React from 'react';
import { View } from 'react-native';
import { useNetworkState } from 'expo-network';
import { useTheme } from '@/theme/ThemeProvider';
import { useT } from '@/i18n';
import { Icon } from '@/components/icons/Icon';
import { Text } from './Text';

/** Hook: true when the device has no connectivity (unknown = online). */
export function useIsOffline(): boolean {
  const net = useNetworkState();
  return net.isConnected === false || net.isInternetReachable === false;
}

export function OfflineBanner() {
  const { colors: c } = useTheme();
  const { t } = useT();
  const offline = useIsOffline();
  if (!offline) return null;
  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 8, backgroundColor: c.warningSoft }}
    >
      <Icon name="offline" size={18} color={c.warning} />
      <Text variant="caption" color={c.warning} style={{ flex: 1, fontWeight: '600' }}>
        {t('common.offline')} · {t('common.offlineHint')}
      </Text>
    </View>
  );
}
