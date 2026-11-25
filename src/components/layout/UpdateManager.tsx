"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { check } from "@tauri-apps/plugin-updater";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { notify, type NotifyOptions } from "@/lib/notify";
import { getAppSetting } from "@/lib/db";
import { tauriCmd } from "@/lib/tauri-commands";
import { dispatchNotification } from "@/lib/notifications";
import { NOTIFICATION_EVENTS } from "@/data/game-data";

const ONE_HOUR_MS = 60 * 60 * 1000;
/** The same failure repeating (e.g. hourly while offline) re-notifies at most this often. */
const REPEAT_FAILURE_MS = 6 * ONE_HOUR_MS;

/** Turn the updater's raw errors into something actionable. */
function describeCheckError(what: "LokiASAM" | "Proton-GE", err: unknown): string {
  const raw = String(err);
  if (/valid release JSON|latest\.json|404/i.test(raw)) {
    return `Couldn't read the ${what} update info from GitHub. This usually means a new release is still being published — it clears up on its own within the hour. (${raw})`;
  }
  if (/network|dns|timed out|timeout|connect|offline/i.test(raw)) {
    return `Couldn't reach GitHub to check for ${what} updates — check your internet connection. (${raw})`;
  }
  return `The ${what} update check failed: ${raw}`;
}

/** Window event fired by Settings when an update-check mode changes. */
export const UPDATE_CHECK_SETTINGS_EVENT = "lokiasam:update-check-settings-changed";

export function UpdateManager() {
  const router           = useRouter();
  const checkingRef      = useRef(false);
  const protonCheckRef   = useRef(false);
  // Last failure per check, so a repeating error doesn't notify every hour.
  const lastFailureRef   = useRef<Record<string, { msg: string; at: number }>>({});
  // Versions already announced this session. The hourly re-check reminds with
  // a toast again, but only the first announcement is logged.
  const announcedRef     = useRef<Set<string>>(new Set());
  const announce = useCallback((title: string, opts: NotifyOptions & { id: string }) => {
    if (announcedRef.current.has(opts.id)) {
      const { description, ...rest } = opts;
      delete rest.server;
      delete rest.event;
      toast.info(title, { ...rest, description: description === undefined ? undefined : String(description) });
      return;
    }
    announcedRef.current.add(opts.id);
    notify.info(title, { event: "update_available", ...opts });
  }, []);

  const reportCheckFailure = useCallback((what: "LokiASAM" | "Proton-GE", err: unknown) => {
    const body = describeCheckError(what, err);
    const prev = lastFailureRef.current[what];
    if (prev && prev.msg === body && Date.now() - prev.at < REPEAT_FAILURE_MS) return;
    lastFailureRef.current[what] = { msg: body, at: Date.now() };
    dispatchNotification({
      eventType: NOTIFICATION_EVENTS.UPDATE_CHECK_FAILED,
      serverId: null,
      serverName: what,
      title: `${what} update check failed`,
      body,
      severity: "warning",
    });
  }, []);
  const isLinux = typeof navigator !== "undefined" && !navigator.userAgent.includes("Windows");

  const checkForProtonUpdate = useCallback(async () => {
    if (protonCheckRef.current) return;
    protonCheckRef.current = true;
    try {
      const protonPath = await getAppSetting("proton_path");
      if (!protonPath) return;
      const info = await tauriCmd.checkProtonGeUpdate(protonPath);
      delete lastFailureRef.current["Proton-GE"]; // check worked — a future failure notifies again
      if (!info.updateAvailable) return;
      const toastId = `proton-update-${info.latestVersion}`;
      announce(`Proton-GE ${info.latestVersion} is available`, {
        id: toastId,
        description: `Current: ${info.currentVersion || "unknown"}.`,
        duration: Infinity,
        action: {
          label: "Update",
          onClick: () => {
            toast.dismiss(toastId);
            router.push("/settings?tab=updates&autoUpdateProton=1");
          },
        },
        actionButtonStyle: {
          background: "rgba(var(--neon-purple-rgb),0.15)",
          border: "1px solid rgba(var(--neon-purple-rgb),0.4)",
          color: "var(--neon-purple)",
        },
        cancelButtonStyle: {
          background: "transparent",
          border: "1px solid rgba(var(--neon-purple-rgb),0.2)",
          color: "var(--text-muted)",
        },
        cancel: { label: "Dismiss", onClick: () => {} },
      });
    } catch (e) {
      // Background check — surfaced as a (deduplicated) notification, so a
      // persistent failure is visible in the bell instead of silently hiding.
      reportCheckFailure("Proton-GE", e);
    } finally {
      protonCheckRef.current = false;
    }
  }, [router, reportCheckFailure, announce]);

  const checkForUpdate = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    try {
      const installMethod = await invoke<string>("get_install_method").catch(() => "binary");
      const update = await check();
      delete lastFailureRef.current["LokiASAM"]; // check worked — a future failure notifies again
      if (!update) return;

      const toastId = `app-update-${update.version}`;
      const firstLine = (update.body ?? "").split("\n").find((l) => l.trim()) ?? "";
      const description = firstLine.length > 120
        ? firstLine.slice(0, 120) + "…"
        : firstLine || "A new version is ready to install.";

      if (installMethod === "pkgbuild") {
        // pkgbuild installs are not managed by the Tauri updater — pacman owns the binary.
        // Show the version notice but direct the user to rebuild manually.
        announce(`LokiASAM ${update.version} is available`, {
          id: toastId,
          description: "To update: git pull in your LokiASAM folder, then re-run makepkg -si",
          duration: Infinity,
          cancel: { label: "Dismiss", onClick: () => {} },
        });
        return;
      }

      announce(`LokiASAM ${update.version} is available`, {
        id: toastId,
        description,
        duration: Infinity,
        action: {
          label: "Download & Install",
          onClick: async () => {
            toast.dismiss(toastId);
            const loadingId = toast.loading("Downloading update…");
            try {
              await update.downloadAndInstall();
              toast.dismiss(loadingId);
              notify.success("Update installed. Restart LokiASAM to apply it.", {
                duration: Infinity,
              });
            } catch (e) {
              toast.dismiss(loadingId);
              notify.error("LokiASAM update failed", { description: e, event: "update_failed" });
            }
          },
        },
        cancel: {
          label: "Later",
          onClick: () => {},
        },
      });
    } catch (e) {
      reportCheckFailure("LokiASAM", e);
    } finally {
      checkingRef.current = false;
    }
  }, [reportCheckFailure, announce]);

  // Bumped when the user changes a check mode in Settings, so the intervals
  // below are rebuilt immediately instead of only on the next app launch.
  const [settingsVersion, setSettingsVersion] = useState(0);
  const startupCheckedRef = useRef(false);
  useEffect(() => {
    const bump = () => setSettingsVersion((v) => v + 1);
    window.addEventListener(UPDATE_CHECK_SETTINGS_EVENT, bump);
    return () => window.removeEventListener(UPDATE_CHECK_SETTINGS_EVENT, bump);
  }, []);

  useEffect(() => {
    let appIntervalId:    ReturnType<typeof setInterval> | null = null;
    let protonIntervalId: ReturnType<typeof setInterval> | null = null;
    // Check right away only on launch — a settings change just reschedules.
    const checkNow = !startupCheckedRef.current;
    startupCheckedRef.current = true;

    (async () => {
      const [mode, protonMode] = await Promise.all([
        getAppSetting("app_update_check_mode"),
        isLinux ? getAppSetting("proton_ge_check_mode") : Promise.resolve(null),
      ]);

      // LokiASAM app updates
      if (mode !== "off") {
        if (checkNow) checkForUpdate();
        if (mode === "periodic") {
          appIntervalId = setInterval(checkForUpdate, ONE_HOUR_MS);
        }
      }

      // Proton-GE updates (Linux only)
      if (isLinux && protonMode && protonMode !== "disabled") {
        if (checkNow) checkForProtonUpdate();
        if (protonMode === "startup_hourly") {
          protonIntervalId = setInterval(checkForProtonUpdate, ONE_HOUR_MS);
        }
      }
    })();

    return () => {
      if (appIntervalId)    clearInterval(appIntervalId);
      if (protonIntervalId) clearInterval(protonIntervalId);
    };
  }, [isLinux, checkForUpdate, checkForProtonUpdate, settingsVersion]);

  return null;
}
