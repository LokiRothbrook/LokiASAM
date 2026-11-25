"use client";

import { useState, useEffect, useRef } from "react";
import { MoreVertical, Trash2, Copy, FolderOpen, HardDrive, Loader2, ToggleLeft, ToggleRight, ShieldCheck, RotateCcw } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { notify, serverNotify } from "@/lib/notify";
import { tauriCmd } from "@/lib/tauri-commands";
import { reinstallServer } from "@/lib/server-actions";
import { getSaveFolder } from "@/data/game-data";
import { ensureMapsCacheLoaded, findMapById } from "@/lib/maps";
import {
  deleteServerRecord,
  getAppSetting,
  insertBackup,
  pruneManualBackups,
  getServers,
} from "@/lib/db";
import { useQueryClient } from "@tanstack/react-query";
import { useAppStore } from "@/store/useAppStore";
import type { ServerRow } from "@/lib/db";
import type { BackupRecord } from "@/lib/tauri-commands";
import { getExclusivePorts as computeExclusivePorts, getServerFirewallPorts } from "@/lib/firewall-utils";
import type { PortDef } from "@/lib/tauri-commands";

interface Props {
  server: ServerRow;
  /** Called after a manual "Backup Now" completes, so callers can refresh their own backup-status display. */
  onBackupComplete?: () => void;
}

// ---------------------------------------------------------------------------
// Delete dialog
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

interface DiskUsage { backupBytes: number; logBytes: number; saveBytes: number; }

function DeleteToggleRow({
  label, sublabel, enabled, onToggle, color = "var(--neon-red)",
}: {
  label: string; sublabel: string; enabled: boolean;
  onToggle: () => void; color?: string;
}) {
  return (
    <div
      className="flex items-center justify-between px-1 py-2 rounded-lg"
      style={{ background: `rgba(${color === "var(--neon-red)" ? "255,0,85" : color === "var(--neon-purple)" ? "var(--neon-purple-rgb)" : "255,165,0"},0.05)`, border: `1px solid rgba(${color === "var(--neon-red)" ? "255,0,85" : color === "var(--neon-purple)" ? "var(--neon-purple-rgb)" : "255,165,0"},0.15)` }}
    >
      <div className="min-w-0 pr-3">
        <p className="text-sm" style={{ color: "var(--text-primary)" }}>{label}</p>
        <p className="text-xs mt-0.5 break-all" style={{ color: "var(--text-muted)" }}>{sublabel}</p>
      </div>
      <button type="button" onClick={onToggle} className="shrink-0 flex items-center focus:outline-none">
        {enabled
          ? <ToggleRight className="w-8 h-8" style={{ color }} />
          : <ToggleLeft className="w-8 h-8" style={{ color: "var(--text-muted)" }} />}
      </button>
    </div>
  );
}

function DeleteDialog({
  server,
  open,
  onClose,
}: {
  server: ServerRow;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const clearNoRetryServer = useAppStore((s) => s.clearNoRetryServer);
  const setCountdown = useAppStore((s) => s.setCountdown);
  const [deleteFiles, setDeleteFiles]     = useState(true);
  const [deleteBackups, setDeleteBackups] = useState(true);
  const [deleteLogs, setDeleteLogs]       = useState(true);
  const [deleteSaves, setDeleteSaves]     = useState(true);
  const [removeRules, setRemoveRules]     = useState(true);
  const [deleting, setDeleting]           = useState(false);
  const [exclusivePorts, setExclusivePorts] = useState<PortDef[]>([]);
  const [remainingPorts, setRemainingPorts] = useState<PortDef[]>([]);
  const [diskUsage, setDiskUsage]         = useState<DiskUsage | null>(null);
  const [backupDir, setBackupDir]         = useState("");
  const [baseDir, setBaseDir]             = useState("");

  // Reset toggles the moment the dialog transitions to open — compared during
  // render (React's documented "adjusting state" pattern) instead of via an
  // effect, since it's a synchronous reset with no async work of its own.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setDeleteFiles(true); setDeleteBackups(true);
      setDeleteLogs(true);  setDeleteSaves(true);
      setRemoveRules(true); setDiskUsage(null);
    }
  }

  // server is read via a ref so unrelated re-fetches of the parent's server
  // list (which hand this component a fresh object each time) don't re-run
  // this effect — only an actual `open` transition should trigger the fetch.
  const serverRef = useRef(server);
  useEffect(() => {
    serverRef.current = server;
  });

  useEffect(() => {
    if (!open) return;
    const currentServer = serverRef.current;

    Promise.all([
      getServers(),
      getAppSetting("backup_dir"),
      getAppSetting("base_dir"),
    ]).then(([all, bkDir, bsDir]) => {
      setExclusivePorts(computeExclusivePorts(currentServer, all));

      // Remaining ports = every port from servers OTHER than this one.
      // This is the complete desired state passed to the firewall backend after deletion.
      const otherServers = all.filter((s) => s.id !== currentServer.id);
      const remainingMap = new Map<string, PortDef>();
      for (const s of otherServers) {
        for (const p of getServerFirewallPorts(s)) {
          remainingMap.set(`${p.port}/${p.protocol}`, p);
        }
      }
      setRemainingPorts([...remainingMap.values()]);

      const bd = bkDir ?? "";
      const bsd = bsDir ?? "";
      setBackupDir(bd);
      setBaseDir(bsd);
      return tauriCmd.getServerDiskUsage(currentServer.id, bd, bsd);
    }).then((usage) => {
      setDiskUsage(usage);
    }).catch(() => {});
  }, [open]);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      if (removeRules && exclusivePorts.length > 0) {
        // Pass remaining ports (complete desired state after deletion) so the
        // backend can rebuild from scratch rather than trying to diff a stale profile.
        await tauriCmd.removeFirewallRules(remainingPorts).catch((e) => {
          notify.warning("Firewall rules could not be removed", { description: e, server });
        });
      }
      await tauriCmd.deleteServer(
        server.id,
        server.install_path,
        backupDir,
        baseDir,
        deleteFiles,
        deleteBackups,
        deleteLogs,
        deleteSaves,
      );
      await deleteServerRecord(server.id);
      // These are keyed by server id in the global store and never pruned
      // elsewhere — without this, deleting and recreating servers over a
      // long session accumulates stale entries indefinitely.
      clearNoRetryServer(server.id);
      setCountdown(server.id, null);
      queryClient.invalidateQueries({ queryKey: ["servers"] });
      onClose();
    } catch (err) {
      notify.error(`Couldn't delete ${server.name}`, { description: err, server, event: "server_action_failed" });
    } finally {
      setDeleting(false);
    }
  };

  const exclusivePortList = exclusivePorts
    .map((p) => `${p.port}/${p.protocol.toUpperCase()}`)
    .join(", ");

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle style={{ color: "var(--neon-red)" }}>
            Delete &ldquo;{server.name}&rdquo;?
          </DialogTitle>
          <DialogDescription>
            This will remove the server from LokiASAM. Choose what to clean up from disk below — everything is off by default.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 mt-1">
          <DeleteToggleRow
            label="Delete server files"
            sublabel={server.install_path}
            enabled={deleteFiles}
            onToggle={() => setDeleteFiles((v) => !v)}
            color="var(--neon-red)"
          />
          <DeleteToggleRow
            label={`Delete backups${diskUsage && diskUsage.backupBytes > 0 ? ` (${formatBytes(diskUsage.backupBytes)})` : diskUsage ? " (none)" : ""}`}
            sublabel={backupDir ? `${backupDir}/${server.id}/` : "Backup directory not configured"}
            enabled={deleteBackups}
            onToggle={() => setDeleteBackups((v) => !v)}
            color="var(--neon-red)"
          />
          <DeleteToggleRow
            label={`Delete logs & crash reports${diskUsage && diskUsage.logBytes > 0 ? ` (${formatBytes(diskUsage.logBytes)})` : diskUsage ? " (none)" : ""}`}
            sublabel="Archived logs and crash folders stored by LokiASAM"
            enabled={deleteLogs}
            onToggle={() => setDeleteLogs((v) => !v)}
            color="var(--neon-red)"
          />
          <DeleteToggleRow
            label={`Delete map saves${diskUsage && diskUsage.saveBytes > 0 ? ` (${formatBytes(diskUsage.saveBytes)})` : diskUsage ? " (none)" : ""}`}
            sublabel={baseDir ? `${baseDir}/saves/${server.id}/` : "Saves directory"}
            enabled={deleteSaves}
            onToggle={() => setDeleteSaves((v) => !v)}
            color="var(--neon-red)"
          />
          {exclusivePorts.length > 0 && (
            <DeleteToggleRow
              label={`Remove firewall rules for ${exclusivePortList}`}
              sublabel="Only ports not shared with any other server will be removed"
              enabled={removeRules}
              onToggle={() => setRemoveRules((v) => !v)}
              color="rgba(var(--neon-orange-rgb),1)"
            />
          )}
        </div>

        <DialogFooter className="gap-2 mt-2">
          <Button variant="outline" onClick={onClose} disabled={deleting}>Cancel</Button>
          <Button
            disabled={deleting}
            onClick={handleDelete}
            style={{ background: "rgba(var(--neon-red-rgb),0.15)", borderColor: "var(--neon-red)", color: "var(--neon-red)" }}
          >
            {deleting ? <><Loader2 className="w-3 h-3 animate-spin mr-1.5" />Deleting…</> : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Clone dialog
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// ServerActionMenu
// ---------------------------------------------------------------------------

export function ServerActionMenu({ server, onBackupComplete }: Props) {
  const sn = serverNotify(server);
  const queryClient = useQueryClient();
  const [deleteOpen, setDeleteOpen]   = useState(false);
  const openCloneWizard = useAppStore((s) => s.openCloneWizard);
  const [backingUp,  setBackingUp]    = useState(false);
  const [verifying,  setVerifying]    = useState(false);
  const [reinstallOpen, setReinstallOpen] = useState(false);
  const [reinstalling,  setReinstalling]  = useState(false);
  // "stopping" is included because the process is still alive and shutting
  // down — Verify Files/Reinstall would otherwise race a still-writing
  // process. The two queued states are included for the same reason
  // Restart All errs safe: the server is about to become busy either way.
  const isBusy = server.status === "running" || server.status === "starting"
    || server.status === "stopping" || server.status === "installing"
    || server.status === "updating" || server.status === "startup_queued"
    || server.status === "update_queued";

  const handleVerifyFiles = async () => {
    setVerifying(true);
    try {
      const [steamcmdPath, baseDir] = await Promise.all([
        getAppSetting("steamcmd_path"),
        getAppSetting("base_dir"),
      ]);
      if (!steamcmdPath) { sn.error("SteamCMD path not configured"); return; }
      if (!baseDir) { sn.error("Base directory not configured"); return; }
      const sep = baseDir.includes("\\") ? "\\" : "/";
      const cacheDir = `${baseDir.replace(/[/\\]$/, "")}${sep}lokiasam${sep}cache${sep}asa-server`;
      await tauriCmd.validateServerFiles(server.id, server.install_path, cacheDir, steamcmdPath);
      sn.success(`Game files verified for "${server.name}".`);
    } catch (err) {
      sn.error("Game file verification failed", { description: err, event: "server_action_failed" });
    } finally {
      setVerifying(false);
    }
  };

  const handleReinstall = async () => {
    setReinstalling(true);
    setReinstallOpen(false);
    queryClient.invalidateQueries({ queryKey: ["servers"] });
    try {
      // reinstallServer already dispatches a success/failure notification
      // (which shows its own toast) — no need to show a second one here.
      await reinstallServer(server);
    } catch {
      // Failure notification already dispatched by reinstallServer.
    } finally {
      setReinstalling(false);
      queryClient.invalidateQueries({ queryKey: ["servers"] });
    }
  };

  const handleBackupNow = async () => {
    setBackingUp(true);
    try {
      const backupDir = await getAppSetting("backup_dir");
      if (!backupDir) { sn.error("Backup directory not configured. Check Settings."); return; }

      await ensureMapsCacheLoaded().catch(() => {});
      const mapDef = findMapById(server.map_id);
      const mapPath = mapDef?.mapPath ?? "TheIsland_WP";
      const saveFolder = mapDef ? getSaveFolder(mapDef) : mapPath;
      const record: BackupRecord = await tauriCmd.createServerBackup(
        server.id,
        server.name,
        server.install_path,
        mapPath,
        saveFolder,
        server.map_id,
        backupDir,
        "manual",
        "",
        server.save_folder_name || undefined
      );
      await insertBackup({
        id:              record.id,
        server_id:       record.serverId,
        file_path:       record.filePath,
        file_size_bytes: record.fileSizeBytes,
        map_id:          record.mapId,
        triggered_by:    "manual",
        created_at:      record.createdAt,
        backup_type:     "server",
        tiers:           "",
        player_eosid:    null,
        player_name:     null,
      });
      const keep = parseInt(await getAppSetting(`manual_backup_keep_${server.id}`) ?? "5", 10);
      await pruneManualBackups(server.id, "server", isNaN(keep) ? 5 : keep);
      // Rust sends the "server backup complete" notification.
      onBackupComplete?.();
    } catch (err) {
      sn.error("Server backup failed", { description: err, event: "backup_failed" });
    } finally {
      setBackingUp(false);
    }
  };

  const handleOpenFolder = async () => {
    try {
      await tauriCmd.openFolder(server.install_path);
    } catch (err) {
      sn.error(`Could not open folder: ${err}`);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            style={{ color: "var(--text-muted)" }}
          >
            <MoreVertical className="w-4 h-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem
            className="gap-2"
            onClick={() => openCloneWizard(server.id)}
          >
            <Copy className="w-4 h-4" />
            Clone Server…
          </DropdownMenuItem>
          <DropdownMenuItem
            className="gap-2"
            disabled={backingUp}
            onClick={handleBackupNow}
          >
            {backingUp
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <HardDrive className="w-4 h-4" />
            }
            {backingUp ? "Backing up…" : "Backup Now"}
          </DropdownMenuItem>
          <DropdownMenuItem
            className="gap-2"
            onClick={handleOpenFolder}
          >
            <FolderOpen className="w-4 h-4" />
            Open Folder
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="gap-2"
            disabled={verifying || isBusy}
            title={isBusy ? "Stop the server before verifying" : undefined}
            onClick={handleVerifyFiles}
          >
            {verifying
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <ShieldCheck className="w-4 h-4" />
            }
            {verifying ? "Verifying…" : "Verify Files"}
          </DropdownMenuItem>
          <DropdownMenuItem
            className="gap-2"
            disabled={reinstalling || isBusy}
            title={isBusy ? "Stop the server before reinstalling" : undefined}
            onClick={() => setReinstallOpen(true)}
          >
            {reinstalling
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <RotateCcw className="w-4 h-4" />
            }
            {reinstalling ? "Reinstalling…" : "Reinstall"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="gap-2"
            style={{ color: "var(--neon-red)" }}
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 className="w-4 h-4" />
            Delete Server
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DeleteDialog server={server} open={deleteOpen} onClose={() => setDeleteOpen(false)} />

      <Dialog open={reinstallOpen} onOpenChange={(v) => !v && setReinstallOpen(false)}>
        <DialogContent onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>Reinstall &ldquo;{server.name}&rdquo;?</DialogTitle>
            <DialogDescription>
              Re-copies the shared cache to this server&apos;s install folder. Preserves save data
              (ShooterGame/Saved) — safe to run with existing saves.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 mt-2">
            <Button variant="outline" onClick={() => setReinstallOpen(false)}>Cancel</Button>
            <Button
              onClick={handleReinstall}
              style={{ background: "rgba(var(--neon-purple-rgb),0.15)", borderColor: "rgba(var(--neon-purple-rgb),0.5)", color: "var(--neon-purple)" }}
            >
              Reinstall
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
