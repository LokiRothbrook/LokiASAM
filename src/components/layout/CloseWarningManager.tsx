"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { getServers } from "@/lib/db";
import { tauriCmd } from "@/lib/tauri-commands";

export function CloseWarningManager() {
  const [showWarning, setShowWarning] = useState(false);
  const [installingCount, setInstallingCount] = useState(0);
  const installingIds = useRef<string[]>([]);
  const allowClose = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    let unlisten: (() => void) | undefined;

    import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      getCurrentWindow()
        .onCloseRequested(async (event) => {
          if (allowClose.current) return;

          const servers = await getServers().catch(() => []);
          const active = servers.filter(
            (s) => s.status === "installing" || s.status === "updating"
          );

          if (active.length > 0) {
            event.preventDefault();
            installingIds.current = active.map((s) => s.id);
            setInstallingCount(active.length);
            setShowWarning(true);
          }
        })
        .then((fn) => {
          unlisten = fn;
        });
    });

    return () => {
      unlisten?.();
    };
  }, []);

  const handleCancelAndExit = async () => {
    for (const id of installingIds.current) {
      await tauriCmd.abortOperation(`server_${id}`).catch(() => {});
    }
    setShowWarning(false);
    allowClose.current = true;
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().close();
  };

  const handleKeepRunning = () => {
    setShowWarning(false);
  };

  return (
    <Dialog open={showWarning} onOpenChange={(open) => { if (!open) setShowWarning(false); }}>
      <DialogContent showCloseButton={false} className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Install in Progress</DialogTitle>
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
