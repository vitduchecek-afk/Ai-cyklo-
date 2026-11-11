import { DEFAULT_GEAR_CATEGORIES, calculatePackWeight, WEIGHT_CLASS_LABELS_CS, type GearEntry } from '@trailpack/gear';
import { formatWeight, newEntityBase, type GearItem } from '@trailpack/shared';
import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { DonutChart } from '@/components/charts';
import {
  Button, Card, EmptyState, ListItem, NumberField, Screen, SectionHeader, SegmentedControl, Select, Sheet, SwipeableRow, Text, TextField, toast,
} from '@/components/ui';
import { useAddGearItem, useDeleteGearItem, useGearItems, useRestoreGearItem } from '@/data/hooks';
import { useTheme } from '@/theme/ThemeProvider';

type Carry = 'packed' | 'worn' | 'consumable';
const catName = (key: string) => DEFAULT_GEAR_CATEGORIES.find((c) => c.key === key)?.name ?? key;
const carryOf = (i: GearItem): Carry => {
  const v = i.specs?.carryMode;
  return v === 'worn' || v === 'consumable' ? v : 'packed';
};
const CARRY_LABEL: Record<Carry, string> = { packed: 'v batohu', worn: 'na těle', consumable: 'spotřební' };

export default function GearScreen() {
  const theme = useTheme();
  const { data: items = [], isLoading } = useGearItems();
  const add = useAddGearItem();
  const del = useDeleteGearItem();
  const restore = useRestoreGearItem();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [cat, setCat] = useState<string | null>('packs');
  const [weight, setWeight] = useState<number | null>(null);
  const [qty, setQty] = useState<number | null>(1);
  const [carry, setCarry] = useState<Carry>('packed');

  const pack = useMemo(() => {
    const entries: GearEntry[] = items.map((item) => ({
      item,
      entry: { ...newEntityBase(), loadoutId: 'all', gearItemId: item.id, quantity: item.quantity, carryMode: carryOf(item), packed: false },
    }));
    return calculatePackWeight(entries);
  }, [items]);

  const donut = useMemo(
    () =>
      DEFAULT_GEAR_CATEGORIES.map((c) => {
        const w = pack.byCategory[c.key];
        return { key: c.key, label: c.name, color: c.color, value: w ? w.baseG + w.wornG + w.consumableG : 0 };
      }).filter((d) => d.value > 0),
    [pack],
  );

  const save = () => {
    if (!name.trim() || weight == null || !cat) {
      toast.error('Vyplňte název, kategorii a hmotnost.');
      return;
    }
    add.mutate(
      { name: name.trim(), categoryKey: cat, weightG: weight, quantity: qty ?? 1, specs: { carryMode: carry } },
      {
        onSuccess: () => {
          setOpen(false);
          setName('');
          setWeight(null);
          setQty(1);
          toast.success('Položka přidána');
        },
        onError: () => toast.error('Položku se nepodařilo uložit.'),
      },
    );
  };

  return (
    <Screen title="Výbava" subtitle={`${items.length} položek`} actions={<Button label="Přidat" icon="plus" onPress={() => setOpen(true)} />}>
      {items.length > 0 ? (
        <Card>
          <SectionHeader title="Hmotnost batohu" />
          <Text>
            Základní {formatWeight(pack.baseG)} · Na těle {formatWeight(pack.wornG)} · Spotřební {formatWeight(pack.consumableG)}
          </Text>
          <Text variant="title">Celkem {formatWeight(pack.totalG)}</Text>
          <Text tone="muted">Třída: {WEIGHT_CLASS_LABELS_CS[pack.classification]}</Text>
          <View style={{ height: theme.spacing.md }} />
          <DonutChart data={donut} formatValue={(v) => formatWeight(v)} centerLabel="Celkem" centerValue={formatWeight(pack.totalG)} />
        </Card>
      ) : null}
      <View style={{ height: theme.spacing.md }} />
      {!isLoading && items.length === 0 ? (
        <EmptyState icon="backpack" title="Zatím žádná výbava" body="Přidejte první kus výbavy a uvidíte hmotnost batohu." actionLabel="Přidat" onAction={() => setOpen(true)} />
      ) : (
        items.map((i) => (
          <SwipeableRow key={i.id} onDelete={() => del.mutate(i.id, { onSuccess: () => toast.undo(`Smazáno: ${i.name}`, () => restore.mutate(i.id)) })}>
            <ListItem
              title={i.name}
              subtitle={`${catName(i.categoryKey)} · ${CARRY_LABEL[carryOf(i)]}`}
              trailing={<Text>{`${i.quantity} × ${formatWeight(i.weightG)}`}</Text>}
            />
          </SwipeableRow>
        ))
      )}
      <Sheet visible={open} onClose={() => setOpen(false)} title="Přidat výbavu">
        <View style={{ gap: theme.spacing.md }}>
          <TextField label="Název" value={name} onChangeText={setName} />
          <Select label="Kategorie" value={cat} onChange={setCat} options={DEFAULT_GEAR_CATEGORIES.map((c) => ({ value: c.key, label: c.name }))} />
          <NumberField label="Hmotnost (1 ks)" unit="g" value={weight} onChange={setWeight} min={0} />
          <NumberField label="Počet" value={qty} onChange={setQty} min={1} max={999} />
          <SegmentedControl<Carry>
            value={carry}
            onChange={setCarry}
            options={[
              { value: 'packed', label: 'V batohu' },
              { value: 'worn', label: 'Na těle' },
              { value: 'consumable', label: 'Spotřební' },
            ]}
          />
          <Button label="Uložit" onPress={save} loading={add.isPending} fullWidth />
        </View>
      </Sheet>
    </Screen>
  );
}
