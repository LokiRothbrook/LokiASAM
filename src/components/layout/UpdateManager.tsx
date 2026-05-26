"use client";

import { useEffect, useRef } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { toast } from "sonner";
import { getAppSetting } from "@/lib/db";

const ONE_HOUR_MS = 60 * 60 * 1000;

export function UpdateManager() {
  const checkingRef = useRef(false);

  async function checkForUpdate() {
    if (checkingRef.current) return;
    checkingRef.current = true;
    try {
      const update = await check();
      if (!update) return;

      const toastId = `app-update-${update.version}`;
      toast.info(`LokiASAM ${update.version} is available`, {
        id: toastId,
        description: update.body ?? "A new version is ready to install.",
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
  }

  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | null = null;

    (async () => {
      const mode = await getAppSetting("app_update_check_mode");
      // Default to 'startup' if the key has never been set
      if (mode === "off") return;

      checkForUpdate();

      if (mode === "periodic") {
        intervalId = setInterval(checkForUpdate, ONE_HOUR_MS);
      }
    })();

    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
