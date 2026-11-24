"use client";

/**
 * MemoryRestartManager — handles `server://memory-restart` from the Rust
 * stats loop (a running server exceeded its configured memory limit) by
 * restarting it through `restartServerGracefully`, the same path as the
 * Restart button, so the server's restart warning settings apply here too.
 */

import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { getServersCached, restartServerGracefully } from "@/lib/server-utils";
import { dispatchNotification } from "@/lib/notifications";
import { NOTIFICATION_EVENTS } from "@/data/game-data";

interface MemoryRestartPayload {
  serverId: string;
  memMb: number;
  limitMb: number;
}

export function MemoryRestartManager() {
  const queryClient = useQueryClient();

  useTauriEvent<MemoryRestartPayload>("server://memory-restart", async ({ serverId, memMb, limitMb }) => {
    const servers = await getServersCached(queryClient);
    const server = servers.find((s) => s.id === serverId);
    if (!server || server.status !== "running") return;

    dispatchNotification({
      eventType: NOTIFICATION_EVENTS.MEMORY_RESTART,
      serverId: server.id,
      serverName: server.name,
      title: `${server.name} restarting (memory limit)`,
      body: `Using ${(memMb / 1024).toFixed(1)} GB of RAM, over the ${(limitMb / 1024).toFixed(1)} GB limit.`,
      severity: "warning",
    });
    try {
      await restartServerGracefully(server, {
        onInvalidate: () => queryClient.invalidateQueries({ queryKey: ["servers"] }),
      });
    } catch (e) {
      toast.error(`Memory-limit restart of ${server.name} failed: ${e}`);
    }
  });

  return null;
}
