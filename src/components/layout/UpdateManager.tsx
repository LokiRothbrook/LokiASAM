"use client";

import { useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { check } from "@tauri-apps/plugin-updater";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { getAppSetting } from "@/lib/db";
import { tauriCmd } from "@/lib/tauri-commands";

const ONE_HOUR_MS = 60 * 60 * 1000;

export function UpdateManager() {
  const router           = useRouter();
  const checkingRef      = useRef(false);
  const protonCheckRef   = useRef(false);
  const isLinux = typeof navigator !== "undefined" && !navigator.userAgent.includes("Windows");

  const checkForProtonUpdate = useCallback(async () => {
    if (protonCheckRef.current) return;
    protonCheckRef.current = true;
    try {
      const protonPath = await getAppSetting("proton_path");
      if (!protonPath) return;
      const info = await tauriCmd.checkProtonGeUpdate(protonPath);
      if (!info.updateAvailable) return;
      const toastId = `proton-update-${info.latestVersion}`;
      toast.info(`Proton-GE ${info.latestVersion} is available`, {
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
    } catch {
      // Silently ignore — background check should never surface errors
    } finally {
      protonCheckRef.current = false;
    }
  }, [router]);

  const checkForUpdate = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    try {
      const installMethod = await invoke<string>("get_install_method").catch(() => "binary");
      const update = await check();
      if (!update) return;

      const toastId = `app-update-${update.version}`;
      const firstLine = (update.body ?? "").split("\n").find((l) => l.trim()) ?? "";
      const description = firstLine.length > 120
        ? firstLine.slice(0, 120) + "…"
        : firstLine || "A new version is ready to install.";

      if (installMethod === "pkgbuild") {
        // pkgbuild installs are not managed by the Tauri updater — pacman owns the binary.
        // Show the version notice but direct the user to rebuild manually.
        toast.info(`LokiASAM ${update.version} is available`, {
          id: toastId,
          description: "To update: git pull in your LokiASAM folder, then re-run makepkg -si",
          duration: Infinity,
          cancel: { label: "Dismiss", onClick: () => {} },
        });
        return;
      }

      toast.info(`LokiASAM ${update.version} is available`, {
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
              toast.success("Update installed. Restart LokiASAM to apply it.", {
                duration: Infinity,
              });
            } catch (e) {
              toast.dismiss(loadingId);
              toast.error(`Update failed: ${e}`);
            }
          },
        },
        cancel: {
          label: "Later",
          onClick: () => {},
        },
      });
    } catch {
      // Silently ignore — background check should never surface errors to the user
    } finally {
      checkingRef.current = false;
    }
  }, []);

  useEffect(() => {
    let appIntervalId:    ReturnType<typeof setInterval> | null = null;
    let protonIntervalId: ReturnType<typeof setInterval> | null = null;

    (async () => {
      const [mode, protonMode] = await Promise.all([
        getAppSetting("app_update_check_mode"),
        isLinux ? getAppSetting("proton_ge_check_mode") : Promise.resolve(null),
      ]);

      // LokiASAM app updates
      if (mode !== "off") {
        checkForUpdate();
        if (mode === "periodic") {
          appIntervalId = setInterval(checkForUpdate, ONE_HOUR_MS);
        }
      }

      // Proton-GE updates (Linux only)
      if (isLinux && protonMode && protonMode !== "disabled") {
        checkForProtonUpdate();
        if (protonMode === "startup_hourly") {
          protonIntervalId = setInterval(checkForProtonUpdate, ONE_HOUR_MS);
        }
      }
    })();

    return () => {
      if (appIntervalId)    clearInterval(appIntervalId);
      if (protonIntervalId) clearInterval(protonIntervalId);
    };
  }, [isLinux, checkForUpdate, checkForProtonUpdate]);

  return null;
}
