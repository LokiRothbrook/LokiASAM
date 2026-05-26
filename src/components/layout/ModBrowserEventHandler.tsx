"use client";

import { useTauriEvent } from "@/hooks/useTauriEvent";
import { useAppStore } from "@/store/useAppStore";
import { addServerMod } from "@/lib/db";

/**
 * Invisible component mounted in the root layout.
 *
 * Handles two global Tauri events for the mod browser so they remain active
 * regardless of which tab or page the user is currently viewing:
 *
 *   mod://add-to-server  — writes the mod to SQLite immediately and increments
 *                          modAddedCount so ModsTab refreshes in real time.
 *
 *   mod://browser-closed — updates modBrowserOpen / modBrowserJustClosed so
 *                          the Mods tab button and mod list stay in sync.
 */
export function ModBrowserEventHandler() {
  const modBrowserParams    = useAppStore((s) => s.modBrowserParams);
  const setModBrowserOpen   = useAppStore((s) => s.setModBrowserOpen);
  const setModBrowserParams = useAppStore((s) => s.setModBrowserParams);
  const setModBrowserJustClosed  = useAppStore((s) => s.setModBrowserJustClosed);
  const incrementModAddedCount   = useAppStore((s) => s.incrementModAddedCount);

  useTauriEvent<unknown>("mod://add-to-server", async (raw) => {
    if (!modBrowserParams) return;
    try {
      const data = (typeof raw === "string" ? JSON.parse(raw) : raw) as {
        serverId: string;
        modId: string;
        modName: string;
      };
      if (data.serverId !== modBrowserParams.serverId) return;
      await addServerMod(
        modBrowserParams.serverId,
        data.modId.trim(),
        data.modName.trim() || "Unknown Mod",
      );
      incrementModAddedCount();
    } catch (e) {
      console.error("mod://add-to-server error:", e);
    }
  });

  useTauriEvent<unknown>("mod://browser-closed", () => {
    setModBrowserOpen(false);
    setModBrowserJustClosed(true);
    setModBrowserParams(null);
  });

  return null;
}
