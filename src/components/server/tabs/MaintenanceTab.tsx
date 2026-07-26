"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ShieldCheck, RotateCcw, X, Save, Loader2, FolderOpen,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { tauriCmd } from "@/lib/tauri-commands";
import { getAppSetting, getServers } from "@/lib/db";
import { reinstallServer } from "@/lib/server-actions";
import { getMapById, getSaveFolder } from "@/data/game-data";
import type { ServerRow } from "@/lib/db";

interface Props {
  server: ServerRow;
}

// ---------------------------------------------------------------------------
// Verify Files card — re-validates the shared cache against Steam then
// re-syncs it to this server (skips ShooterGame/Saved, so world/config data
// is never touched). Same command the old Overview "Verify Files" button used.
// ---------------------------------------------------------------------------

function VerifyFilesCard({ server }: Props) {
  const [validating, setValidating] = useState(false);
  const isRunning = server.status === "running";

  const handleVerify = async () => {
    setValidating(true);
    try {
      const [steamcmdPath, baseDir] = await Promise.all([
        getAppSetting("steamcmd_path"),
        getAppSetting("base_dir"),
      ]);
      if (!steamcmdPath) { toast.error("SteamCMD path not configured"); return; }
      if (!baseDir) { toast.error("Base directory not configured"); return; }
      const sep = baseDir.includes("\\") ? "\\" : "/";
      const cacheDir = `${baseDir.replace(/[/\\]$/, "")}${sep}lokiasam${sep}cache${sep}asa-server`;
      await tauriCmd.validateServerFiles(server.id, server.install_path, cacheDir, steamcmdPath);
      toast.success("Game files verified");
    } catch (e) {
      toast.error(`Validation failed: ${e}`);
    } finally {
      setValidating(false);
    }
  };

  return (
    <div className="glass-card rounded-xl p-4 space-y-3" style={{ border: "1px solid rgba(0,255,255,0.15)" }}>
      <div className="flex items-center gap-2">
        <ShieldCheck className="w-4 h-4" style={{ color: "var(--neon-cyan)" }} />
        <h3 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Verify Files</h3>
      </div>
      <p className="text-xs" style={{ color: "var(--text-muted)" }}>
        Re-checks the shared cache against Steam (re-downloading anything missing or corrupted), then
        re-syncs it to this server. Never touches <span className="font-mono">ShooterGame/Saved</span> —
        your world data and INI configs are untouched. Use this if a server was left in an unclear state
        after an interrupted update.
      </p>
      <div className="flex items-center gap-2">
        <button
          onClick={handleVerify}
          disabled={validating || isRunning}
          title={isRunning ? "Stop the server before validating" : "Verify game files via SteamCMD"}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-all"
          style={{ background: "rgba(0,255,255,0.08)", border: "1px solid rgba(0,255,255,0.3)", color: validating ? "var(--text-muted)" : "var(--neon-cyan)", opacity: isRunning ? 0.5 : 1 }}
        >
          {validating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
          {validating ? "Verifying…" : "Verify Files"}
        </button>
        <button
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-all"
          style={{ background: "rgba(var(--neon-purple-rgb),0.06)", border: "1px solid rgba(var(--neon-purple-rgb),0.2)", color: "var(--text-muted)" }}
          onClick={() => tauriCmd.openFolder(server.install_path).catch(() => null)}
          title="Open install folder"
        >
          <FolderOpen className="w-3.5 h-3.5" />
          Open Install Folder
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reinstall card — always-available recovery action, not gated behind a
// failure status like the server card's Reinstall button.
// ---------------------------------------------------------------------------

function ReinstallCard({ server }: Props) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [reinstalling, setReinstalling] = useState(false);
  const isRunning = server.status === "running" || server.status === "starting";

  const handleReinstall = async () => {
    setReinstalling(true);
    setConfirming(false);
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

  return (
    <div className="glass-card rounded-xl p-4 space-y-3" style={{ border: "1px solid rgba(var(--neon-purple-rgb),0.2)" }}>
      <div className="flex items-center gap-2">
        <RotateCcw className="w-4 h-4" style={{ color: "var(--neon-purple)" }} />
        <h3 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Reinstall</h3>
      </div>
      <p className="text-xs" style={{ color: "var(--text-muted)" }}>
        Re-copies the full shared cache to this server&apos;s install folder. Preserves{" "}
        <span className="font-mono">ShooterGame/Saved</span> — safe to run on a server with existing save
        data. Use this if the install looks corrupted or incomplete and Verify Files didn&apos;t resolve it.
      </p>
      {confirming ? (
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={reinstalling}
            style={{ color: "var(--text-muted)" }}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleReinstall} disabled={reinstalling}
            style={{ background: "rgba(var(--neon-purple-rgb),0.15)", borderColor: "rgba(var(--neon-purple-rgb),0.5)", color: "var(--neon-purple)" }}>
            {reinstalling ? <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />Reinstalling…</> : "Confirm Reinstall"}
          </Button>
        </div>
      ) : (
        <button
          onClick={() => setConfirming(true)}
          disabled={isRunning}
          title={isRunning ? "Stop the server before reinstalling" : undefined}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-all"
          style={{ background: "rgba(var(--neon-purple-rgb),0.08)", border: "1px solid rgba(var(--neon-purple-rgb),0.25)", color: "var(--neon-purple)", opacity: isRunning ? 0.5 : 1 }}
        >
          <RotateCcw className="w-3.5 h-3.5" />
          Reinstall Server
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Wipe Save Data card
// ---------------------------------------------------------------------------

function WipeSaveDataCard({ server }: Props) {
  const [wipeConfirm, setWipeConfirm] = useState<"map" | "players" | "full" | null>(null);
  const [wiping, setWiping] = useState(false);
  const isRunning = server.status === "running";

  const handleWipe = async (tier: "map" | "players" | "full") => {
    setWiping(true);
    const mapDef = getMapById(server.map_id);
    const saveFolder = mapDef ? getSaveFolder(mapDef) : server.map_id;
    try {
      await tauriCmd.wipeServerSaves(server.id, server.install_path, saveFolder, tier);
      setWipeConfirm(null);
      toast.success(`Save wipe complete (${tier})`);
    } catch (e) {
      toast.error(`Save wipe failed: ${e}`);
    } finally {
      setWiping(false);
    }
  };

  return (
    <div className="glass-card rounded-xl p-4 space-y-3" style={{ border: "1px solid rgba(255,0,85,0.2)" }}>
      <div className="flex items-center gap-2">
        <X className="w-4 h-4" style={{ color: "var(--neon-red)" }} />
        <h3 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Wipe Save Data</h3>
      </div>
      <p className="text-xs" style={{ color: "var(--text-muted)" }}>
        Permanently delete save files. This cannot be undone. Take a backup first.
      </p>

      {isRunning ? (
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>Stop the server before wiping save data.</p>
      ) : wipeConfirm ? (
        <div className="space-y-3 rounded-lg p-3" style={{ background: "rgba(255,0,85,0.06)", border: "1px solid rgba(255,0,85,0.3)" }}>
          <p className="text-sm font-medium" style={{ color: "var(--neon-red)" }}>
            {wipeConfirm === "map" && "Wipe Map Data — this will delete all world state (*.ark). Character and tribe data will be preserved."}
            {wipeConfirm === "players" && "Wipe Player & Tribe Data — this will delete all character profiles and tribe records. World state will be preserved."}
            {wipeConfirm === "full" && "Full Wipe — this will delete ALL save data including world, characters, tribes, and mod data. This is irreversible."}
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setWipeConfirm(null)} disabled={wiping}
              style={{ color: "var(--text-muted)" }}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => handleWipe(wipeConfirm)} disabled={wiping}
              style={{ background: "rgba(255,0,85,0.15)", borderColor: "rgba(255,0,85,0.5)", color: "var(--neon-red)" }}>
              {wiping ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <X className="w-3.5 h-3.5 mr-1.5" />}
              Confirm Wipe
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => setWipeConfirm("map")}
            className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
            style={{ background: "rgba(255,0,85,0.06)", color: "rgba(255,0,85,0.8)", border: "1px solid rgba(255,0,85,0.25)" }}
          >
            Map Wipe
          </button>
          <button
            onClick={() => setWipeConfirm("players")}
            className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
            style={{ background: "rgba(255,0,85,0.06)", color: "rgba(255,0,85,0.8)", border: "1px solid rgba(255,0,85,0.25)" }}
          >
            Player & Tribe Reset
          </button>
          <button
            onClick={() => setWipeConfirm("full")}
            className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
            style={{ background: "rgba(255,0,85,0.12)", color: "var(--neon-red)", border: "1px solid rgba(255,0,85,0.4)" }}
          >
            Full Wipe
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Import Saves card
// ---------------------------------------------------------------------------

function ImportSavesCard({ server }: Props) {
  const [showImport, setShowImport] = useState(false);
  const [importSourceId, setImportSourceId] = useState("");
  const [importing, setImporting] = useState(false);
  const [importServers, setImportServers] = useState<ServerRow[]>([]);
  const isRunning = server.status === "running";

  const openImportDialog = async () => {
    const all = await getServers();
    setImportServers(all.filter((s) => s.id !== server.id && s.status === "stopped" && s.map_id === server.map_id));
    setImportSourceId("");
    setShowImport(true);
  };

  const handleImport = async () => {
    if (!importSourceId) return;
    setImporting(true);
    try {
      const baseDir = await getAppSetting("base_dir");
      if (!baseDir) throw new Error("Base directory not configured");
      const mapDef = getMapById(server.map_id);
      const saveFolder = mapDef ? getSaveFolder(mapDef) : server.map_id;
      await tauriCmd.importServerSaves(importSourceId, server.id, baseDir, saveFolder);
      setShowImport(false);
      toast.success("Save data imported successfully");
    } catch (e) {
      toast.error(`Import failed: ${e}`);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="glass-card rounded-xl p-4 space-y-3" style={{ border: "1px solid rgba(var(--neon-purple-rgb),0.2)" }}>
      <div className="flex items-center gap-2">
        <Save className="w-4 h-4" style={{ color: "var(--neon-purple)" }} />
        <h3 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Import Saves</h3>
      </div>
      <p className="text-xs" style={{ color: "var(--text-muted)" }}>
        Copy the current map&apos;s save data from another stopped server into this one. Existing saves will be replaced.
      </p>
      <button
        onClick={openImportDialog}
        disabled={isRunning}
        title={isRunning ? "Stop the server before importing" : undefined}
        className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
        style={{ background: "rgba(var(--neon-purple-rgb),0.08)", color: "var(--neon-purple)", border: "1px solid rgba(var(--neon-purple-rgb),0.25)", opacity: isRunning ? 0.5 : 1 }}
      >
        Import from Another Server…
      </button>

      <Dialog open={showImport} onOpenChange={(v) => !v && setShowImport(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Import Save Data</DialogTitle>
            <DialogDescription>
              Select a stopped server to copy its <strong>{getMapById(server.map_id)?.mapPath ?? server.map_id}</strong> save
              folder into <strong>{server.name}</strong>. Only stopped servers with the same map are shown.
              Existing saves will be overwritten.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 mt-1">
            {importServers.length === 0 ? (
              <p className="text-sm" style={{ color: "var(--text-muted)" }}>
                No other stopped servers found. Stop the source server before importing.
              </p>
            ) : (
              <Select value={importSourceId} onValueChange={setImportSourceId}>
                <SelectTrigger style={{ background: "var(--surface)", borderColor: "rgba(var(--neon-purple-rgb),0.3)", color: "var(--text-primary)" }}>
                  <SelectValue placeholder="Select source server…" />
                </SelectTrigger>
                <SelectContent>
                  {importServers.map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <DialogFooter className="gap-2 mt-2">
            <Button variant="outline" onClick={() => setShowImport(false)} disabled={importing}>Cancel</Button>
            <Button
              disabled={importing || !importSourceId}
              onClick={handleImport}
              style={{ background: "rgba(var(--neon-purple-rgb),0.15)", borderColor: "rgba(var(--neon-purple-rgb),0.5)", color: "var(--neon-purple)" }}
            >
              {importing ? <><Loader2 className="w-3 h-3 animate-spin mr-1.5" />Importing…</> : "Import Saves"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MaintenanceTab
// ---------------------------------------------------------------------------

export function MaintenanceTab({ server }: Props) {
  return (
    <div className="flex flex-col gap-4 pr-6">
      <VerifyFilesCard server={server} />
      <ReinstallCard server={server} />
      <WipeSaveDataCard server={server} />
      <ImportSavesCard server={server} />
    </div>
  );
}
