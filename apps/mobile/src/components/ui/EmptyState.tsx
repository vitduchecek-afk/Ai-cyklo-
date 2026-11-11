import React from 'react';
import { View } from 'react-native';
import { useTheme } from '@/theme/ThemeProvider';
import { Icon, type IconName } from '@/components/icons/Icon';
import { Text } from './Text';
import { Button } from './Button';

export interface EmptyStateProps {
  icon: IconName;
  title: string;
  body?: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function EmptyState({ icon, title, body, actionLabel, onAction }: EmptyStateProps) {
  const { colors: c } = useTheme();
  return (
    <View style={{ alignItems: 'center', gap: 10, paddingVertical: 32, paddingHorizontal: 24 }}>
      <View
        style={{
          width: 96,
          height: 96,
          borderRadius: 48,
          backgroundColor: c.primarySoft,
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 6,
        }}
      >
        <Icon name={icon} size={44} color={c.onPrimarySoft} strokeWidth={1.6} />
      </View>
      <Text variant="heading" align="center" accessibilityRole="header">
        {title}
      </Text>
      {body ? (
        <Text variant="body" tone="muted" align="center" style={{ maxWidth: 380 }}>
          {body}
        </Text>
      ) : null}
      {actionLabel && onAction ? (
        <View style={{ marginTop: 10 }}>
          <Button label={actionLabel} onPress={onAction} icon="plus" />
        </View>
      ) : null}
    </View>
  );
}
