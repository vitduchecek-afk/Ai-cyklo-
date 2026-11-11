import React, { useState } from 'react';
import { TextInput, View, type TextInputProps } from 'react-native';
import { MIN_TOUCH } from '@trailpack/ui';
import { useTheme } from '@/theme/ThemeProvider';
import { Icon, type IconName } from '@/components/icons/Icon';
import { Text } from './Text';

export interface TextFieldProps extends Omit<TextInputProps, 'style'> {
  label?: string;
  helper?: string;
  error?: string;
  icon?: IconName;
  suffix?: React.ReactNode;
  /** Render a multi-line field with this many lines. */
  lines?: number;
}

export function TextField({ label, helper, error, icon, suffix, lines, multiline, onFocus, onBlur, ...rest }: TextFieldProps) {
  const { colors: c, radii, fs } = useTheme();
  const [focused, setFocused] = useState(false);
  const isMulti = multiline || (lines ?? 1) > 1;
  const border = error ? c.danger : focused ? c.primary : c.borderStrong;
  return (
    <View style={{ gap: 6 }}>
      {label ? (
        <Text variant="label" tone="muted">
          {label}
        </Text>
      ) : null}
      <View
        style={{
          flexDirection: 'row',
          alignItems: isMulti ? 'flex-start' : 'center',
          gap: 8,
          minHeight: MIN_TOUCH + 4,
          paddingHorizontal: 14,
          backgroundColor: c.surface,
          borderRadius: radii.md,
          borderWidth: focused ? 2 : 1.5,
          borderColor: border,
        }}
      >
        {icon ? <Icon name={icon} size={20} color={c.textSubtle} /> : null}
        <TextInput
          {...rest}
          multiline={isMulti}
          numberOfLines={lines}
          accessibilityLabel={rest.accessibilityLabel ?? label}
          placeholderTextColor={c.textSubtle}
          selectionColor={c.primary}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          style={[
            {
              flex: 1,
              color: c.text,
              fontSize: fs(16),
              paddingVertical: isMulti ? 12 : 10,
              minHeight: isMulti ? (lines ?? 3) * fs(22) + 24 : undefined,
              textAlignVertical: isMulti ? 'top' : 'center',
            },
            // remove the browser focus outline: the border shows focus
            { outlineStyle: 'none' } as object,
          ]}
        />
        {suffix}
      </View>
      {error || helper ? (
        <Text variant="caption" tone={error ? 'danger' : 'subtle'} accessibilityLiveRegion={error ? 'polite' : undefined}>
          {error ?? helper}
        </Text>
      ) : null}
    </View>
  );
}
