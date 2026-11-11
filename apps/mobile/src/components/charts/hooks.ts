import { useEffect, useState } from 'react';
import { Animated, Easing, type LayoutChangeEvent } from 'react-native';

/** Measure a view's width via onLayout. */
export function useWidth(initial = 0): [number, (e: LayoutChangeEvent) => void] {
  const [w, setW] = useState(initial);
  return [
    w,
    (e) => {
      const next = Math.round(e.nativeEvent.layout.width);
      setW((cur) => (cur === next ? cur : next));
    },
  ];
}

/** Animates 0 → 1 (re-runs when `key` changes) and returns the current progress. */
export function useGrow(key: unknown, duration = 600): number {
  const [value, setValue] = useState(0);
  useEffect(() => {
    const v = new Animated.Value(0);
    const id = v.addListener(({ value: x }) => setValue(x));
    Animated.timing(v, { toValue: 1, duration, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
    return () => v.removeListener(id);
  }, [key, duration]);
  return value;
}
