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

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Zap } from "lucide-react";
import { SetupWizard } from "@/components/wizard/SetupWizard";
import { useAppStore } from "@/store/useAppStore";
import { getAppSetting } from "@/lib/db";

interface SetupGuardProps {
  children: React.ReactNode;
}

export function SetupGuard({ children }: SetupGuardProps) {
  const router = useRouter();
  const { setupChecked, setupComplete, setSetupChecked, setSetupComplete } = useAppStore();
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

    getAppSetting("setup_complete")
      .then((value) => {
        const complete = value === "true";
        setSetupComplete(complete);
        setSetupChecked(true);
      })
      .catch(() => {
        // DB error — treat as not setup to allow recovery
        setSetupComplete(false);
        setSetupChecked(true);
      });
  }, [setSetupChecked, setSetupComplete]);

  const handleSetupComplete = () => {
    setSetupComplete(true);
    router.push("/servers/new");
  };

  // Still checking
  if (!setupChecked) {
    return (
      <div
        className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4"
        style={{ background: "var(--background)" }}
      >
        <Zap
          className="w-12 h-12 animate-pulse"
          style={{ color: "var(--neon-purple)", filter: "drop-shadow(0 0 8px var(--neon-purple))" }}
        />
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>Loading…</p>
      </div>
    );
  }

  return (
    <>
      {children}
      {/* Setup wizard overlay — sits above everything when setup is incomplete */}
      {isTauri && !setupComplete && (
        <SetupWizard onComplete={handleSetupComplete} />
      )}
    </>
  );
}
