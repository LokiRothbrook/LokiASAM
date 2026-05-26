"use client";

import { useEffect, useState, useCallback } from "react";
import { Plus, Server, Activity, PowerOff, Power, RefreshCw, Upload, ArrowUp, CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatCard } from "@/components/shared/StatCard";
import { ServerCard } from "@/components/server/ServerCard";
import { ImportServerWizard } from "@/components/server/ImportServerWizard";
import { useServers } from "@/hooks/useServers";
import { getRunningServers, updateServerStatus, getAppSetting, setAppSetting } from "@/lib/db";
import { tauriCmd, type UpdateCheckResult } from "@/lib/tauri-commands";
import { useQueryClient } from "@tanstack/react-query";
import { useAppStore } from "@/store/useAppStore";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { toast } from "sonner";

// ---------------------------------------------------------------------------
// Update status chip
// ---------------------------------------------------------------------------

function UpdateStatusChip() {
  const [checking, setChecking]       = useState(false);
  const [updating, setUpdating]       = useState(false);
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
    }
  });

  const handleCheck = async () => {
    setChecking(true);
    try {
      const cacheDir = await getAppSetting("base_dir");
      if (!cacheDir) { toast.error("Base directory not configured."); return; }
      const sep = cacheDir.includes("\\") ? "\\" : "/";
      const dir = `${cacheDir.replace(/[/\\]$/, "")}${sep}lokiasam${sep}cache${sep}asa-server`;
      const result = await tauriCmd.checkAsaUpdate(dir);
      const now = new Date().toISOString();
      await setAppSetting("asa_update_available", String(result.updateAvailable));
      await setAppSetting("asa_cached_build_id", result.cachedBuildId);
      await setAppSetting("asa_latest_build_id", result.latestBuildId);
      await setAppSetting("asa_last_checked", now);
      load();
      if (result.updateAvailable) {
        toast.info(`Update available: build ${result.latestBuildId}`);
      } else {
        toast.success("Server is up to date.");
      }
    } catch (e) {
      toast.error(`Update check failed: ${e}`);
    } finally {
      setChecking(false);
    }
  };

  const handleUpdateCache = async () => {
    setUpdating(true);
    try {
      const [cacheBase, steamcmdPath] = await Promise.all([
        getAppSetting("base_dir"),
        getAppSetting("steamcmd_path"),
      ]);
      if (!cacheBase || !steamcmdPath) {
        toast.error("Base directory or SteamCMD path not configured.");
        return;
      }
      const sep = cacheBase.includes("\\") ? "\\" : "/";
      const cacheDir = `${cacheBase.replace(/[/\\]$/, "")}${sep}lokiasam${sep}cache${sep}asa-server`;
      const newBuild = await tauriCmd.updateCache("global", cacheDir, steamcmdPath);
      await setAppSetting("asa_cached_build_id", newBuild);
      await setAppSetting("asa_update_available", "false");
      await setAppSetting("asa_last_checked", new Date().toISOString());
      load();
      toast.success(`Cache updated to build ${newBuild}. Apply to individual servers via their Overview tab.`);
    } catch (e) {
      toast.error(`Cache update failed: ${e}`);
    } finally {
      setUpdating(false);
    }
  };

  const busy = checking || updating;
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

      {updateAvailable && (
        <Button
          size="sm"
          disabled={busy}
          onClick={handleUpdateCache}
          className="h-7 gap-1.5 text-xs"
          style={{
            background: "rgba(255,165,0,0.12)",
            border: "1px solid rgba(255,165,0,0.4)",
            color: "#ffa500",
          }}
        >
          {updating
            ? <Loader2 className="w-3 h-3 animate-spin" />
            : <Upload className="w-3 h-3" />}
          Update Cache
        </Button>
      )}

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
        Check
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Startup reconciliation
// ---------------------------------------------------------------------------

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
