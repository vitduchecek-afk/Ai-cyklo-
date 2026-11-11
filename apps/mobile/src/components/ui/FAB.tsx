import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '@/theme/ThemeProvider';
import { Icon, type IconName } from '@/components/icons/Icon';
import { Text } from './Text';
import { Touch } from './Touch';

export interface FABProps {
  icon: IconName;
  label: string;
  /** Show the label next to the icon (extended FAB). */
  extended?: boolean;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
}

/** Floating action button, anchored bottom-right (thumb zone). Place inside a positioned parent. */
export function FAB({ icon, label, extended, onPress, style }: FABProps) {
  const { colors: c, shadows } = useTheme();
  return (
    <View pointerEvents="box-none" style={[{ position: 'absolute', right: 16, bottom: 16 }, style]}>
      <Touch
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        hapticType="medium"
        style={{
          minWidth: 60,
          height: 60,
          borderRadius: 30,
          paddingHorizontal: extended ? 22 : 0,
          flexDirection: 'row',
          gap: 8,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: c.primary,
          boxShadow: shadows.lg,
        }}
      >
        <Icon name={icon} size={26} color={c.onPrimary} />
        {extended ? (
          <Text variant="bodyStrong" color={c.onPrimary}>
            {label}
          </Text>
        ) : null}
      </Touch>
    </View>
  );
}
