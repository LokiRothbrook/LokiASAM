"use client";

import { useState, useEffect, useCallback } from "react";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";

export function useAutostart() {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    isEnabled()
      .then(setEnabled)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const toggle = useCallback(async (value: boolean) => {
    try {
      if (value) {
        await enable();
      } else {
        await disable();
      }
      setEnabled(value);
    } catch (e) {
      console.error("[autostart] toggle failed:", e);
    }
  }, []);

  return { enabled, loading, toggle };
}
