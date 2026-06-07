"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAppStore } from "@/store/useAppStore";
import { getServers, updateServerStatus } from "@/lib/db";
import { tauriCmd } from "@/lib/tauri-commands";

export function StartupReconciliationManager() {
  const queryClient = useQueryClient();
  const { setIsServerScanPending } = useAppStore();

  useEffect(() => {
    setIsServerScanPending(true);
    (async () => {
      try {
        const servers = await getServers();

        if (!servers.length) return;

        const entries = servers.map((s) => ({ serverId: s.id, installPath: s.install_path }));

        let results: Array<{ serverId: string; pid: number | null }>;
        try {
          results = await tauriCmd.scanRunningServers(entries);
        } catch {
          return;
        }

        await Promise.all(
          results.map(async (r) => {
            const current = servers.find((s) => s.id === r.serverId);
            if (!current) return;

            if (r.pid != null) {
              if (current.status !== "running" || current.pid !== r.pid) {
                await updateServerStatus(r.serverId, "running", r.pid);
              }
            } else {
              if (current.status !== "stopped") {
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
