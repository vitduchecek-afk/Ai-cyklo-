import React, { useState } from 'react';
import { View } from 'react-native';
import type { Severity } from '@trailpack/shared';
import { useTheme } from '@/theme/ThemeProvider';
import { useT } from '@/i18n';
import { Icon, type IconName } from '@/components/icons/Icon';
import { Text } from './Text';
import { Touch } from './Touch';

export interface AdvisorySections {
  /** Why this advice is given. */
  why?: string;
  /** Data sources used (e.g. "Open-Meteo, 2 h old"). */
  data?: string[];
  alternatives?: string[];
  /** What we are not sure about. */
  uncertainty?: string;
  howToUse?: string;
}

export interface AdvisoryCardProps {
  severity?: Severity;
  title: string;
  summary?: string;
  sections?: AdvisorySections;
  defaultExpanded?: boolean;
}

/** Explainable advice: headline + expandable why / data / alternatives / uncertainty / how to use. */
export function AdvisoryCard({ severity = 'info', title, summary, sections, defaultExpanded = false }: AdvisoryCardProps) {
  const { colors: c, radii } = useTheme();
  const { t } = useT();
  const [open, setOpen] = useState(defaultExpanded);
  const m = {
    info: { solid: c.info, soft: c.infoSoft, icon: 'info' as IconName, label: t('advisory.severityInfo') },
    warning: { solid: c.warning, soft: c.warningSoft, icon: 'warning' as IconName, label: t('advisory.severityWarning') },
    danger: { solid: c.danger, soft: c.dangerSoft, icon: 'warning' as IconName, label: t('advisory.severityDanger') },
  }[severity];
  const hasDetails = !!sections && Object.values(sections).some((v) => (Array.isArray(v) ? v.length : !!v));

  const block = (label: string, body?: string | string[]) => {
    if (!body || (Array.isArray(body) && body.length === 0)) return null;
    return (
      <View style={{ gap: 2 }} key={label}>
        <Text variant="overline" color={m.solid}>
          {label}
        </Text>
        {Array.isArray(body) ? (
          body.map((b, i) => (
            <Text key={i} variant="body">
              {'•  '}
              {b}
            </Text>
          ))
        ) : (
          <Text variant="body">{body}</Text>
        )}
      </View>
    );
  };

  return (
    <View
      style={{
        backgroundColor: m.soft,
        borderRadius: radii.lg,
        borderLeftWidth: 6,
        borderLeftColor: m.solid,
        overflow: 'hidden',
      }}
    >
      <Touch
        accessibilityRole={hasDetails ? 'button' : 'text'}
        accessibilityLabel={`${m.label}: ${title}`}
        accessibilityHint={hasDetails ? t(open ? 'advisory.collapse' : 'advisory.expand') : undefined}
        accessibilityState={{ expanded: hasDetails ? open : undefined }}
        disabled={!hasDetails}
        onPress={() => setOpen((o) => !o)}
        scale={false}
        style={{ flexDirection: 'row', gap: 12, padding: 14, alignItems: 'flex-start' }}
      >
        <Icon name={m.icon} size={22} color={m.solid} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="bodyStrong" color={m.solid}>
            {title}
          </Text>
          {summary ? <Text variant="body">{summary}</Text> : null}
        </View>
        {hasDetails ? <Icon name={open ? 'chevron-up' : 'chevron-down'} size={22} color={m.solid} /> : null}
      </Touch>
      {open && sections ? (
        <View style={{ paddingHorizontal: 14, paddingBottom: 14, paddingLeft: 48, gap: 10 }}>
          {block(t('advisory.why'), sections.why)}
          {block(t('advisory.data'), sections.data)}
          {block(t('advisory.alternatives'), sections.alternatives)}
          {block(t('advisory.uncertainty'), sections.uncertainty)}
          {block(t('advisory.howToUse'), sections.howToUse)}
        </View>
      ) : null}
    </View>
  );
}
