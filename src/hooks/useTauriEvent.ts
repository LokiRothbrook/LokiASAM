"use client";

/**
 * useTauriEvent — typed hook for subscribing to Tauri backend events.
 *
 * Usage:
 *   useTauriEvent<SteamCmdLine>("steamcmd://output/setup", (payload) => {
 *     setLines(prev => [...prev, payload]);
 *   });
 *
 * The unlisten function is called automatically on unmount.
 * Safe to call outside of Tauri (no-ops when __TAURI_INTERNALS__ is absent).
 */

import { useEffect, useRef } from "react";

type UnlistenFn = () => void;

export function useTauriEvent<T = unknown>(
  event: string,
  handler: (payload: T) => void
): void {
  // Stable ref for handler so effect deps don't change on every render
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      !(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    ) {
      return;
    }

    let unlisten: UnlistenFn | undefined;
    let cancelled = false;

    import("@tauri-apps/api/event").then(({ listen }) => {
      if (cancelled) return;
      listen<T>(event, (e) => handlerRef.current(e.payload)).then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      });
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [event]);
}
