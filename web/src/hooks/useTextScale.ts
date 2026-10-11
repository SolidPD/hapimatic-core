// SPDX-License-Identifier: AGPL-3.0-only
import { useState, useCallback } from "react";
import { getStorageKey } from "@/lib/storage-keys";

const STORAGE_KEY = getStorageKey("hapi:textScale");

export const TEXT_SCALE_STEPS = [
  { value: 0.8, label: "80%" },
  { value: 0.9, label: "90%" },
  { value: 1.0, label: "100%" },
  { value: 1.1, label: "110%" },
  { value: 1.25, label: "125%" },
  { value: 1.5, label: "150%" },
] as const;

const DEFAULT_SCALE = 1.0;

function getStoredScale(): number {
  if (typeof window === "undefined") return DEFAULT_SCALE;
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === null) return DEFAULT_SCALE;
  const parsed = parseFloat(stored);
  if (Number.isNaN(parsed)) return DEFAULT_SCALE;
  // Validate against known steps
  const match = TEXT_SCALE_STEPS.find(s => s.value === parsed);
  return match ? match.value : DEFAULT_SCALE;
}

function getCurrentIndex(scale: number): number {
  const idx = TEXT_SCALE_STEPS.findIndex(s => s.value === scale);
  return idx >= 0
    ? idx
    : TEXT_SCALE_STEPS.findIndex(s => s.value === DEFAULT_SCALE);
}

export function useTextScale(): {
  scale: number;
  scaleLabel: string;
  setScale: (value: number) => void;
  incrementScale: () => void;
  decrementScale: () => void;
  canIncrement: boolean;
  canDecrement: boolean;
} {
  const [scale, setScaleState] = useState(getStoredScale);

  const setScale = useCallback((value: number) => {
    setScaleState(value);
    localStorage.setItem(STORAGE_KEY, String(value));
  }, []);

  const idx = getCurrentIndex(scale);
  const scaleLabel =
    TEXT_SCALE_STEPS[idx]?.label ?? `${Math.round(scale * 100)}%`;

  const canIncrement = idx < TEXT_SCALE_STEPS.length - 1;
  const canDecrement = idx > 0;

  const incrementScale = useCallback(() => {
    const i = getCurrentIndex(scale);
    if (i < TEXT_SCALE_STEPS.length - 1) {
      const next = TEXT_SCALE_STEPS[i + 1].value;
      setScaleState(next);
      localStorage.setItem(STORAGE_KEY, String(next));
    }
  }, [scale]);

  const decrementScale = useCallback(() => {
    const i = getCurrentIndex(scale);
    if (i > 0) {
      const prev = TEXT_SCALE_STEPS[i - 1].value;
      setScaleState(prev);
      localStorage.setItem(STORAGE_KEY, String(prev));
    }
  }, [scale]);

  return {
    scale,
    scaleLabel,
    setScale,
    incrementScale,
    decrementScale,
    canIncrement,
    canDecrement,
  };
}
