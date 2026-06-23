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
import { TriangleAlert } from "lucide-react";
import { getServers, getAppSetting } from "@/lib/db";
import { tauriCmd } from "@/lib/tauri-commands";

const TOOL_OP_LABELS: Record<string, string> = {
  check:            "ASA Server Cache install",
  steamcmd_install: "SteamCMD install",
  proton_download:  "Proton-GE install",
};

function toolOpLabel(key: string): string {
  return TOOL_OP_LABELS[key] ?? key;
}

export function CloseWarningManager() {
  const [showWarning, setShowWarning]     = useState(false);
  const [installingCount, setInstallingCount] = useState(0);
  const [toolOps, setToolOps]             = useState<string[]>([]);
  const [aborting, setAborting]           = useState(false);
  const installingIds  = useRef<string[]>([]);
  const allowClose     = useRef(false);

  const checkActiveInstalls = async (): Promise<{ count: number; ids: string[] }> => {
    const servers = await getServers().catch(() => []);
    const active = servers.filter(
      (s) => s.status === "installing" || s.status === "updating"
    );
    return { count: active.length, ids: active.map((s) => s.id) };
  };

  const checkAndWarn = async (): Promise<boolean> => {
    const [{ count, ids }, runningOps] = await Promise.all([
      checkActiveInstalls(),
      tauriCmd.getRunningOps().catch(() => [] as string[]),
    ]);

    const ops = runningOps.filter((k) => !k.startsWith("server_"));

    if (count > 0 || ops.length > 0) {
      installingIds.current = ids;
      setInstallingCount(count);
      setToolOps(ops);
      setAborting(false);
      setShowWarning(true);
      return true;
    }
    return false;
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
          // Background tool operations can safely keep running — nothing to warn about.
          if (closeToTray !== "false" && setupDone === "true") return;

          // close_to_tray is off → app will actually exit. Warn if anything is running.
          const warned = await checkAndWarn();
          if (!warned) {
            await tauriCmd.forceQuit();
          }
        })
        .then((fn) => { unlistenClose = fn; });
    });

    import("@tauri-apps/api/event").then(({ listen }) => {
      listen<unknown>("tray-quit-requested", async () => {
        const warned = await checkAndWarn();
        if (!warned) {
          await tauriCmd.forceQuit();
        }
      }).then((fn) => { unlistenTrayQuit = fn; });
    });

    return () => {
      unlistenClose?.();
      unlistenTrayQuit?.();
    };
  }, []);

  const handleAbortAndClose = async () => {
    setAborting(true);
    await Promise.allSettled([
      ...installingIds.current.map((id) => tauriCmd.abortOperation(`server_${id}`)),
      ...toolOps.map((op) => tauriCmd.abortOperation(op)),
    ]);
    setShowWarning(false);
    allowClose.current = true;
    await tauriCmd.forceQuit();
  };

  const handleKeepRunning = () => {
    setShowWarning(false);
  };

  const hasServerInstalls = installingCount > 0;
  const hasToolOps        = toolOps.length > 0;

  return (
    <Dialog open={showWarning} onOpenChange={(open) => { if (!open && !aborting) setShowWarning(false); }}>
      <DialogContent
        showCloseButton={false}
        className="max-w-md"
        style={{ background: "var(--popover)", border: "1px solid rgba(255,136,0,0.35)" }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2" style={{ color: "var(--neon-orange)" }}>
            <TriangleAlert className="w-5 h-5" />
            Operation{hasServerInstalls && hasToolOps ? "s" : installingCount + toolOps.length > 1 ? "s" : ""} In Progress
          </DialogTitle>
          <DialogDescription className="space-y-3 pt-1">
            <span className="block">
              Closing the app will abort the following and may leave files in an incomplete state:
            </span>
            <ul className="list-disc list-inside space-y-1">
              {hasServerInstalls && (
                <li style={{ color: "var(--text-primary)" }}>
                  {installingCount === 1
                    ? "1 server install / update"
                    : `${installingCount} server installs / updates`}
                </li>
              )}
              {toolOps.map((op) => (
                <li key={op} style={{ color: "var(--text-primary)" }}>
                  {toolOpLabel(op)}
                </li>
              ))}
            </ul>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-col gap-2 sm:flex-col">
          <Button
            variant="outline"
            onClick={handleKeepRunning}
            disabled={aborting}
            className="w-full hover:bg-(--surface-elevated)"
            style={{ borderColor: "rgba(var(--neon-purple-rgb),0.3)", color: "var(--neon-purple)" }}
          >
            Keep Running
          </Button>
          <Button
            variant="outline"
            onClick={handleAbortAndClose}
            disabled={aborting}
            className="w-full gap-2 bg-[rgba(255,0,85,0.08)]! hover:bg-[rgba(255,0,85,0.2)]!"
            style={{ borderColor: "rgba(255,0,85,0.3)", color: "var(--neon-red)" }}
          >
            <TriangleAlert className="w-4 h-4" />
            {aborting ? "Aborting…" : "Abort & Close"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
