"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { getServers, getAppSetting } from "@/lib/db";
import { tauriCmd } from "@/lib/tauri-commands";

export function CloseWarningManager() {
  const [showWarning, setShowWarning] = useState(false);
  const [installingCount, setInstallingCount] = useState(0);
  const installingIds = useRef<string[]>([]);
  const allowClose = useRef(false);

  const checkActiveInstalls = async (): Promise<{ count: number; ids: string[] }> => {
    const servers = await getServers().catch(() => []);
    const active = servers.filter(
      (s) => s.status === "installing" || s.status === "updating"
    );
    return { count: active.length, ids: active.map((s) => s.id) };
  };

  useEffect(() => {
    if (typeof window === "undefined") return;

    let unlistenClose: (() => void) | undefined;
    let unlistenTrayQuit: (() => void) | undefined;

    import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      getCurrentWindow()
        .onCloseRequested(async (event) => {
          // Always prevent the auto-destroy() that the onCloseRequested wrapper
          // would fire if we don't call preventDefault(). The Rust on_window_event
          // handler manages hide-to-tray via api.prevent_close(); destroy() would
          // bypass that and kill the window even when it's supposed to hide.
          event.preventDefault();

          if (allowClose.current) return;

          const [closeToTray, setupDone] = await Promise.all([
            getAppSetting("close_to_tray").catch(() => null),
            getAppSetting("setup_complete").catch(() => null),
          ]);

          // If close-to-tray is active, the Rust handler already hid the window.
          // Nothing more to do here — silently swallow the close event.
          if (closeToTray !== "false" && setupDone === "true") return;

          // close_to_tray is off (or setup not done): check for active installs.
          const { count, ids } = await checkActiveInstalls();
          if (count > 0) {
            installingIds.current = ids;
            setInstallingCount(count);
            setShowWarning(true);
            return;
          }

          // No active installs, close_to_tray is off → exit the app.
          await tauriCmd.forceQuit();
        })
        .then((fn) => { unlistenClose = fn; });
    });

    import("@tauri-apps/api/event").then(({ listen }) => {
      listen<unknown>("tray-quit-requested", async () => {
        const { count, ids } = await checkActiveInstalls();
        if (count > 0) {
          installingIds.current = ids;
          setInstallingCount(count);
          setShowWarning(true);
        } else {
          // No active installs — exit immediately
          await tauriCmd.forceQuit();
        }
      }).then((fn) => { unlistenTrayQuit = fn; });
    });

    return () => {
      unlistenClose?.();
      unlistenTrayQuit?.();
    };
  }, []);

  const handleCancelAndExit = async () => {
    for (const id of installingIds.current) {
      await tauriCmd.abortOperation(`server_${id}`).catch(() => {});
    }
    setShowWarning(false);
    allowClose.current = true;
    await tauriCmd.forceQuit();
  };

  const handleKeepRunning = () => {
    setShowWarning(false);
  };

  return (
    <Dialog open={showWarning} onOpenChange={(open) => { if (!open) setShowWarning(false); }}>
      <DialogContent showCloseButton={false} className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Install in Progress</DialogTitle>
          <DialogDescription className="sr-only">
            A server installation is running. Choose to cancel it and exit, or keep the app running.
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          {installingCount === 1
            ? "A server install is currently running in the background."
            : `${installingCount} server installs are currently running in the background.`}{" "}
          Closing the app will cancel {installingCount === 1 ? "it" : "them"}.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={handleKeepRunning}>
            Keep Running
          </Button>
          <Button
            onClick={handleCancelAndExit}
            style={{
              background: "rgba(255,0,85,0.15)",
              border: "1px solid rgba(255,0,85,0.4)",
              color: "var(--neon-red)",
            }}
          >
            Cancel Install &amp; Exit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
