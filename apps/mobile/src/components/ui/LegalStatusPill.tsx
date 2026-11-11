import React from 'react';
import type { LegalStatus } from '@trailpack/ui';
import { useT } from '@/i18n';
import type { IconName } from '@/components/icons/Icon';
import { Badge, type Tone } from './Badge';

const MAP: Record<LegalStatus, { tone: Tone; icon: IconName }> = {
  verified_allowed: { tone: 'success', icon: 'check' },
  conditional: { tone: 'warning', icon: 'warning' },
  prohibited: { tone: 'danger', icon: 'close' },
  unverified: { tone: 'neutral', icon: 'info' },
};

/** Legal status of an activity at a place: colour + icon + text (never colour alone). */
export function LegalStatusPill({ status }: { status: LegalStatus }) {
  const { t } = useT();
  const m = MAP[status];
  return <Badge tone={m.tone} icon={m.icon} label={t(`legal.${status}`)} />;
}
