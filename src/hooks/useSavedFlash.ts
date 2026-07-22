"use client";

import { useEffect, useRef, useState, useCallback } from "react";

/**
 * "Saved" checkmark flash — becomes `true` for `durationMs` after calling
 * `trigger()`, then reverts to `false`. Clears its own timer on unmount so
 * it never fires a stray setState after the component using it is gone.
 */
export function useSavedFlash(durationMs = 2000) {
  const [saved, setSaved] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
  }, []);

  const trigger = useCallback(() => {
    setSaved(true);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setSaved(false), durationMs);
  }, [durationMs]);

  return [saved, trigger] as const;
}
