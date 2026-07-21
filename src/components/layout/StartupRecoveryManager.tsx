"use client";

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ToggleLeft, ToggleRight } from "lucide-react";
import { useAppStore } from "@/store/useAppStore";
import {
  getServers, getAppSetting, setAppSetting, updateServerStatus,
  type ServerRow,
} from "@/lib/db";
import { applyUpdateToServer } from "@/lib/update-utils";
import {
  Dialog, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export function StartupRecoveryManager() {
  const queryClient = useQueryClient();
  const isServerScanPending = useAppStore((s) => s.isServerScanPending);
  const preScanStatuses = useAppStore((s) => s.preScanStatuses);
  const { enqueueStartup } = useAppStore();

  const hasRunRef = useRef(false);
  const [downedServers, setDownedServers] = useState<ServerRow[]>([]);
  const [showDownedDialog, setShowDownedDialog] = useState(false);
  const [rememberChoice, setRememberChoice] = useState(false);

  useEffect(() => {
    // Wait until reconciliation finishes and pre-scan data is available
    if (isServerScanPending || hasRunRef.current || !preScanStatuses) return;
    hasRunRef.current = true;

    (async () => {
      const servers = await getServers();

      // --- 1. Re-queue startup_queued servers --------------------------------
      const startupQueued = servers.filter((s) => s.status === "startup_queued");
      if (startupQueued.length > 0) {
        enqueueStartup(startupQueued.map((s) => s.id));
      }

      // --- 2. Resume update_queued servers sequentially ----------------------
      const updateQueued = servers.filter((s) => s.status === "update_queued");
      if (updateQueued.length > 0) {
        const count = updateQueued.length;
        toast.info(
          count === 1
            ? `Resuming update for ${updateQueued[0].name}…`
            : `Resuming update queue for ${count} servers…`,
        );
        (async () => {
          for (const server of updateQueued) {
            try {
              await updateServerStatus(server.id, "updating", null);
              queryClient.invalidateQueries({ queryKey: ["servers"] });
              await applyUpdateToServer(
                server.id, server.name, server.install_path, false, false,
                server.rcon_port, server.admin_password,
                { warnPlayers: false, warnMinutes: 0, warnMessage: "" },
              );
            } catch {
              // applyUpdateToServer already dispatches a failure notification
            }
            await updateServerStatus(server.id, "stopped", null);
            queryClient.invalidateQueries({ queryKey: ["servers"] });
          }
        })();
      }

      // --- 3. Queue auto_start servers that are stopped ----------------------
      const autoStartStopped = servers.filter(
        (s) => s.auto_start === 1 && s.status === "stopped",
      );
      if (autoStartStopped.length > 0) {
        for (const s of autoStartStopped) {
          await updateServerStatus(s.id, "startup_queued", null);
        }
        enqueueStartup(autoStartStopped.map((s) => s.id));
        queryClient.invalidateQueries({ queryKey: ["servers"] });
      }

      // --- 4. Detect downed servers (were running/starting, now stopped, no auto_start) ---
      const RUNNING_STATES = new Set(["running", "starting"]);
      const downed = servers.filter(
        (s) =>
          RUNNING_STATES.has(preScanStatuses[s.id] ?? "") &&
          s.status === "stopped" &&
          s.auto_start === 0,
      );

      if (downed.length === 0) return;

      const pref = (await getAppSetting("auto_restart_downed")) ?? "ask";

      if (pref === "auto") {
        await enqueueDownedServers(downed, enqueueStartup, queryClient);
      } else if (pref === "ask") {
        setDownedServers(downed);
        setShowDownedDialog(true);
      }
      // pref === "never" → do nothing
    })();
  }, [isServerScanPending, preScanStatuses, enqueueStartup, queryClient]);

  const handleLeaveOffline = async () => {
    setShowDownedDialog(false);
    if (rememberChoice) await setAppSetting("auto_restart_downed", "never");
  };

  const handleRestartNow = async () => {
    setShowDownedDialog(false);
    if (rememberChoice) await setAppSetting("auto_restart_downed", "auto");
    await enqueueDownedServers(downedServers, enqueueStartup, queryClient);
  };

  return (
    <Dialog open={showDownedDialog} onOpenChange={setShowDownedDialog}>
      <DialogContent style={{ borderColor: "rgba(var(--neon-purple-rgb),0.25)", background: "var(--popover)" }}>
        <DialogHeader>
          <DialogTitle style={{ color: "var(--text-primary)" }}>Servers Went Offline</DialogTitle>
          <DialogDescription style={{ color: "var(--text-muted)" }}>
            The following server{downedServers.length > 1 ? "s were" : " was"} running in your last
            session but went offline while the app was closed.
          </DialogDescription>
        </DialogHeader>

        <ul className="space-y-1 my-2">
          {downedServers.map((s) => (
            <li
              key={s.id}
              className="text-sm px-3 py-1.5 rounded"
              style={{ background: "rgba(255,255,255,0.04)", color: "var(--text-primary)" }}
            >
              {s.name}
            </li>
          ))}
        </ul>

        <div className="flex items-center justify-between">
          <p className="text-sm" style={{ color: "var(--text-primary)" }}>Remember my choice</p>
          <button
            type="button"
            onClick={() => setRememberChoice((v) => !v)}
            className="shrink-0 flex items-center focus:outline-none"
            aria-label={rememberChoice ? "Disable remember choice" : "Enable remember choice"}
          >
            {rememberChoice
              ? <ToggleRight className="w-8 h-8" style={{ color: "var(--neon-purple)" }} />
              : <ToggleLeft className="w-8 h-8" style={{ color: "var(--text-subtle)" }} />}
          </button>
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleLeaveOffline}
            style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
          >
            Leave Offline
          </Button>
          <Button
            size="sm"
            onClick={handleRestartNow}
            style={{ background: "rgba(0,255,136,0.15)", border: "1px solid rgba(0,255,136,0.4)", color: "var(--neon-green)" }}
          >
            Restart Now
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

async function enqueueDownedServers(
  servers: ServerRow[],
  enqueueStartup: (ids: string[]) => void,
  queryClient: ReturnType<typeof useQueryClient>,
) {
  for (const s of servers) {
    await updateServerStatus(s.id, "startup_queued", null);
  }
  enqueueStartup(servers.map((s) => s.id));
  queryClient.invalidateQueries({ queryKey: ["servers"] });
}
