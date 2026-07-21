"use client";

import { useEffect } from "react";

/**
 * Runs `fn` on mount and again whenever `fn` itself changes identity — the
 * "fetch/sync on mount" effect pattern, factored into a hook so the callback
 * is an opaque parameter rather than a same-scope closure. Pass a
 * `useCallback`-memoized loader; its own dependency array controls when this
 * re-fires, exactly like `useEffect(() => { load(); }, [load])` did before,
 * just without hand-rolling that effect at every call site.
 *
 * `fn` may be sync or async, and may optionally return a cleanup function
 * (only meaningful for the sync case), forwarded as the effect's own cleanup
 * — for effects that set up a subscription/listener rather than just firing
 * a one-shot async load.
 */
export function useOnMount(fn: () => void | (() => void) | Promise<void>) {
  useEffect(() => {
    const result = fn();
    return typeof result === "function" ? result : undefined;
  }, [fn]);
}
