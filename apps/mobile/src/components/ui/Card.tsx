import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '@/theme/ThemeProvider';
import { Touch } from './Touch';

export interface CardProps {
  children?: React.ReactNode;
  variant?: 'elevated' | 'outlined' | 'tonal' | 'flat';
  padding?: number;
  onPress?: () => void;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Card({ children, variant = 'elevated', padding = 16, onPress, accessibilityLabel, style, testID }: CardProps) {
  const { colors: c, radii, shadows, scheme } = useTheme();
  const base: ViewStyle = {
    backgroundColor: variant === 'tonal' ? c.surfaceAlt : c.surface,
    borderRadius: radii.lg,
    padding,
    borderWidth: variant === 'outlined' || scheme === 'outdoor' ? (scheme === 'outdoor' ? 2 : 1) : variant === 'elevated' ? 1 : 0,
    borderColor: variant === 'elevated' && scheme !== 'outdoor' ? c.border : c.border,
    boxShadow: variant === 'elevated' ? shadows.sm : undefined,
  };
  if (onPress) {
    return (
      <Touch testID={testID} accessibilityRole="button" accessibilityLabel={accessibilityLabel} onPress={onPress} style={[base, style]}>
        {children}
      </Touch>
    );
  }
  return (
    <View testID={testID} accessibilityLabel={accessibilityLabel} style={[base, style]}>
      {children}
    </View>
  );
}
