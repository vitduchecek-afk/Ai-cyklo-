import { EmptyState, Screen } from '@/components/ui';

/**
 * Honest placeholder for screens whose data wiring is not finished yet in
 * this development build (see docs/STATUS.md). It never pretends data exists.
 */
export function DevelopmentNotice({ title, description }: { title: string; description: string }) {
  return (
    <Screen title={title}>
      <EmptyState
        icon="info"
        title="Obrazovka se připravuje"
        body={`${description}\n\nDoménová logika je hotová a otestovaná v balíčcích @trailpack/*; napojení této obrazovky na data je další krok vývoje (viz docs/STATUS.md).`}
      />
    </Screen>
  );
}
