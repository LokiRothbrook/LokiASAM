"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAppStore } from "@/store/useAppStore";
import { getServers, updateServerStatus } from "@/lib/db";
import { tauriCmd } from "@/lib/tauri-commands";

export function StartupReconciliationManager() {
  const queryClient = useQueryClient();
  const { setIsServerScanPending, setPreScanStatuses } = useAppStore();

  useEffect(() => {
    (async () => {
      // Always capture pre-scan statuses and mark the scan complete, even on error.
      // StartupRecoveryManager waits for preScanStatuses to be set before it runs.
      let servers: Awaited<ReturnType<typeof getServers>> = [];
      try {
        servers = await getServers();
      } catch {
        // DB unavailable — proceed with empty snapshot
      }

      setPreScanStatuses(Object.fromEntries(servers.map((s) => [s.id, s.status])));
      setIsServerScanPending(true);

      try {
        if (!servers.length) return;

        const entries = servers.map((s) => ({ serverId: s.id, installPath: s.install_path }));

        let results: Array<{ serverId: string; pid: number | null }>;
        try {
          results = await tauriCmd.scanRunningServers(entries);
        } catch {
          return;
        }

        // States that StartupRecoveryManager handles after the scan — skip them here
        // so they aren't wiped by the reconciliation.
        const QUEUE_STATES = new Set(["startup_queued", "update_queued"]);

        await Promise.all(
          results.map(async (r) => {
            const current = servers.find((s) => s.id === r.serverId);
            if (!current) return;

            if (r.pid != null) {
              if (current.status !== "running" || current.pid !== r.pid) {
                await updateServerStatus(r.serverId, "running", r.pid);
              }
            } else {
              if (current.status !== "stopped" && !QUEUE_STATES.has(current.status)) {
                await updateServerStatus(r.serverId, "stopped", null);
              }
            }
          })
        );

        queryClient.invalidateQueries({ queryKey: ["servers"] });
      } catch {
        // Non-fatal.
      } finally {
        setIsServerScanPending(false);
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}
