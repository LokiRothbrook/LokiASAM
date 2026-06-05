"use client";

import { useEffect, useState, useCallback } from "react";
import { Plus, Server, Activity, PowerOff, Power, RefreshCw, Upload, ArrowUp, CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatCard } from "@/components/shared/StatCard";
import { ServerCard } from "@/components/server/ServerCard";
import { ImportServerWizard } from "@/components/server/ImportServerWizard";
import { useServers } from "@/hooks/useServers";
import { getServers, updateServerStatus, getAppSetting, setAppSetting } from "@/lib/db";
import { tauriCmd, type UpdateCheckResult } from "@/lib/tauri-commands";
import { runPerServerUpdateCheck } from "@/lib/update-utils";
import { dispatchNotification } from "@/lib/notifications";
import { NOTIFICATION_EVENTS } from "@/data/game-data";
import { useQueryClient } from "@tanstack/react-query";
import { useAppStore } from "@/store/useAppStore";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { toast } from "sonner";

// ---------------------------------------------------------------------------
// Update status chip
// ---------------------------------------------------------------------------

function UpdateStatusChip() {
  const [checking, setChecking]       = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [cachedBuild, setCachedBuild] = useState("");
  const [latestBuild, setLatestBuild] = useState("");
  const [lastChecked, setLastChecked] = useState("");

  const load = useCallback(async () => {
    const [avail, cached, latest, checked] = await Promise.all([
      getAppSetting("asa_update_available"),
      getAppSetting("asa_cached_build_id"),
      getAppSetting("asa_latest_build_id"),
      getAppSetting("asa_last_checked"),
    ]);
    setUpdateAvailable(avail === "true");
    setCachedBuild(cached ?? "");
    setLatestBuild(latest ?? "");
    setLastChecked(checked ?? "");
  }, []);

  useEffect(() => { load(); }, [load]);

  // Listen for background check results fired from the Rust scheduler.
  useTauriEvent<UpdateCheckResult | { updateApplied?: boolean }>("asa://update-check", async (payload) => {
    if ("updateApplied" in payload && payload.updateApplied) {
      await setAppSetting("asa_update_available", "false");
      await setAppSetting("asa_cached_build_id", latestBuild || cachedBuild);
      load();
      return;
    }
    if ("updateAvailable" in payload) {
      const r = payload as UpdateCheckResult;
      const now = new Date().toISOString();
      await setAppSetting("asa_update_available", String(r.updateAvailable));
      await setAppSetting("asa_cached_build_id", r.cachedBuildId);
      await setAppSetting("asa_latest_build_id", r.latestBuildId);
      await setAppSetting("asa_last_checked", now);
      load();
      // Always run per-server check — a server may be behind the cache even
      // if the cache itself is current (e.g. server was never updated).
      await runPerServerUpdateCheck();
    }
  });

  const handleCheck = async () => {
    setChecking(true);
    try {
      const [baseDir, steamcmdPath] = await Promise.all([
        getAppSetting("base_dir"),
        getAppSetting("steamcmd_path"),
      ]);
      if (!baseDir || !steamcmdPath) {
        toast.error("Base directory or SteamCMD not configured.");
        return;
      }
      const sep = baseDir.includes("\\") ? "\\" : "/";
      const cacheDir = `${baseDir.replace(/[/\\]$/, "")}${sep}lokiasam${sep}cache${sep}asa-server`;
      const oldBuild = await getAppSetting("asa_cached_build_id") ?? "";
      const newBuild = await tauriCmd.updateCache("check", cacheDir, steamcmdPath);
      const now = new Date().toISOString();
      const cacheUpdated = !!newBuild && newBuild !== oldBuild;
      await Promise.all([
        setAppSetting("asa_cached_build_id", newBuild),
        setAppSetting("asa_latest_build_id", newBuild),
        setAppSetting("asa_last_checked",    now),
      ]);
      await runPerServerUpdateCheck();
      load();
      if (cacheUpdated) {
        await dispatchNotification({
          eventType:  NOTIFICATION_EVENTS.UPDATE_AVAILABLE,
          serverId:   null,
          serverName: "ASA Cache",
          title:      "Cache Updated",
          body:       `Cache updated to build ${newBuild}. Outdated servers have been flagged.`,
          severity:   "info",
        });
      } else {
        toast.success(`Cache is up to date (build ${newBuild}).`);
      }
    } catch (e) {
      await dispatchNotification({
        eventType:  NOTIFICATION_EVENTS.UPDATE_FAILED,
        serverId:   null,
        serverName: "ASA Cache",
        title:      "Cache Update Failed",
        body:       `Failed to update cache: ${e}`,
        severity:   "error",
      });
    } finally {
      setChecking(false);
    }
  };

  const busy = checking;
  const neverChecked = !lastChecked;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {updateAvailable ? (
        <div
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium"
          style={{
            background: "rgba(255,165,0,0.1)",
            border: "1px solid rgba(255,165,0,0.4)",
            color: "#ffa500",
          }}
        >
          <ArrowUp className="w-3 h-3" />
          Update Available
          {cachedBuild && latestBuild && cachedBuild !== latestBuild && (
            <span className="opacity-70 ml-0.5">
              (build {latestBuild})
            </span>
          )}
        </div>
      ) : !neverChecked ? (
        <div
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs"
          style={{ background: "rgba(0,255,136,0.06)", border: "1px solid rgba(0,255,136,0.2)", color: "var(--neon-green)" }}
        >
          <CheckCircle2 className="w-3 h-3" />
          Up to date
        </div>
      ) : null}

      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={handleCheck}
        className="h-7 gap-1.5 text-xs"
        style={{ borderColor: "rgba(191,0,255,0.3)", color: "var(--text-muted)" }}
      >
        {checking
          ? <Loader2 className="w-3 h-3 animate-spin" />
          : <RefreshCw className="w-3 h-3" />}
        Check for Update
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Startup reconciliation
// ---------------------------------------------------------------------------

/**
 * On mount, scan OS processes for each configured server by install path.
 * The OS is the source of truth — stored status and PID are ignored.
 *   - process found  → "running" with the discovered PID; registered in crash monitor
 *   - process absent → "stopped" (covers crashed, never-started, and manually-stopped)
 *
 * This also handles servers started outside the app: if the user launched the
 * game process manually before opening the manager, it is detected and tracked.
 */
function useStartupReconciliation() {
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
          // Tauri not available (dev browser preview) — skip.
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
}

export default function DashboardPage() {
  useStartupReconciliation();

  const { data: servers = [], isLoading } = useServers();
  const { setShowNewServerWizard } = useAppStore();
  const [showImport, setShowImport] = useState(false);
  const queryClient = useQueryClient();

  const total   = servers.length;
  const running = servers.filter((s) => s.status === "running").length;
  const stopped = total - running;

  return (
    <div className="flex flex-col gap-6">
      {/* ── Page header ── */}
      <div className="flex items-start justify-between flex-wrap gap-3">
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
        <div className="flex items-center gap-2 flex-wrap">
          <UpdateStatusChip />
          <Button
            variant="outline"
            onClick={() => setShowImport(true)}
            className="gap-2"
            style={{ borderColor: "rgba(0,255,255,0.3)", color: "var(--neon-cyan)" }}
          >
            <Upload className="w-4 h-4" />
            Import Server
          </Button>
          <Button
            onClick={() => setShowNewServerWizard(true)}
            className="btn-neon-purple gap-2"
          >
            <Plus className="w-4 h-4" />
            New Server
          </Button>
        </div>
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
          <Button
            onClick={() => setShowNewServerWizard(true)}
            variant="outline"
            className="btn-neon-purple mt-2 gap-2"
          >
            <Plus className="w-4 h-4" />
            Create Server
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

      {/* ── Import existing server modal ── */}
      {showImport && (
        <ImportServerWizard
          onClose={() => setShowImport(false)}
          onImported={() => {
            setShowImport(false);
            queryClient.invalidateQueries({ queryKey: ["servers"] });
          }}
        />
      )}
    </div>
  );
}
