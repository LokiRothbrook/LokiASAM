"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Plus, Server, Activity, RefreshCw, Upload,
  ArrowUp, Loader2, AlertTriangle, LayoutDashboard,
  Play, Square, RotateCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { StatCard } from "@/components/shared/StatCard";
import { ServerCard } from "@/components/server/ServerCard";
import { ImportServerWizard } from "@/components/server/ImportServerWizard";
import { useServers } from "@/hooks/useServers";
import { getAppSetting, updateServerStatus } from "@/lib/db";
import { tauriCmd } from "@/lib/tauri-commands";
import { runAsaCacheUpdate, runPerServerUpdateCheck, applyUpdateToAllServers, type ServerUpdateInfo } from "@/lib/update-utils";
import { buildStartParams } from "@/lib/server-utils";
import { dispatchNotification } from "@/lib/notifications";
import { NOTIFICATION_EVENTS } from "@/data/game-data";
import { useQueryClient } from "@tanstack/react-query";
import { useAppStore } from "@/store/useAppStore";
import { toast } from "sonner";
import { useBuildVersionCache } from "@/hooks/useBuildVersionCache";
import { formatServerVersion } from "@/lib/db";
import { getVersion } from "@tauri-apps/api/app";

// ---------------------------------------------------------------------------
// UpdateStatusChip — Check for Updates button + post-check dialogs
// ---------------------------------------------------------------------------

interface UpdateStatusChipProps {
  servers: ReturnType<typeof useServers>["data"];
  onUpdateAllClick: () => void;
  onUpdatesFound: (updates: ServerUpdateInfo[]) => void;
}

function UpdateStatusChip({ servers = [], onUpdateAllClick, onUpdatesFound }: UpdateStatusChipProps) {
  const queryClient             = useQueryClient();
  const [checking, setChecking] = useState(false);

  // Background checks (scheduled or per-server auto-apply) are handled
  // globally in SchedulerManager, which invalidates the ["servers"] query —
  // this component just re-renders from the refreshed `servers` prop, so it
  // doesn't need its own asa://update-check listener.

  const handleCheck = async () => {
    setChecking(true);
    try {
      const oldBuild = await getAppSetting("asa_cached_build_id") ?? "";
      const newBuild = await runAsaCacheUpdate();
      if (!newBuild) {
        toast.error("Base directory or SteamCMD not configured.");
        return;
      }
      // Manual check: silent mode suppresses per-server toasts; we show dialog.
      const summary = await runPerServerUpdateCheck(true);
      queryClient.invalidateQueries({ queryKey: ["servers"] });

      if (summary.allWithUpdates.length > 0) {
        // Show the updates-found dialog to the user.
        onUpdatesFound(summary.allWithUpdates);
      } else {
        toast.success("All servers are up to date.");
      }

      // Only notify Discord/email if the cache actually changed.
      if (newBuild && newBuild !== oldBuild) {
        await dispatchNotification({
          eventType:  NOTIFICATION_EVENTS.UPDATE_AVAILABLE,
          serverId:   null,
          serverName: "ASA Cache",
          title:      "Cache Updated",
          body:       `Cache updated to build ${newBuild}. Check for server updates.`,
          severity:   "info",
        });
      }
    } catch (e) {
      toast.error("Update check failed", { description: String(e) });
    } finally {
      setChecking(false);
    }
  };

  const serversWithUpdates = (servers ?? []).filter((s) => s.update_available === 1);
  const anyStarting        = (servers ?? []).some(
    (s) => s.update_available === 1 && s.status === "starting"
  );

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {serversWithUpdates.length > 0 && (
        <Button
          size="sm"
          disabled={anyStarting}
          onClick={onUpdateAllClick}
          title={anyStarting ? "A server with a pending update is currently starting" : undefined}
          className="h-7 gap-1.5 text-xs"
          style={{
            background:  "rgba(255,165,0,0.12)",
            border:      "1px solid rgba(255,165,0,0.4)",
            color:       "#ffa500",
          }}
        >
          <ArrowUp className="w-3 h-3" />
          Update All ({serversWithUpdates.length})
        </Button>
      )}

      <Button
        size="sm"
        variant="outline"
        disabled={checking}
        onClick={handleCheck}
        className="gap-1.5"
        style={{ borderColor: "rgba(var(--neon-purple-rgb),0.3)", color: "var(--neon-purple)" }}
      >
        {checking
          ? <Loader2 className="w-3 h-3 animate-spin" />
          : <RefreshCw className="w-3 h-3" />}
        Check for Updates
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// UpdatesFoundDialog — shown after manual "Check for Updates" finds results
// ---------------------------------------------------------------------------

interface UpdatesFoundDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  updates: ServerUpdateInfo[];
  onUpdateAll: (restartAfterUpdate: boolean) => void;
}

function UpdatesFoundDialog({ open, onOpenChange, updates, onUpdateAll }: UpdatesFoundDialogProps) {
  const [restartAfterUpdate, setRestartAfterUpdate] = useState(true);
  const anyRunning = updates.some((s) => s.status === "running");
  const anyStarting = updates.some((s) => s.status === "starting");
  const versionCache = useBuildVersionCache();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowUp className="w-4 h-4" style={{ color: "#ffa500" }} />
            {updates.length === 1 ? "Update Available" : `${updates.length} Updates Available`}
          </DialogTitle>
          <DialogDescription>
            The following servers have updates ready to apply from the shared cache.
          </DialogDescription>
        </DialogHeader>

        {/* Server list */}
        <div className="flex flex-col gap-2 max-h-48 overflow-y-auto">
          {updates.map((s) => (
            <div
              key={s.id}
              className="flex items-center justify-between px-3 py-2 rounded-lg text-sm"
              style={{ background: "rgba(255,165,0,0.05)", border: "1px solid rgba(255,165,0,0.15)" }}
            >
              <div>
                <span className="font-medium" style={{ color: "var(--text-primary)" }}>{s.name}</span>
                {s.installedBuild !== "unknown" && (
                  <span className="text-xs ml-2 font-mono" style={{ color: "var(--text-muted)" }}>
                    {formatServerVersion(s.installedBuild, versionCache)} → {formatServerVersion(s.cachedBuild, versionCache)}
                  </span>
                )}
              </div>
              <span
                className="text-xs px-1.5 py-0.5 rounded capitalize"
                style={{
                  color: s.status === "running" ? "var(--neon-green)"
                       : s.status === "starting" ? "var(--neon-cyan)"
                       : "var(--text-muted)",
                  background: s.status === "running" ? "rgba(0,255,136,0.08)"
                            : s.status === "starting" ? "rgba(0,255,255,0.08)"
                            : "rgba(255,255,255,0.04)",
                }}
              >
                {s.status}
              </span>
            </div>
          ))}
        </div>

        {/* Warnings */}
        {anyRunning && (
          <div
            className="flex items-start gap-2 px-3 py-2 rounded-lg text-xs"
            style={{ background: "rgba(255,165,0,0.06)", border: "1px solid rgba(255,165,0,0.2)", color: "#ffa500" }}
          >
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            Running servers will be stopped to apply the update.
          </div>
        )}
        {anyStarting && (
          <div
            className="flex items-start gap-2 px-3 py-2 rounded-lg text-xs"
            style={{ background: "rgba(255,200,0,0.06)", border: "1px solid rgba(255,200,0,0.2)", color: "#ffc800" }}
          >
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            One or more servers are currently starting. Their startup will be cancelled to apply the update.
          </div>
        )}

        {/* Restart toggle */}
        {(anyRunning || anyStarting) && (
          <div
            className="flex items-center gap-3 px-1 py-2 rounded-lg"
            style={{ background: "rgba(255,165,0,0.05)", border: "1px solid rgba(255,165,0,0.15)" }}
          >
            <Switch
              id="ua-restart-toggle"
              checked={restartAfterUpdate}
              onCheckedChange={setRestartAfterUpdate}
            />
            <Label htmlFor="ua-restart-toggle" className="text-sm cursor-pointer" style={{ color: "var(--text-primary)" }}>
              Restart running servers after update
            </Label>
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}
            style={{ borderColor: "rgba(var(--neon-purple-rgb),0.3)", color: "var(--text-muted)" }}>
            Not Now
          </Button>
          <Button
            onClick={() => { onOpenChange(false); onUpdateAll(restartAfterUpdate); }}
            style={{ background: "rgba(255,165,0,0.15)", borderColor: "rgba(255,165,0,0.5)", color: "#ffa500" }}
          >
            <ArrowUp className="w-3.5 h-3.5 mr-1.5" />
            Update All
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// UpdateAllDialog — confirmation before applying updates from the header button
// ---------------------------------------------------------------------------

interface UpdateAllDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  updates: ServerUpdateInfo[];
  anyStarting: boolean;
  onConfirm: (restartAfterUpdate: boolean) => void;
}

function UpdateAllDialog({ open, onOpenChange, updates, anyStarting, onConfirm }: UpdateAllDialogProps) {
  const [restartAfterUpdate, setRestartAfterUpdate] = useState(true);
  const anyRunning = updates.some((s) => s.status === "running");
  const versionCache = useBuildVersionCache();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowUp className="w-4 h-4" style={{ color: "#ffa500" }} />
            Update All Servers
          </DialogTitle>
          <DialogDescription>
            Updates will be applied sequentially from the shared cache.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 max-h-48 overflow-y-auto">
          {updates.map((s) => (
            <div
              key={s.id}
              className="flex items-center justify-between px-3 py-2 rounded-lg text-sm"
              style={{ background: "rgba(255,165,0,0.05)", border: "1px solid rgba(255,165,0,0.15)" }}
            >
              <div>
                <span className="font-medium" style={{ color: "var(--text-primary)" }}>{s.name}</span>
                {s.installedBuild !== "unknown" && (
                  <span className="text-xs ml-2 font-mono" style={{ color: "var(--text-muted)" }}>
                    {formatServerVersion(s.installedBuild, versionCache)} → {formatServerVersion(s.cachedBuild, versionCache)}
                  </span>
                )}
              </div>
              <span
                className="text-xs px-1.5 py-0.5 rounded capitalize"
                style={{
                  color: s.status === "running" ? "var(--neon-green)"
                       : s.status === "starting" ? "var(--neon-cyan)"
                       : "var(--text-muted)",
                  background: s.status === "running" ? "rgba(0,255,136,0.08)"
                            : s.status === "starting" ? "rgba(0,255,255,0.08)"
                            : "rgba(255,255,255,0.04)",
                }}
              >
                {s.status}
              </span>
            </div>
          ))}
        </div>

        {anyRunning && (
          <div
            className="flex items-start gap-2 px-3 py-2 rounded-lg text-xs"
            style={{ background: "rgba(255,165,0,0.06)", border: "1px solid rgba(255,165,0,0.2)", color: "#ffa500" }}
          >
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            Running servers will be stopped to apply the update.
          </div>
        )}
        {anyStarting && (
          <div
            className="flex items-start gap-2 px-3 py-2 rounded-lg text-xs"
            style={{ background: "rgba(255,200,0,0.06)", border: "1px solid rgba(255,200,0,0.2)", color: "#ffc800" }}
          >
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            One or more servers are currently starting. Their startup will be cancelled to apply the update.
          </div>
        )}

        {(anyRunning || anyStarting) && (
          <div
            className="flex items-center gap-3 px-1 py-2 rounded-lg"
            style={{ background: "rgba(255,165,0,0.05)", border: "1px solid rgba(255,165,0,0.15)" }}
          >
            <Switch
              id="ua-conf-restart-toggle"
              checked={restartAfterUpdate}
              onCheckedChange={setRestartAfterUpdate}
            />
            <Label htmlFor="ua-conf-restart-toggle" className="text-sm cursor-pointer" style={{ color: "var(--text-primary)" }}>
              Restart running servers after update
            </Label>
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}
            style={{ borderColor: "rgba(var(--neon-purple-rgb),0.3)", color: "var(--text-muted)" }}>
            Cancel
          </Button>
          <Button
            onClick={() => { onOpenChange(false); onConfirm(restartAfterUpdate); }}
            style={{ background: "rgba(255,165,0,0.15)", borderColor: "rgba(255,165,0,0.5)", color: "#ffa500" }}
          >
            <ArrowUp className="w-3.5 h-3.5 mr-1.5" />
            Update All
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// DashboardPage
// ---------------------------------------------------------------------------

export default function DashboardPage() {
  const { data: servers = [], isLoading } = useServers();
  const { setShowNewServerWizard, enqueueStartup } = useAppStore();
  const [showImport, setShowImport]               = useState(false);
  const [appVersion, setAppVersion]               = useState("");

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});
  }, []);
  const [showUpdateAllDialog, setShowUpdateAllDialog] = useState(false);
  const [showUpdatesFoundDialog, setShowUpdatesFoundDialog] = useState(false);
  const [pendingUpdates, setPendingUpdates]        = useState<ServerUpdateInfo[]>([]);
  const [updatingAll, setUpdatingAll]              = useState(false);
  const queryClient = useQueryClient();

  const total = servers.length;

  // Build the ServerUpdateInfo list from the live servers data.
  const serversWithUpdates: ServerUpdateInfo[] = servers
    .filter((s) => s.update_available === 1)
    .map((s) => ({
      id:             s.id,
      name:           s.name,
      status:         s.status,
      installedBuild: "—",
      cachedBuild:    "—",
    }));

  const anyUpdatesStarting = serversWithUpdates.some((s) => s.status === "starting");
  const [globalActionPending, setGlobalActionPending] = useState(false);

  // ── Global start/stop/restart handlers ───────────────────────────────────

  const handleStartAll = useCallback(async () => {
    const stopped = servers.filter((s) =>
      s.status === "stopped" || s.status === "start-failed" || s.status === "crashed"
    );
    if (stopped.length === 0) return;
    setGlobalActionPending(true);
    try {
      for (const s of stopped) {
        await updateServerStatus(s.id, "starting", null);
        const params = await buildStartParams(s);
        tauriCmd.startServer(params)
          .then((pid) => updateServerStatus(s.id, "starting", pid))
          .catch(async (e) => {
            await updateServerStatus(s.id, "start-failed", null);
            toast.error(`Failed to start ${s.name}: ${e}`);
          })
          .finally(() => queryClient.invalidateQueries({ queryKey: ["servers"] }));
      }
      queryClient.invalidateQueries({ queryKey: ["servers"] });
      toast.info(`Starting ${stopped.length} server${stopped.length === 1 ? "" : "s"}…`);
    } finally { setGlobalActionPending(false); }
  }, [servers, queryClient]);

  const handleStopAll = useCallback(async () => {
    const running = servers.filter((s) => s.status === "running" || s.status === "starting");
    if (running.length === 0) return;
    setGlobalActionPending(true);
    try {
      let failed = 0;
      await Promise.all(running.map(async (s) => {
        try {
          await updateServerStatus(s.id, "stopping", s.pid);
          await tauriCmd.stopServer(s.id, false);
        } catch (e) {
          failed += 1;
          toast.error(`Failed to stop ${s.name}: ${e}`);
        } finally {
          queryClient.invalidateQueries({ queryKey: ["servers"] });
        }
      }));
      const succeeded = running.length - failed;
      if (succeeded > 0) toast.info(`Stopping ${succeeded} server${succeeded === 1 ? "" : "s"}…`);
    } finally { setGlobalActionPending(false); }
  }, [servers, queryClient]);

  const handleRestartAll = useCallback(async () => {
    const running = servers.filter((s) => s.status === "running");
    if (running.length === 0) return;
    setGlobalActionPending(true);
    try {
      await Promise.all(running.map(async (s) => {
        try {
          await updateServerStatus(s.id, "stopping", s.pid);
          queryClient.invalidateQueries({ queryKey: ["servers"] });
          const params = await buildStartParams(s);
          const newPid = await tauriCmd.restartServer(params, true);
          await updateServerStatus(s.id, "running", newPid);
        } catch (e) {
          toast.error(`Failed to restart ${s.name}: ${e}`);
          await updateServerStatus(s.id, "error", null);
        } finally {
          queryClient.invalidateQueries({ queryKey: ["servers"] });
        }
      }));
      toast.info(`Restarting ${running.length} server${running.length === 1 ? "" : "s"}…`);
    } finally { setGlobalActionPending(false); }
  }, [servers, queryClient]);

  // ── Update All handler ────────────────────────────────────────────────────

  const runUpdateAll = useCallback(async (restartAfterUpdate: boolean) => {
    if (updatingAll) return;
    setUpdatingAll(true);

    const targets = servers.filter((s) => s.update_available === 1);
    if (targets.length === 0) { setUpdatingAll(false); return; }

    try {
      await applyUpdateToAllServers(targets, restartAfterUpdate, {
        enqueueStartup,
        onInvalidate: () => queryClient.invalidateQueries({ queryKey: ["servers"] }),
        onProgress: (serverId, msg) => toast.info(msg, { id: `update-${serverId}` }),
      });
    } finally {
      setUpdatingAll(false);
      queryClient.invalidateQueries({ queryKey: ["servers"] });
    }
  }, [servers, updatingAll, queryClient, enqueueStartup]);

  return (
    <div className="h-full overflow-hidden flex flex-col gap-6">
      {/* ── Page header ── */}
      <div className="flex items-start justify-between flex-wrap gap-3 shrink-0">
        <div>
          <div className="flex items-center gap-3">
            <LayoutDashboard className="w-6 h-6 shrink-0" style={{ color: "var(--neon-purple)" }} />
            <h1
              className="text-2xl font-bold tracking-tight"
              style={{ color: "var(--neon-purple)", textShadow: "var(--glow-purple)" }}
            >
              Server Dashboard
            </h1>
          </div>
          <p className="text-sm mt-0.5" style={{ color: "var(--text-muted)" }}>
            Manage your Ark Survival Ascended dedicated servers.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {servers.length > 0 && (
            <>
              <UpdateStatusChip
                servers={servers}
                onUpdateAllClick={() => setShowUpdateAllDialog(true)}
                onUpdatesFound={(updates) => {
                  setPendingUpdates(updates);
                  setShowUpdatesFoundDialog(true);
                }}
              />
              <Button size="sm" variant="outline" disabled={globalActionPending}
                onClick={handleStartAll}
                title="Start all stopped servers"
                className="gap-1.5"
                style={{ borderColor: "rgba(0,255,136,0.3)", color: "var(--neon-green)", background: "rgba(0,255,136,0.05)" }}
              >
                <Play className="w-3.5 h-3.5" /> Start All
              </Button>
              <Button size="sm" variant="outline" disabled={globalActionPending}
                onClick={handleStopAll}
                title="Stop all running servers"
                className="gap-1.5"
                style={{ borderColor: "rgba(255,0,85,0.3)", color: "rgba(255,0,85,0.85)", background: "rgba(255,0,85,0.05)" }}
              >
                <Square className="w-3.5 h-3.5" /> Stop All
              </Button>
              <Button size="sm" variant="outline" disabled={globalActionPending}
                onClick={handleRestartAll}
                title="Restart all running servers"
                className="gap-1.5"
                style={{ borderColor: "rgba(0,255,255,0.3)", color: "var(--neon-cyan)", background: "rgba(0,255,255,0.05)" }}
              >
                <RotateCcw className="w-3.5 h-3.5" /> Restart All
              </Button>
            </>
          )}
          <Button
            variant="outline"
            onClick={() => setShowImport(true)}
            className="gap-2"
            style={{ borderColor: "rgba(var(--neon-purple-rgb),0.3)", color: "var(--neon-purple)" }}
          >
            <Upload className="w-4 h-4" />
            Import Server
          </Button>
          <Button
            variant="outline"
            onClick={() => setShowNewServerWizard(true)}
            className="gap-2"
            style={{ borderColor: "rgba(var(--neon-purple-rgb),0.3)", color: "var(--neon-purple)" }}
          >
            <Plus className="w-4 h-4" />
            New Server
          </Button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto pr-6">
      {/* ── Needs Attention warning — only shown when servers are in a bad state ── */}
      {total > 0 && servers.some((s) => s.status === "crashed" || s.status === "error") && (
        <div className="flex flex-wrap gap-3">
          <StatCard
            label="Needs Attention"
            value={servers.filter((s) => s.status === "crashed" || s.status === "error").length}
            icon={Activity}
            color="var(--neon-red)"
          />
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
            style={{ background: "rgba(var(--neon-purple-rgb),0.05)", border: "1px solid rgba(var(--neon-purple-rgb),0.15)" }}
          >
            <Server className="w-8 h-8" style={{ color: "var(--neon-purple)" }} />
          </div>
          <div>
            <h2 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>No servers yet</h2>
            <p className="text-sm mt-1 max-w-sm" style={{ color: "var(--text-muted)" }}>
              Create your first Ark Survival Ascended server to get started.
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() => setShowNewServerWizard(true)}
            className="mt-2 gap-2"
            style={{ borderColor: "rgba(var(--neon-purple-rgb),0.3)", color: "var(--neon-purple)" }}
          >
            <Plus className="w-4 h-4" /> Create Server
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

      {/* ── Update All confirmation dialog (from header button) ── */}
      <UpdateAllDialog
        open={showUpdateAllDialog}
        onOpenChange={setShowUpdateAllDialog}
        updates={serversWithUpdates}
        anyStarting={anyUpdatesStarting}
        onConfirm={runUpdateAll}
      />

      {/* ── Updates found dialog (after manual Check for Updates) ── */}
      <UpdatesFoundDialog
        open={showUpdatesFoundDialog}
        onOpenChange={setShowUpdatesFoundDialog}
        updates={pendingUpdates}
        onUpdateAll={runUpdateAll}
      />
      </div>

      {/* Branding footer */}
      <div className="shrink-0 text-center pb-1">
        <p className="text-xs" style={{ color: "var(--text-subtle)" }}>
          LokiASAM{appVersion ? ` v${appVersion}` : ""} · lokisoft.xyz
        </p>
      </div>
    </div>
  );
}
