import React, { useState } from 'react';
import { PanResponder, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { useTheme } from '@/theme/ThemeProvider';
import { useT } from '@/i18n';
import { haptic } from '@/lib/haptics';
import { useLatest } from '@/lib/useLatest';
import { Icon } from '@/components/icons/Icon';
import { IconButton } from './IconButton';

export interface DraggableListProps<T> {
  items: T[];
  keyExtractor: (item: T) => string;
  renderItem: (item: T, info: { index: number; dragging: boolean }) => React.ReactNode;
  onReorder: (items: T[]) => void;
  /** Show visible up/down buttons next to the handle (also always exposed as accessibility actions). */
  moveButtons?: boolean;
  gap?: number;
}

export function moveItem<T>(arr: readonly T[], from: number, to: number): T[] {
  const next = arr.slice();
  const [it] = next.splice(from, 1);
  next.splice(to, 0, it as T);
  return next;
}

interface DragState {
  index: number;
  dy: number;
  over: number;
}

/**
 * Reorderable list. Press and drag the grip handle to move an item; screen
 * readers get "move up / move down" actions, and optional visible buttons.
 */
export function DraggableList<T>({ items, keyExtractor, renderItem, onReorder, moveButtons, gap = 10 }: DraggableListProps<T>) {
  const { colors: c, radii, shadows } = useTheme();
  const { t } = useT();
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [drag, setDrag] = useState<DragState | null>(null);

  const latest = useLatest({ items, heights, gap, onReorder, keyExtractor });

  const overFor = (index: number, dy: number) => {
    const { items: its, heights: hs, gap: g, keyExtractor: kx } = latest.current;
    const h = (i: number) => (hs[kx(its[i] as T)] ?? 60) + g;
    let top = 0;
    for (let i = 0; i < index; i++) top += h(i);
    const center = top + h(index) / 2 + dy;
    let acc = 0;
    for (let i = 0; i < its.length; i++) {
      acc += h(i);
      if (center < acc) return i;
    }
    return its.length - 1;
  };

  const begin = (index: number) => {
    haptic.medium();
    setDrag({ index, dy: 0, over: index });
  };
  const move = (index: number, dy: number) => {
    const over = overFor(index, dy);
    setDrag((d) => {
      if (d && over !== d.over) haptic.select();
      return { index, dy, over };
    });
  };
  const end = (index: number, dy: number) => {
    const over = overFor(index, dy);
    setDrag(null);
    if (over !== index) {
      haptic.light();
      latest.current.onReorder(moveItem(latest.current.items, index, over));
    }
  };
  const step = (index: number, dir: -1 | 1) => {
    const to = index + dir;
    if (to < 0 || to >= items.length) return;
    haptic.light();
    onReorder(moveItem(items, index, to));
  };

  return (
    <View accessibilityRole="list" style={{ gap }}>
      {items.map((item, index) => {
        const key = keyExtractor(item);
        const dragging = drag?.index === index;
        const dragH = drag ? (heights[keyExtractor(items[drag.index] as T)] ?? 60) + gap : 0;
        let shift = 0;
        if (drag && !dragging) {
          if (index > drag.index && index <= drag.over) shift = -dragH;
          else if (index < drag.index && index >= drag.over) shift = dragH;
        }
        return (
          <DragRow
            key={key}
            index={index}
            count={items.length}
            dragging={dragging}
            translateY={dragging ? (drag?.dy ?? 0) : shift}
            moveButtons={moveButtons}
            onLayout={(e) => {
              const h = e.nativeEvent.layout.height;
              setHeights((prev) => (prev[key] === h ? prev : { ...prev, [key]: h }));
            }}
            onBegin={begin}
            onMove={move}
            onEnd={end}
            onStep={step}
            colors={c}
            radius={radii.md}
            shadow={shadows.lg}
            labels={{ up: t('common.moveUp'), down: t('common.moveDown'), handle: t('common.dragHandle') }}
          >
            {renderItem(item, { index, dragging })}
          </DragRow>
        );
      })}
    </View>
  );
}

interface DragRowProps {
  index: number;
  count: number;
  dragging: boolean;
  translateY: number;
  moveButtons?: boolean;
  children: React.ReactNode;
  onLayout: (e: LayoutChangeEvent) => void;
  onBegin: (i: number) => void;
  onMove: (i: number, dy: number) => void;
  onEnd: (i: number, dy: number) => void;
  onStep: (i: number, dir: -1 | 1) => void;
  colors: ReturnType<typeof useTheme>['colors'];
  radius: number;
  shadow: string;
  labels: { up: string; down: string; handle: string };
}

function DragRow(p: DragRowProps) {
  const props = useLatest(p);
  const [pan] = useState(() =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => props.current.onBegin(props.current.index),
      onPanResponderMove: (_e, g) => props.current.onMove(props.current.index, g.dy),
      onPanResponderRelease: (_e, g) => props.current.onEnd(props.current.index, g.dy),
      onPanResponderTerminate: (_e, g) => props.current.onEnd(props.current.index, g.dy),
    }),
  );
  const { colors: c } = p;
  return (
    <View
      onLayout={p.onLayout}
      accessible={false}
      accessibilityActions={[
        { name: 'decrement', label: p.labels.up },
        { name: 'increment', label: p.labels.down },
      ]}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === 'decrement') p.onStep(p.index, -1);
        if (e.nativeEvent.actionName === 'increment') p.onStep(p.index, 1);
      }}
      style={[
        styles.row,
        {
          backgroundColor: c.surface,
          borderRadius: p.radius,
          borderColor: p.dragging ? c.primary : c.border,
          borderWidth: p.dragging ? 2 : 1,
          transform: [{ translateY: p.translateY }, { scale: p.dragging ? 1.02 : 1 }],
          zIndex: p.dragging ? 20 : 1,
          boxShadow: p.dragging ? p.shadow : undefined,
        },
      ]}
    >
      <View
        {...pan.panHandlers}
        accessibilityRole="button"
        accessibilityLabel={p.labels.handle}
        style={styles.handle}
      >
        <Icon name="menu" size={22} color={c.textSubtle} />
      </View>
      <View style={styles.content}>{p.children}</View>
      {p.moveButtons ? (
        <View style={styles.moves}>
          <IconButton icon="chevron-up" label={p.labels.up} size={40} iconSize={20} disabled={p.index === 0} onPress={() => p.onStep(p.index, -1)} />
          <IconButton icon="chevron-down" label={p.labels.down} size={40} iconSize={20} disabled={p.index === p.count - 1} onPress={() => p.onStep(p.index, 1)} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingRight: 8 },
  handle: { width: 48, minHeight: 56, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center', cursor: 'grab' } as object,
  content: { flex: 1, paddingVertical: 10 },
  moves: { flexDirection: 'row' },
});
