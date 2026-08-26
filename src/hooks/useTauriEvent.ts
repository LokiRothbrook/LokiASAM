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

// Kick off the dynamic import at module-evaluation time so the Tauri event
// module is already in the browser's module cache before any useEffect fires.
// Without this, the first call to useTauriEvent involves two async hops
// (dynamic import + listen IPC), creating a window where events emitted
// immediately after startServer() can arrive before the listener is registered
// — causing status updates to be silently missed on app restart.
// The window guard ensures this never runs during Next.js static prerendering.
const _tauriEventApiPromise =
  typeof window !== "undefined"
    ? import("@tauri-apps/api/event")
    : null;

export function useTauriEvent<T = unknown>(
  event: string,
  handler: (payload: T) => void
): void {
  // Stable ref for handler so effect deps don't change on every render.
  // Synced in its own effect (runs after every render, no deps array) rather
  // than during render itself — writing to a ref during render is unsafe
  // under concurrent rendering / StrictMode double-invoke.
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    if (
      !event ||
      typeof window === "undefined" ||
      !(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    ) {
      return;
    }

    let unlisten: UnlistenFn | undefined;
    let cancelled = false;

    (_tauriEventApiPromise ?? import("@tauri-apps/api/event")).then(({ listen }) => {
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
