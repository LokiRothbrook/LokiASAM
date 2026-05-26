"use client";

/**
 * SetupGuard — checks whether the first-time setup has been completed.
 *
 * On mount it queries SQLite for `setup_complete`.
 * - While checking: shows a full-screen loading state
 * - If incomplete: renders the SetupWizard overlay above the app
 * - If complete: renders children normally
 *
 * Only active inside the Tauri app. In a browser / Next.js dev mode it
 * passes children through immediately to avoid blocking development.
 */

import { useEffect, useState, useCallback } from "react";
import { SetupWizard } from "@/components/wizard/SetupWizard";
import { LokiIcon } from "@/components/shared/LokiIcon";
import { ServerCreationWizard } from "@/components/wizard/ServerCreationWizard";
import { useAppStore } from "@/store/useAppStore";
import { getAppSetting, setAppSetting, initDb } from "@/lib/db";
import { tauriCmd } from "@/lib/tauri-commands";
import { useTauriEvent } from "@/hooks/useTauriEvent";

interface SetupGuardProps {
  children: React.ReactNode;
}

export function SetupGuard({ children }: SetupGuardProps) {
  const { setupChecked, setupComplete, setSetupChecked, setSetupComplete, showNewServerWizard, setShowNewServerWizard } = useAppStore();
  const [isTauri, setIsTauri] = useState(false);

  useEffect(() => {
    const inTauri =
      typeof window !== "undefined" &&
      !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    setIsTauri(inTauri);

    if (!inTauri) {
      // Not running in Tauri — skip setup check (dev mode / browser)
      setSetupChecked(true);
      setSetupComplete(true);
      return;
    }

    (async () => {
      try {
        const bootstrap = await tauriCmd.readBootstrap();
        if (!bootstrap) {
          // No bootstrap file → first-ever run, show the setup wizard.
          // DB will be initialised by the wizard once base_dir is known.
          setSetupComplete(false);
          setSetupChecked(true);
          return;
        }

        // Bootstrap exists → derive DB path and open it.
        const sep = bootstrap.baseDir.includes("\\") ? "\\" : "/";
        const dbPath = bootstrap.baseDir.replace(/[/\\]$/, "") +
          sep + "lokiasam" + sep + "lokiasam.db";
        await initDb(dbPath);

        const value = await getAppSetting("setup_complete");
        const complete = value === "true";
        setSetupComplete(complete);
        setSetupChecked(true);
        if (complete) tauriCmd.setSetupComplete(true).catch(() => {});
      } catch {
        // Any error → treat as not setup so the wizard can recover.
        setSetupComplete(false);
        setSetupChecked(true);
      }
    })();
  }, [setSetupChecked, setSetupComplete]);

  const handleSetupComplete = () => {
    setSetupComplete(true);
    tauriCmd.setSetupComplete(true).catch(() => {});
  };

  // First-time tray-hide hint: show an OS notification once so the user knows
  // the app is still running in the background.
  const handleTrayFirstHide = useCallback(async (_payload: unknown) => {
    try {
      const already = await getAppSetting("tray_hint_shown");
      if (already === "true") return;
      await tauriCmd.sendOsNotification(
        "LokiASAM is still running",
        "The app is minimised to the system tray. Click the tray icon to bring it back."
      );
      await setAppSetting("tray_hint_shown", "true");
    } catch {
      // Non-critical — silently ignore
    }
  }, []);

  useTauriEvent("tray-first-hide", handleTrayFirstHide);

  // Still checking
  if (!setupChecked) {
    return (
      <div
        className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4"
        style={{ background: "var(--background)" }}
      >
        <LokiIcon
          size={52}
          className="animate-pulse"
          style={{ filter: "drop-shadow(0 0 8px var(--neon-purple))" }}
        />
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>Loading…</p>
      </div>
    );
  }

  return (
    <>
      {children}
      {/* First-time setup wizard overlay */}
      {isTauri && !setupComplete && (
        <SetupWizard onComplete={handleSetupComplete} />
      )}
      {/* New server creation wizard overlay */}
      {showNewServerWizard && (
        <ServerCreationWizard onClose={() => setShowNewServerWizard(false)} />
      )}
    </>
  );
}
