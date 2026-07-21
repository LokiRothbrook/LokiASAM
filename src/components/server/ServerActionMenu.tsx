"use client";

import { useState, useEffect } from "react";
import { MoreVertical, Trash2, Copy, FolderOpen, HardDrive, Loader2, ToggleLeft, ToggleRight } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { tauriCmd } from "@/lib/tauri-commands";
import { ARK_MAPS, getSaveFolder } from "@/data/game-data";
import {
  deleteServerRecord,
  createServer,
  updateServerStatus,
  getServerConfig,
  saveServerConfig,
  getServerMods,
  addServerMod,
  getServerSchedules,
  createSchedule,
  getAppSetting,
  isServerNameTaken,
  insertBackup,
  pruneManualBackups,
  getServers,
} from "@/lib/db";
import { useQueryClient } from "@tanstack/react-query";
import type { ServerRow } from "@/lib/db";
import type { BackupRecord } from "@/lib/tauri-commands";
import { getExclusivePorts as computeExclusivePorts, getServerFirewallPorts } from "@/lib/firewall-utils";
import type { PortDef } from "@/lib/tauri-commands";
const uuidv4 = () => crypto.randomUUID();

interface Props {
  server: ServerRow;
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

  useEffect(() => {
    if (!open) return;
    // Reset toggles each time the dialog opens (all ON by default)
    setDeleteFiles(true); setDeleteBackups(true);
    setDeleteLogs(true);  setDeleteSaves(true);
    setRemoveRules(true); setDiskUsage(null);

    Promise.all([
      getServers(),
      getAppSetting("backup_dir"),
      getAppSetting("base_dir"),
    ]).then(([all, bkDir, bsDir]) => {
      setExclusivePorts(computeExclusivePorts(server, all));

      // Remaining ports = every port from servers OTHER than this one.
      // This is the complete desired state passed to the firewall backend after deletion.
      const otherServers = all.filter((s) => s.id !== server.id);
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
      return tauriCmd.getServerDiskUsage(server.id, bd, bsd);
    }).then((usage) => {
      setDiskUsage(usage);
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      if (removeRules && exclusivePorts.length > 0) {
        // Pass remaining ports (complete desired state after deletion) so the
        // backend can rebuild from scratch rather than trying to diff a stale profile.
        await tauriCmd.removeFirewallRules(remainingPorts).catch((e) => {
          toast.warning(`Firewall rules could not be removed: ${e}`);
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
      queryClient.invalidateQueries({ queryKey: ["servers"] });
      onClose();
    } catch (err) {
      toast.error(`Delete failed: ${err}`);
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
              color="rgba(255,165,0,1)"
            />
          )}
        </div>

        <DialogFooter className="gap-2 mt-2">
          <Button variant="outline" onClick={onClose} disabled={deleting}>Cancel</Button>
          <Button
            disabled={deleting}
            onClick={handleDelete}
            style={{ background: "rgba(255,0,85,0.15)", borderColor: "var(--neon-red)", color: "var(--neon-red)" }}
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

function CloneDialog({
  server,
  open,
  onClose,
}: {
  server: ServerRow;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(`Copy of ${server.name}`);
  const [port, setPort] = useState(server.port + 10);
  const [queryPort, setQueryPort] = useState(server.query_port + 10);
  const [rconPort, setRconPort] = useState(server.rcon_port + 10);
  const [cloning, setCloning] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const handleClone = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) { setError("Name is required."); return; }
    setError("");
    setCloning(true);

    let newId = "";
    let newInstallPath = "";

    try {
      // Validate name uniqueness
      const taken = await isServerNameTaken(trimmedName);
      if (taken) { setError("A server with this name already exists."); return; }

      const baseDir = await getAppSetting("base_dir");
      if (!baseDir) { setError("Base directory not configured."); return; }
      const sep = baseDir.includes("\\") ? "\\" : "/";
      newInstallPath = `${baseDir.replace(/[/\\]$/, "")}${sep}servers${sep}${trimmedName}`;
      newId = uuidv4();

      // 1. Create DB record
      setStatus("Creating server record…");
      await createServer({
        id: newId,
        name: trimmedName,
        mapId: server.map_id,
        installPath: newInstallPath,
        port,
        queryPort,
        rconPort,
        maxPlayers: server.max_players,
        serverPassword: server.server_password ?? undefined,
        adminPassword: server.admin_password,
        clusterId: server.cluster_id ?? undefined,
        presetId: server.preset_id ?? undefined,
      });

      // 2. Clone config (from DB)
      setStatus("Copying configuration…");
      const cfg = await getServerConfig(server.id);
      if (cfg) {
        await saveServerConfig(
          newId,
          cfg.game_user_settings_json,
          cfg.game_ini_json,
          cfg.launch_args_json
        );
      }

      // 3. Clone mods
      setStatus("Copying mods list…");
      const mods = await getServerMods(server.id);
      for (const mod of mods) {
        await addServerMod(newId, mod.mod_id, mod.mod_name, mod.mod_thumbnail_url ?? null);
      }

      // 4. Clone schedules
      setStatus("Copying schedules…");
      const schedules = await getServerSchedules(server.id);
      for (const s of schedules) {
        await createSchedule({
          id: uuidv4(),
          serverId: newId,
          scheduleType: s.schedule_type,
          cronExpression: s.cron_expression,
          enabled: s.enabled === 1,
          configJson: s.config_json,
        });
      }

      // 5. Copy game files
      setStatus("Copying server files — this may take several minutes…");
      try {
        await tauriCmd.cloneServer(server.install_path, newInstallPath);
      } catch (fileErr) {
        const msg = String(fileErr);
        if (msg.includes("Source path does not exist") || msg.includes("does not exist")) {
          // Source server has no files — mark the clone as needing install.
          // This is not an error; the user can reinstall from the server card.
          await updateServerStatus(newId, "install_failed", null).catch(() => {});
          queryClient.invalidateQueries({ queryKey: ["servers"] });
          toast.success(`Server "${trimmedName}" cloned. Server files were not found — use Reinstall on the new server card.`);
          onClose();
          return;
        }
        throw fileErr;
      }

      queryClient.invalidateQueries({ queryKey: ["servers"] });
      toast.success(`Server "${trimmedName}" cloned successfully.`);
      onClose();
    } catch (err) {
      setError(`Clone failed: ${err}`);
    } finally {
      setCloning(false);
      setStatus("");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !cloning && onClose()}>
      <DialogContent className="max-w-md" onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle style={{ color: "var(--neon-purple)" }}>
            Clone &ldquo;{server.name}&rdquo;
          </DialogTitle>
          <DialogDescription>
            Creates a copy with the same config, mods, and schedules. Port numbers must be unique.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 mt-1">
          <div className="space-y-1.5">
            <Label style={{ color: "var(--text-primary)" }}>New Server Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={cloning}
              style={{ background: "var(--surface)", borderColor: "var(--border)" }}
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            {[
              { label: "Game Port", value: port, set: setPort },
              { label: "Query Port", value: queryPort, set: setQueryPort },
              { label: "RCON Port", value: rconPort, set: setRconPort },
            ].map(({ label, value: v, set }) => (
              <div key={label} className="space-y-1.5">
                <Label className="text-xs" style={{ color: "var(--text-muted)" }}>{label}</Label>
                <Input
                  type="number"
                  value={v}
                  onChange={(e) => set(Number(e.target.value))}
                  disabled={cloning}
                  className="text-sm"
                  style={{ background: "var(--surface)", borderColor: "var(--border)" }}
                />
              </div>
            ))}
          </div>

          {cloning && status && (
            <p className="text-xs flex items-center gap-2" style={{ color: "var(--neon-purple)" }}>
              <Loader2 className="w-3 h-3 animate-spin shrink-0" /> {status}
            </p>
          )}
          {error && (
            <p className="text-xs" style={{ color: "var(--neon-red)" }}>{error}</p>
          )}
        </div>

        <DialogFooter className="gap-2 mt-2">
          <Button variant="outline" onClick={onClose} disabled={cloning}>Cancel</Button>
          <Button
            onClick={handleClone}
            disabled={cloning || !name.trim()}
            style={{
              background: "rgba(var(--neon-purple-rgb),0.15)",
              borderColor: "var(--neon-purple)",
              color: "var(--neon-purple)",
            }}
          >
            {cloning ? <><Loader2 className="w-3 h-3 animate-spin mr-1.5" />Cloning…</> : "Clone Server"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// ServerActionMenu
// ---------------------------------------------------------------------------

export function ServerActionMenu({ server }: Props) {
  const [deleteOpen, setDeleteOpen]   = useState(false);
  const [cloneOpen,  setCloneOpen]    = useState(false);
  const [backingUp,  setBackingUp]    = useState(false);

  const handleBackupNow = async () => {
    setBackingUp(true);
    try {
      const backupDir = await getAppSetting("backup_dir");
      if (!backupDir) { toast.error("Backup directory not configured. Check Settings."); return; }

      const mapDef = ARK_MAPS.find((m) => m.id === server.map_id);
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
      toast.success(`Backup of "${server.name}" completed.`);
    } catch (err) {
      toast.error(`Backup failed: ${err}`);
    } finally {
      setBackingUp(false);
    }
  };

  const handleOpenFolder = async () => {
    try {
      await tauriCmd.openFolder(server.install_path);
    } catch (err) {
      toast.error(`Could not open folder: ${err}`);
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
            onClick={() => setCloneOpen(true)}
          >
            <Copy className="w-4 h-4" />
            Clone Server
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
            style={{ color: "var(--neon-red)" }}
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 className="w-4 h-4" />
            Delete Server
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DeleteDialog server={server} open={deleteOpen} onClose={() => setDeleteOpen(false)} />
      <CloneDialog  server={server} open={cloneOpen}  onClose={() => setCloneOpen(false)} />
    </>
  );
}
