"use client";

import { useRef } from "react";
import { toast } from "sonner";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { useAppStore } from "@/store/useAppStore";
import { addServerMod } from "@/lib/db";
import { tauriCmd } from "@/lib/tauri-commands";

/**
 * Invisible component mounted in the root layout.
 *
 * Handles global Tauri events for the mod browser and mod verification so
 * they remain active regardless of which tab or page the user is on:
 *
 *   mod://add-to-server    — writes the mod to SQLite, increments modAddedCount.
 *                            If source === 'verify', also increments verifyProgress.
 *   mod://browser-closed   — updates modBrowserOpen / modBrowserJustClosed.
 *   mod://verify-fail      — accumulates the failure, increments verifyProgress.
 *   mod://verify-skip      — accumulates the skip, increments verifyProgress.
 *   mod://verify-complete  — shows result toasts, closes verify window, stops verifying.
 */
export function ModBrowserEventHandler() {
  const modBrowserParams         = useAppStore((s) => s.modBrowserParams);
  const setModBrowserOpen        = useAppStore((s) => s.setModBrowserOpen);
  const setModBrowserParams      = useAppStore((s) => s.setModBrowserParams);
  const setModBrowserJustClosed  = useAppStore((s) => s.setModBrowserJustClosed);
  const incrementModAddedCount   = useAppStore((s) => s.incrementModAddedCount);
  const incrementVerifyProgress  = useAppStore((s) => s.incrementVerifyProgress);
  const stopVerifying            = useAppStore((s) => s.stopVerifying);

  // Accumulate verify results across sequential page navigations.
  const verifyFailsRef = useRef<{ modId: string; error: string }[]>([]);
  const verifySkipsRef = useRef<string[]>([]);

  useTauriEvent<unknown>("mod://add-to-server", async (raw) => {
    try {
      const data = (typeof raw === "string" ? JSON.parse(raw) : raw) as {
        serverId: string;
        modId: string;
        modName: string;
        source?: string;
      };

      // For browser-sourced adds, only save if it matches the open browser session.
      if (data.source !== "verify" && modBrowserParams) {
        if (data.serverId !== modBrowserParams.serverId) return;
      }

      await addServerMod(
        data.serverId,
        data.modId.trim(),
        data.modName.trim() || "Unknown Mod",
      );
      incrementModAddedCount();

      if (data.source === "verify") {
        incrementVerifyProgress();
      }
    } catch (e) {
      toast.error("Failed to add mod to server", { description: String(e) });
    }
  });

  useTauriEvent<unknown>("mod://browser-closed", () => {
    setModBrowserOpen(false);
    setModBrowserJustClosed(true);
    setModBrowserParams(null);
  });

  useTauriEvent<unknown>("mod://verify-fail", (raw) => {
    try {
      const data = (typeof raw === "string" ? JSON.parse(raw) : raw) as {
        modId: string;
        error: string;
      };
      verifyFailsRef.current.push({ modId: data.modId, error: data.error });
      incrementVerifyProgress();
    } catch (e) {
      toast.error("Mod verification error", { description: String(e) });
    }
  });

  useTauriEvent<unknown>("mod://verify-skip", (raw) => {
    try {
      const data = (typeof raw === "string" ? JSON.parse(raw) : raw) as {
        modId: string;
      };
      verifySkipsRef.current.push(data.modId);
      incrementVerifyProgress();
    } catch (e) {
      toast.error("Mod verification error", { description: String(e) });
    }
  });

  useTauriEvent<unknown>("mod://verify-complete", async () => {
    const fails = verifyFailsRef.current;
    const skips = verifySkipsRef.current;

    // Reset for the next verification batch.
    verifyFailsRef.current = [];
    verifySkipsRef.current = [];

    if (fails.length > 0) {
      toast.error(
        `${fails.length} mod${fails.length > 1 ? "s" : ""} could not be verified`,
        {
          description: fails.map((f) => `${f.modId} — ${f.error}`).join("\n"),
          duration: 8000,
        },
      );
    }

    if (skips.length > 0) {
      toast.info(
        `${skips.length} mod${skips.length > 1 ? "s were" : " was"} already installed`,
        {
          description: skips.join(", "),
          duration: 5000,
        },
      );
    }

    try { await tauriCmd.closeModVerify(); } catch { /* window may already be gone */ }
    stopVerifying();
  });

  return null;
}
