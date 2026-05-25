"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Plus, Server, Activity, PowerOff, Power } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatCard } from "@/components/shared/StatCard";
import { ServerCard } from "@/components/server/ServerCard";
import { useServers } from "@/hooks/useServers";
import { getRunningServers, updateServerStatus } from "@/lib/db";
import { tauriCmd } from "@/lib/tauri-commands";
import { useQueryClient } from "@tanstack/react-query";

/**
 * On mount, reconcile servers that were marked "running" in SQLite from a
 * previous app session by re-registering their PIDs with the Rust backend.
 * If a PID is no longer alive, the server is marked "crashed".
 */
function useStartupReconciliation() {
  const queryClient = useQueryClient();

  useEffect(() => {
    (async () => {
      try {
        const running = await getRunningServers();
        if (!running.length) return;

        await Promise.all(
          running.map(async (s) => {
            if (!s.pid) return;
            try {
              const alive = await tauriCmd.registerRunningServer(s.id, s.pid);
              if (!alive) {
                await updateServerStatus(s.id, "crashed", null);
              }
            } catch {
              // Tauri not available (dev browser preview) — skip.
            }
          })
        );

        queryClient.invalidateQueries({ queryKey: ["servers"] });
      } catch {
        // Non-fatal.
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}

export default function DashboardPage() {
  useStartupReconciliation();

  const { data: servers = [], isLoading } = useServers();

  const total   = servers.length;
  const running = servers.filter((s) => s.status === "running").length;
  const stopped = total - running;

  return (
    <div className="flex flex-col gap-6">
      {/* ── Page header ── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1
            className="text-2xl font-bold tracking-tight"
            style={{ color: "var(--neon-purple)", textShadow: "var(--glow-purple)" }}
          >
            Server Dashboard
          </h1>
          <p className="text-sm mt-0.5" style={{ color: "var(--text-muted)" }}>
            Manage your Ark Survival Ascended dedicated servers.
          </p>
        </div>
        <Button asChild className="btn-neon-cyan gap-2">
          <Link href="/servers/new">
            <Plus className="w-4 h-4" />
            New Server
          </Link>
        </Button>
      </div>

      {/* ── Global stats bar ── */}
      {total > 0 && (
        <div className="flex flex-wrap gap-3">
          <StatCard
            label="Total Servers"
            value={total}
            icon={Server}
            color="var(--neon-purple)"
          />
          <StatCard
            label="Running"
            value={running}
            icon={Power}
            color="var(--neon-green)"
            sub={running === total ? "all online" : undefined}
          />
          <StatCard
            label="Stopped"
            value={stopped}
            icon={PowerOff}
            color={stopped > 0 ? "var(--text-muted)" : "var(--neon-green)"}
          />
          {servers.some((s) => s.status === "crashed" || s.status === "error") && (
            <StatCard
              label="Needs Attention"
              value={servers.filter((s) => s.status === "crashed" || s.status === "error").length}
              icon={Activity}
              color="var(--neon-red)"
            />
          )}
        </div>
      )}

      {/* ── Loading skeletons ── */}
      {isLoading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="glass-card rounded-2xl p-5 flex flex-col gap-4">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-3 w-24" />
              <div className="grid grid-cols-2 gap-2">
                {[1, 2, 3, 4, 5, 6].map((j) => (
                  <Skeleton key={j} className="h-3 w-full" />
                ))}
              </div>
              <Skeleton className="h-8 w-full mt-1" />
            </div>
          ))}
        </div>
      )}

      {/* ── Empty state ── */}
      {!isLoading && total === 0 && (
        <div className="glass-card flex flex-col items-center justify-center gap-4 py-24 text-center rounded-2xl">
          <div
            className="flex items-center justify-center w-16 h-16 rounded-full"
            style={{
              background: "rgba(191,0,255,0.05)",
              border: "1px solid rgba(191,0,255,0.15)",
            }}
          >
            <Server className="w-8 h-8" style={{ color: "var(--neon-purple)" }} />
          </div>
          <div>
            <h2 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>
              No servers yet
            </h2>
            <p className="text-sm mt-1 max-w-sm" style={{ color: "var(--text-muted)" }}>
              Create your first Ark Survival Ascended server to get started.
            </p>
          </div>
          <Button asChild variant="outline" className="btn-neon-purple mt-2">
            <Link href="/servers/new">
              <Plus className="w-4 h-4 mr-2" />
              Create Server
            </Link>
          </Button>
        </div>
      )}

      {/* ── Server grid ── */}
      {!isLoading && total > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {servers.map((server) => (
            <ServerCard key={server.id} server={server} />
          ))}
        </div>
      )}
    </div>
  );
}
