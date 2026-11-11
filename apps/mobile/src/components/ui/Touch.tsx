import React from 'react';
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import { haptic } from '@/lib/haptics';

export interface TouchProps extends Omit<PressableProps, 'style'> {
  style?: StyleProp<ViewStyle>;
  /** Extra style while hovered (web) */
  hoverStyle?: StyleProp<ViewStyle>;
  /** Haptic on press; `false` disables. Default `'select'`. */
  hapticType?: 'light' | 'select' | 'medium' | false;
  /** Subtle press scale. Default true. */
  scale?: boolean;
}

/** Pressable with consistent pressed/hover feedback and haptics. */
export const Touch = React.forwardRef<React.ComponentRef<typeof Pressable>, TouchProps>(function Touch(
  { style, hoverStyle, hapticType = 'select', scale = true, onPress, children, ...rest },
  ref,
) {
  return (
    <Pressable
      ref={ref}
      {...rest}
      onPress={(e) => {
        if (hapticType) haptic[hapticType]();
        onPress?.(e);
      }}
      style={(state) => {
        const hovered = (state as { hovered?: boolean }).hovered;
        return [
          style,
          hovered ? hoverStyle : null,
          state.pressed ? { opacity: 0.86, transform: scale ? [{ scale: 0.985 }] : undefined } : null,
        ];
      }}
    >
      {children}
    </Pressable>
  );
});
