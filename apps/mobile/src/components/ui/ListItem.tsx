import React from 'react';
import { StyleSheet, View } from 'react-native';
import { MIN_TOUCH } from '@trailpack/ui';
import { useTheme } from '@/theme/ThemeProvider';
import { Icon, type IconName } from '@/components/icons/Icon';
import { Text } from './Text';
import { Touch } from './Touch';

export interface ListItemProps {
  title: string;
  subtitle?: string;
  /** Icon name (rendered in a tinted circle) or a custom node. */
  leading?: IconName | React.ReactNode;
  leadingTone?: 'primary' | 'water' | 'camp' | 'warning' | 'danger' | 'info' | 'success';
  trailing?: React.ReactNode;
  chevron?: boolean;
  onPress?: () => void;
  destructive?: boolean;
  selected?: boolean;
  divider?: boolean;
  accessibilityHint?: string;
  testID?: string;
}

export function ListItem({
  title,
  subtitle,
  leading,
  leadingTone = 'primary',
  trailing,
  chevron,
  onPress,
  destructive,
  selected,
  divider,
  accessibilityHint,
  testID,
}: ListItemProps) {
  const { colors: c } = useTheme();
  const tone = {
    primary: [c.primarySoft, c.onPrimarySoft],
    water: [c.waterSoft, c.water],
    camp: [c.campSoft, c.camp],
    warning: [c.warningSoft, c.warning],
    danger: [c.dangerSoft, c.danger],
    info: [c.infoSoft, c.info],
    success: [c.successSoft, c.success],
  }[destructive ? 'danger' : leadingTone] as [string, string];
  const content = (
    <View style={[styles.row, divider && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border }]}>
      {leading ? (
        typeof leading === 'string' ? (
          <View style={[styles.lead, { backgroundColor: tone[0] }]}>
            <Icon name={leading as IconName} size={22} color={tone[1]} />
          </View>
        ) : (
          leading
        )
      ) : null}
      <View style={styles.body}>
        <Text variant="bodyStrong" tone={destructive ? 'danger' : 'default'} numberOfLines={2}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="caption" tone="muted" numberOfLines={3}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing}
      {chevron ? <Icon name="chevron-right" size={20} color={c.textSubtle} /> : null}
    </View>
  );
  if (!onPress) return <View testID={testID}>{content}</View>;
  return (
    <Touch
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ selected }}
      onPress={onPress}
      scale={false}
      hoverStyle={{ backgroundColor: c.surfaceAlt }}
      style={selected ? { backgroundColor: c.primarySoft } : undefined}
    >
      {content}
    </Touch>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: MIN_TOUCH + 8, paddingVertical: 10, paddingHorizontal: 4 },
  lead: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, gap: 2 },
});
