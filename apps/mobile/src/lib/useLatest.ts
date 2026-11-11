import { useEffect, useRef } from 'react';

/** Ref that always holds the latest value (for stable PanResponder callbacks). */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}
