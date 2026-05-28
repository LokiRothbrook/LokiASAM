"use client";

/**
 * SetupWizard — first-time setup wizard rendered as a full-screen overlay.
 *
 * Steps (Linux):
 *   0 - Welcome
 *   1 - Install Dir  (+ Import previous install tab)
 *   2 - Backup Dir
 *   3 - SteamCMD
 *   4 - Proton-GE
 *   5 - Notifications
 *   6 - System Tray
 *   7 - Complete
 *
 * Steps (Windows): same minus Proton-GE (step 4).
 *
 * On completion, writes settings to SQLite and calls onComplete(closeToTray).
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { motion, AnimatePresence } from "framer-motion";
import {
  FolderOpen, HardDrive, Terminal, Bell, CheckCircle2, ArrowRight, ArrowLeft,
  Loader2, AlertCircle, HardDrive as DiskIcon, Cpu, RefreshCw, Download,
  MonitorDown, ToggleLeft, ToggleRight, Layers, Send, StopCircle,
} from "lucide-react";
import { toast } from "sonner";
import { LokiIcon } from "@/components/shared/LokiIcon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CommandOutputPanel } from "@/components/shared/CommandOutputPanel";
import { Switch } from "@/components/ui/switch";
import { useSetupStore } from "@/store/useSetupStore";
import { tauriCmd, type DirCheckResult, type ProtonEntry } from "@/lib/tauri-commands";
import { setAppSetting, initDb } from "@/lib/db";
import { NotificationMatrix } from "@/components/shared/NotificationMatrix";
import { open } from "@tauri-apps/plugin-dialog";
import { homeDir } from "@tauri-apps/api/path";
import { getVersion } from "@tauri-apps/api/app";

interface SetupWizardProps {
  onComplete: (closeToTray: boolean) => void;
}

const IS_LINUX =
  typeof navigator !== "undefined" && !navigator.userAgent.includes("Windows");

const STEPS_WIN = [
  { label: "Welcome",       icon: LokiIcon },
  { label: "Install Dir",   icon: HardDrive },
  { label: "Backup Dir",    icon: FolderOpen },
  { label: "SteamCMD",      icon: Terminal },
  { label: "Notifications", icon: Bell },
  { label: "System Tray",   icon: Layers },
  { label: "Updates",       icon: RefreshCw },
  { label: "Complete",      icon: CheckCircle2 },
];

const STEPS_LINUX = [
  { label: "Welcome",       icon: LokiIcon },
  { label: "Install Dir",   icon: HardDrive },
  { label: "Backup Dir",    icon: FolderOpen },
  { label: "SteamCMD",      icon: Terminal },
  { label: "Proton-GE",     icon: Cpu },
  { label: "Notifications", icon: Bell },
  { label: "System Tray",   icon: Layers },
  { label: "Updates",       icon: RefreshCw },
  { label: "Complete",      icon: CheckCircle2 },
];

const STEPS = IS_LINUX ? STEPS_LINUX : STEPS_WIN;
const TOTAL_STEPS = STEPS.length;

// ---------------------------------------------------------------------------
// Step variants for Framer Motion slide animation
// ---------------------------------------------------------------------------
const stepVariants = {
  enter:  (dir: number) => ({ x: dir > 0 ? 60 : -60, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit:   (dir: number) => ({ x: dir > 0 ? -60 : 60, opacity: 0 }),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const gb = bytes / 1073741824;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / 1048576).toFixed(0)} MB`;
}

function DirValidationRow({ result }: { result: DirCheckResult }) {
  const GB_25 = 26843545600;
  const GB_50 = 53687091200;
  const spaceColor =
    result.freeBytes < GB_25 ? "#ff3c3c" : result.freeBytes < GB_50 ? "#ffaa00" : "var(--neon-green)";
  return (
    <div className="space-y-1">
      {result.writable ? (
        <p className="text-xs flex items-center gap-1.5" style={{ color: "var(--neon-green)" }}>
          <CheckCircle2 className="w-3 h-3" /> Location is writable
        </p>
      ) : (
        <p className="text-xs flex items-center gap-1.5" style={{ color: "#ff3c3c" }}>
          <AlertCircle className="w-3 h-3" /> {result.error ?? "Not writable"}
        </p>
      )}
      {result.writable && result.freeBytes > 0 && (
        <p className="text-xs flex items-center gap-1.5" style={{ color: spaceColor }}>
          <DiskIcon className="w-3 h-3" />
          {formatBytes(result.freeBytes)} free
          {result.freeBytes < GB_25 && " — low disk space! Each ASA server needs 15–25 GB."}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components per step
// ---------------------------------------------------------------------------

function WelcomeStep() {
  return (
    <div className="flex flex-col items-center text-center gap-6">
      <div className="relative">
        <div
          className="w-24 h-24 rounded-2xl flex items-center justify-center"
          style={{
            background: "rgba(191,0,255,0.1)",
            border: "1px solid rgba(191,0,255,0.3)",
            boxShadow: "0 0 40px rgba(191,0,255,0.2)",
          }}
        >
          <LokiIcon size={48} style={{ filter: "drop-shadow(0 0 6px var(--neon-purple))" }} />
        </div>
      </div>

      <div className="space-y-2">
        <h1 className="text-3xl font-bold text-glow-purple" style={{ color: "var(--neon-purple)" }}>
          LokiASAM
        </h1>
        <p className="text-lg" style={{ color: "var(--text-primary)" }}>
          Ark Survival Ascended Server Manager
        </p>
        <p className="text-sm max-w-md" style={{ color: "var(--text-muted)" }}>
          Manage multiple ASA dedicated servers from one powerful interface.
          Start, stop, configure, mod, and schedule — all in one place.
        </p>
      </div>

      <div className="grid grid-cols-3 gap-3 w-full max-w-sm">
        {[
          { label: "Server Management", desc: "Start, stop & monitor" },
          { label: "Auto Scheduling",   desc: "Backups & restarts" },
          { label: "Mod Browser",       desc: "CurseForge integration" },
        ].map((feat) => (
          <div
            key={feat.label}
            className="rounded-lg p-3 text-center"
            style={{
              background: "rgba(191,0,255,0.05)",
              border: "1px solid rgba(191,0,255,0.15)",
            }}
          >
            <p className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>{feat.label}</p>
            <p className="text-[10px] mt-1" style={{ color: "var(--text-muted)" }}>{feat.desc}</p>
          </div>
        ))}
      </div>

      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
        Let&apos;s get you set up. This will only take a minute.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// ImportVerifyPanel — shown after the import DB check passes
// Shows missing tool inline install options.
// ---------------------------------------------------------------------------

function ImportVerifyPanel({
  info,
  importDir,
}: {
  info: { servers: number; steamcmd: string; proton?: string; steamcmdMissing?: boolean; protonMissing?: boolean };
  importDir: string;
}) {
  const { setSteamcmdPath, setSteamcmdValidated, setProtonPath, setProtonValidated } = useSetupStore();
  const [installingSteamcmd, setInstallingSteamcmd] = useState(false);
  const [steamcmdDone, setSteamcmdDone]             = useState(false);
  const [installingProton, setInstallingProton]     = useState(false);
  const [protonDone, setProtonDone]                 = useState(false);

  const handleInstallSteamcmd = async () => {
    const sep = importDir.includes("\\") ? "\\" : "/";
    const targetDir = importDir.replace(/[/\\]$/, "") + sep + "steamcmd";
    setInstallingSteamcmd(true);
    try {
      await tauriCmd.installSteamcmd(targetDir);
      const exePath = targetDir + (navigator.userAgent.includes("Windows") ? sep + "steamcmd.exe" : sep + "steamcmd.sh");
      setSteamcmdPath(exePath);
      setSteamcmdValidated(true);
      setSteamcmdDone(true);
    } catch (e) {
      if (!String(e).includes("Aborted")) toast.error(`SteamCMD install failed: ${e}`);
    } finally { setInstallingSteamcmd(false); }
  };

  const handlePointSteamcmd = async () => {
    try {
      const selected = await open({ multiple: false, title: "Select SteamCMD Executable" });
      if (typeof selected === "string" && selected) {
        setSteamcmdPath(selected);
        setSteamcmdValidated(true);
        setSteamcmdDone(true);
      }
    } catch {/* */}
  };

  const handleDownloadProton = async () => {
    const sep = importDir.includes("\\") ? "\\" : "/";
    const targetDir = importDir.replace(/[/\\]$/, "") + sep + "proton";
    setInstallingProton(true);
    try {
      const path = await tauriCmd.downloadProtonGe(targetDir);
      setProtonPath(path);
      setProtonValidated(true);
      setProtonDone(true);
    } catch (e) {
      if (!String(e).includes("Aborted")) toast.error(`Proton-GE download failed: ${e}`);
    } finally { setInstallingProton(false); }
  };

  const handlePointProton = async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: "Select Proton-GE Directory" });
      if (typeof selected === "string" && selected) {
        setProtonPath(selected);
        setProtonValidated(true);
        setProtonDone(true);
      }
    } catch {/* */}
  };

  const allGood = !info.steamcmdMissing || steamcmdDone;
  const protonAllGood = !info.protonMissing || protonDone;

  return (
    <div className="rounded-lg p-4 space-y-3"
      style={{ background: "rgba(0,255,136,0.05)", border: `1px solid ${allGood && protonAllGood ? "rgba(0,255,136,0.2)" : "rgba(255,136,0,0.3)"}` }}>
      <p className="text-xs font-semibold" style={{ color: "var(--neon-green)" }}>Found in database:</p>
      <p className="text-xs" style={{ color: "var(--text-muted)" }}>
        <span style={{ color: "var(--text-primary)" }}>{info.servers}</span> server{info.servers !== 1 ? "s" : ""} registered
      </p>

      {/* SteamCMD row */}
      {info.steamcmdMissing && !steamcmdDone ? (
        <div className="rounded-lg p-3 space-y-2" style={{ background: "rgba(255,136,0,0.08)", border: "1px solid rgba(255,136,0,0.25)" }}>
          <p className="text-xs font-medium" style={{ color: "var(--neon-orange)" }}>
            SteamCMD not found at previous path
          </p>
          <p className="text-xs font-mono truncate" style={{ color: "var(--text-muted)" }}>{info.steamcmd}</p>
          <div className="flex gap-2 flex-wrap">
            <Button onClick={handleInstallSteamcmd} disabled={installingSteamcmd} size="sm" className="gap-1.5 h-7 text-xs"
              style={{ background: "rgba(191,0,255,0.12)", border: "1px solid rgba(191,0,255,0.35)", color: "var(--neon-purple)" }}>
              {installingSteamcmd ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
              Install Now
            </Button>
            {installingSteamcmd && (
              <Button onClick={() => tauriCmd.abortOperation("steamcmd_install")} size="sm" variant="ghost" className="gap-1 h-7 text-xs"
                style={{ color: "var(--neon-red)", border: "1px solid rgba(255,0,85,0.3)" }}>
                <StopCircle className="w-3 h-3" /> Cancel Install
              </Button>
            )}
            {!installingSteamcmd && (
              <Button onClick={handlePointSteamcmd} size="sm" variant="ghost" className="gap-1.5 h-7 text-xs"
                style={{ color: "var(--text-muted)", border: "1px solid var(--border)" }}>
                <FolderOpen className="w-3 h-3" /> Point to Existing
              </Button>
            )}
          </div>
          {installingSteamcmd && (
            <CommandOutputPanel eventChannel="steamcmd://output/setup" label="Downloading SteamCMD" completed={false} bodyClassName="h-28" />
          )}
        </div>
      ) : (
        <p className="text-xs font-mono truncate" style={{ color: "var(--text-muted)" }}>
          SteamCMD: <span style={{ color: steamcmdDone ? "var(--neon-green)" : "var(--text-primary)" }}>{steamcmdDone ? "✓ Installed" : info.steamcmd}</span>
        </p>
      )}

      {/* Proton-GE row (Linux only) */}
      {info.protonMissing && !protonDone ? (
        <div className="rounded-lg p-3 space-y-2" style={{ background: "rgba(255,136,0,0.08)", border: "1px solid rgba(255,136,0,0.25)" }}>
          <p className="text-xs font-medium" style={{ color: "var(--neon-orange)" }}>
            Proton-GE not found at previous path
          </p>
          {info.proton && <p className="text-xs font-mono truncate" style={{ color: "var(--text-muted)" }}>{info.proton}</p>}
          <div className="flex gap-2 flex-wrap">
            <Button onClick={handleDownloadProton} disabled={installingProton} size="sm" className="gap-1.5 h-7 text-xs"
              style={{ background: "rgba(191,0,255,0.12)", border: "1px solid rgba(191,0,255,0.35)", color: "var(--neon-purple)" }}>
              {installingProton ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
              Download Now
            </Button>
            {installingProton && (
              <Button onClick={() => tauriCmd.abortOperation("proton_download")} size="sm" variant="ghost" className="gap-1 h-7 text-xs"
                style={{ color: "var(--neon-red)", border: "1px solid rgba(255,0,85,0.3)" }}>
                <StopCircle className="w-3 h-3" /> Cancel Install
              </Button>
            )}
            {!installingProton && (
              <Button onClick={handlePointProton} size="sm" variant="ghost" className="gap-1.5 h-7 text-xs"
                style={{ color: "var(--text-muted)", border: "1px solid var(--border)" }}>
                <FolderOpen className="w-3 h-3" /> Point to Existing
              </Button>
            )}
          </div>
          {installingProton && (
            <CommandOutputPanel eventChannel="proton://output/download" label="Downloading Proton-GE" completed={false} bodyClassName="h-28" />
          )}
        </div>
      ) : info.proton ? (
        <p className="text-xs font-mono truncate" style={{ color: "var(--text-muted)" }}>
          Proton-GE: <span style={{ color: protonDone ? "var(--neon-green)" : "var(--text-primary)" }}>{protonDone ? "✓ Installed" : info.proton}</span>
        </p>
      ) : null}

      {allGood && protonAllGood && (
        <p className="text-xs mt-1" style={{ color: "var(--neon-green)" }}>
          ✓ Click &quot;Import &amp; Finish&quot; below to continue.
        </p>
      )}
    </div>
  );
}

// BaseDirStep — includes "Import previous install" tab
// ---------------------------------------------------------------------------

function BaseDirStep() {
  const {
    baseDir, setBaseDir, setBackupDir, setBaseDirWritable,
    importMode, setImportMode, importDir, setImportDir, importValid, setImportValid,
  } = useSetupStore();
  const [dirResult, setDirResult] = useState<DirCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [importChecking, setImportChecking] = useState(false);
  const [importError, setImportError] = useState("");
  const [importInfo, setImportInfo] = useState<{
    servers: number; steamcmd: string; proton?: string;
    steamcmdMissing?: boolean; protonMissing?: boolean;
  } | null>(null);

  const validateDir = useCallback(async (path: string) => {
    if (!path.trim()) return;
    setChecking(true);
    setDirResult(null);
    try {
      const result = await tauriCmd.checkDir(path);
      setDirResult(result);
      setBaseDirWritable(result.writable);
    } catch {
      const fallback: DirCheckResult = { writable: false, freeBytes: 0, error: "Could not check directory." };
      setDirResult(fallback);
      setBaseDirWritable(false);
    } finally {
      setChecking(false);
    }
  }, [setBaseDirWritable]);

  // Auto-fill with platform default on mount
  useEffect(() => {
    (async () => {
      try {
        const home = await homeDir();
        const sep = home.includes("\\") ? "\\" : "/";
        const defaultDir = home.replace(/[/\\]$/, "") + sep + "LokiASAM";
        setBaseDir(defaultDir);
        setBackupDir(defaultDir + sep + "Backups");
        await validateDir(defaultDir);
      } catch {
        // Outside Tauri (dev preview) — leave blank
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleChange = (value: string) => {
    setBaseDir(value);
    const sep = value.includes("\\") ? "\\" : "/";
    setBackupDir(value.replace(/[/\\]$/, "") + sep + "Backups");
    setDirResult(null);
    setBaseDirWritable(false);
  };

  const pickDir = async () => {
    const selected = await open({ directory: true, multiple: false, title: "Select LokiASAM Installation Directory" });
    if (typeof selected === "string" && selected) {
      handleChange(selected);
      await validateDir(selected);
    }
  };

  const pickImportDir = async () => {
    const selected = await open({ directory: true, multiple: false, title: "Select Previous LokiASAM Base Directory" });
    if (typeof selected === "string" && selected) {
      setImportDir(selected);
      setImportValid(false);
      setImportInfo(null);
      setImportError("");
    }
  };

  const validateImport = async () => {
    if (!importDir.trim()) { setImportError("Select a directory first."); return; }
    setImportChecking(true);
    setImportError("");
    setImportValid(false);
    setImportInfo(null);
    try {
      const sep = importDir.includes("\\") ? "\\" : "/";
      const dbPath = importDir.replace(/[/\\]$/, "") + sep + "lokiasam" + sep + "lokiasam.db";
      const exists = await tauriCmd.checkFileExists(dbPath);
      if (!exists) {
        setImportError("No LokiASAM database found in that directory. Make sure you selected the correct base folder.");
        return;
      }
      // Open the DB briefly to count servers and read paths.
      await initDb(dbPath);
      const { getAppSetting: getSetting, getServers } = await import("@/lib/db");
      const [servers, steamcmdPath, protonPath] = await Promise.all([
        getServers(),
        getSetting("steamcmd_path"),
        getSetting("proton_path"),
      ]);
      const [steamcmdExists, protonExists] = await Promise.all([
        steamcmdPath ? tauriCmd.checkFileExists(steamcmdPath) : Promise.resolve(false),
        protonPath   ? tauriCmd.checkFileExists(protonPath)   : Promise.resolve(false),
      ]);
      setImportInfo({
        servers: servers.length,
        steamcmd: steamcmdPath ?? "(not set)",
        proton: protonPath ?? undefined,
        steamcmdMissing: !steamcmdPath || !steamcmdExists,
        protonMissing: typeof window !== "undefined" && !navigator.userAgent.includes("Windows") && (!protonPath || !protonExists),
      });
      setImportValid(true);
    } catch (e) {
      setImportError(`Failed to read database: ${e}`);
    } finally {
      setImportChecking(false);
    }
  };

  const borderColor = dirResult
    ? dirResult.writable ? "rgba(0,255,136,0.5)" : "rgba(255,60,60,0.5)"
    : baseDir ? "rgba(191,0,255,0.4)" : "rgba(191,0,255,0.2)";

  return (
    <div className="space-y-5">
      {/* Tab selector */}
      <div className="flex gap-2">
        {[
          { key: false, label: "New Install",           icon: Download },
          { key: true,  label: "Import Previous Install", icon: MonitorDown },
        ].map(({ key, label, icon: Icon }) => (
          <button
            key={String(key)}
            onClick={() => { setImportMode(key); setImportError(""); }}
            className="flex-1 flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-all"
            style={{
              background: importMode === key ? "rgba(191,0,255,0.12)" : "rgba(10,10,30,0.5)",
              border: `1px solid ${importMode === key ? "rgba(191,0,255,0.5)" : "rgba(191,0,255,0.15)"}`,
              color: importMode === key ? "var(--neon-purple)" : "var(--text-muted)",
            }}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </div>

      {/* ── New Install ── */}
      {!importMode && (
        <>
          <div>
            <h2 className="text-xl font-bold mb-1 text-glow-purple" style={{ color: "var(--neon-purple)" }}>
              Where would you like to install LokiASAM?
            </h2>
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>
              This is where your ASA server files will be installed. Choose a drive with at least 20 GB of free space.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="base-dir" style={{ color: "var(--text-primary)" }}>Directory Path</Label>
            <div className="flex gap-2">
              <Input
                id="base-dir"
                value={baseDir}
                onChange={(e) => handleChange(e.target.value)}
                onBlur={() => validateDir(baseDir)}
                placeholder="/home/user/LokiASAM"
                className="flex-1 font-mono text-sm"
                style={{ background: "rgba(10,10,30,0.8)", borderColor, color: "var(--text-primary)" }}
              />
              <Button
                onClick={pickDir}
                variant="outline"
                className="gap-2 shrink-0"
                style={{ borderColor: "rgba(191,0,255,0.4)", color: "var(--neon-purple)", background: "rgba(191,0,255,0.05)" }}
              >
                <FolderOpen className="w-4 h-4" />
                Browse
              </Button>
            </div>
            {checking && (
              <p className="text-xs flex items-center gap-1.5" style={{ color: "var(--text-muted)" }}>
                <Loader2 className="w-3 h-3 animate-spin" /> Checking directory…
              </p>
            )}
            {dirResult && <DirValidationRow result={dirResult} />}
          </div>
        </>
      )}

      {/* ── Import Previous Install ── */}
      {importMode && (
        <>
          <div>
            <h2 className="text-xl font-bold mb-1 text-glow-purple" style={{ color: "var(--neon-purple)" }}>
              Import Previous Install
            </h2>
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>
              Point to your old LokiASAM base folder. We&apos;ll verify your database, then skip the rest of setup.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="import-dir" style={{ color: "var(--text-primary)" }}>Previous Install Directory</Label>
            <div className="flex gap-2">
              <Input
                id="import-dir"
                value={importDir}
                onChange={(e) => { setImportDir(e.target.value); setImportValid(false); setImportInfo(null); setImportError(""); }}
                placeholder="/home/user/LokiASAM"
                className="flex-1 font-mono text-sm"
                style={{
                  background: "rgba(10,10,30,0.8)",
                  borderColor: importValid ? "rgba(0,255,136,0.5)" : importDir ? "rgba(191,0,255,0.4)" : "rgba(191,0,255,0.2)",
                  color: "var(--text-primary)",
                }}
              />
              <Button
                onClick={pickImportDir}
                variant="outline"
                className="gap-2 shrink-0"
                style={{ borderColor: "rgba(191,0,255,0.4)", color: "var(--neon-purple)", background: "rgba(191,0,255,0.05)" }}
              >
                <FolderOpen className="w-4 h-4" />
                Browse
              </Button>
            </div>

            <Button
              onClick={validateImport}
              disabled={!importDir.trim() || importChecking || importValid}
              size="sm"
              className="gap-2"
              style={{
                background: importValid ? "rgba(0,255,136,0.08)" : "rgba(191,0,255,0.08)",
                border: `1px solid ${importValid ? "rgba(0,255,136,0.4)" : "rgba(191,0,255,0.3)"}`,
                color: importValid ? "var(--neon-green)" : "var(--neon-purple)",
              }}
            >
              {importChecking ? (
                <><Loader2 className="w-3 h-3 animate-spin" /> Checking…</>
              ) : importValid ? (
                <><CheckCircle2 className="w-3 h-3" /> Verified</>
              ) : (
                "Verify Directory"
              )}
            </Button>

            {importError && (
              <p className="text-xs flex items-center gap-1.5" style={{ color: "#ff3c3c" }}>
                <AlertCircle className="w-3 h-3 shrink-0" /> {importError}
              </p>
            )}
          </div>

          {importInfo && (
            <ImportVerifyPanel info={importInfo} importDir={importDir} />
          )}
        </>
      )}
    </div>
  );
}

function BackupDirStep() {
  const { backupDir, setBackupDir, setBackupDirWritable } = useSetupStore();
  const [dirResult, setDirResult] = useState<DirCheckResult | null>(null);
  const [checking, setChecking] = useState(false);

  const validateDir = useCallback(async (path: string) => {
    if (!path.trim()) return;
    setChecking(true);
    setDirResult(null);
    try {
      const result = await tauriCmd.checkDir(path);
      setDirResult(result);
      setBackupDirWritable(result.writable);
    } catch {
      const fallback: DirCheckResult = { writable: false, freeBytes: 0, error: "Could not check directory." };
      setDirResult(fallback);
      setBackupDirWritable(false);
    } finally {
      setChecking(false);
    }
  }, [setBackupDirWritable]);

  useEffect(() => {
    if (backupDir) validateDir(backupDir);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleChange = (value: string) => {
    setBackupDir(value);
    setDirResult(null);
    setBackupDirWritable(false);
  };

  const pickDir = async () => {
    const selected = await open({ directory: true, multiple: false, title: "Select Backup Storage Directory" });
    if (typeof selected === "string" && selected) {
      handleChange(selected);
      await validateDir(selected);
    }
  };

  const borderColor = dirResult
    ? dirResult.writable ? "rgba(0,255,136,0.5)" : "rgba(255,60,60,0.5)"
    : backupDir ? "rgba(191,0,255,0.4)" : "rgba(191,0,255,0.2)";

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold mb-1 text-glow-purple" style={{ color: "var(--neon-purple)" }}>
          Where would you like to save backups?
        </h2>
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          This is where Server, INI and other backup ZIP archives will be stored.
          We&apos;ve pre-filled this based on your install directory.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="backup-dir" style={{ color: "var(--text-primary)" }}>Backup Path</Label>
        <div className="flex gap-2">
          <Input
            id="backup-dir"
            value={backupDir}
            onChange={(e) => handleChange(e.target.value)}
            onBlur={() => validateDir(backupDir)}
            placeholder="/home/user/LokiASAM/Backups"
            className="flex-1 font-mono text-sm"
            style={{ background: "rgba(10,10,30,0.8)", borderColor, color: "var(--text-primary)" }}
          />
          <Button
            onClick={pickDir}
            variant="outline"
            className="gap-2 shrink-0"
            style={{ borderColor: "rgba(191,0,255,0.4)", color: "var(--neon-purple)", background: "rgba(191,0,255,0.05)" }}
          >
            <FolderOpen className="w-4 h-4" />
            Browse
          </Button>
        </div>
        {checking && (
          <p className="text-xs flex items-center gap-1.5" style={{ color: "var(--text-muted)" }}>
            <Loader2 className="w-3 h-3 animate-spin" /> Checking directory…
          </p>
        )}
        {dirResult && <DirValidationRow result={dirResult} />}
      </div>

      <div
        className="rounded-lg p-4"
        style={{ background: "rgba(0,255,136,0.05)", border: "1px solid rgba(0,255,136,0.15)" }}
      >
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          <span className="font-semibold" style={{ color: "var(--neon-green)" }}>Tip: </span>
          Pointing backups to a separate drive protects you if your main drive fails.
          Backups are ZIP files and can be large (5–30 GB per server).
        </p>
      </div>
    </div>
  );
}

function SteamCmdStep() {
  const {
    baseDir,
    steamcmdMode, setSteamcmdMode,
    steamcmdPath, setSteamcmdPath,
    steamcmdValidated, setSteamcmdValidated,
    isLoading, setLoading,
  } = useSetupStore();
  const [error, setError] = useState("");
  const [outputChannel, setOutputChannel] = useState<"install" | "validate" | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [canceled, setCanceled] = useState(false);

  const autoSteamcmdTarget = baseDir
    ? baseDir.replace(/\/$/, "").replace(/\\$/, "") + "/steamcmd"
    : "/your/base/dir/steamcmd";

  const autoExePath = autoSteamcmdTarget +
    (typeof window !== "undefined" && navigator.userAgent.includes("Windows") ? "\\steamcmd.exe" : "/steamcmd.sh");

  const handleAutoDownload = async () => {
    setError("");
    setCanceled(false);
    setAttempt((a) => a + 1);
    setSteamcmdValidated(false);
    setLoading(true, "Checking for existing SteamCMD...");

    const doInstallAndValidate = async () => {
      setLoading(true, "Downloading SteamCMD...");
      setOutputChannel("install");
      await tauriCmd.installSteamcmd(autoSteamcmdTarget);
      setLoading(true, "Validating SteamCMD...");
      setOutputChannel("validate");
      return tauriCmd.validateSteamcmd(autoExePath);
    };

    try {
      const alreadyExists = await tauriCmd.checkFileExists(autoExePath);
      if (alreadyExists) {
        setLoading(true, "Found existing SteamCMD, validating...");
        setOutputChannel("validate");
        const ok = await tauriCmd.validateSteamcmd(autoExePath);
        if (ok) {
          setSteamcmdPath(autoExePath);
          setSteamcmdValidated(true);
          return;
        }
        setError("");
      }

      const ok = await doInstallAndValidate();
      if (ok) {
        setSteamcmdPath(autoExePath);
        setSteamcmdValidated(true);
      } else {
        setError("SteamCMD validation failed. Check output above for details.");
      }
    } catch (err) {
      const msg = String(err);
      if (msg === "Aborted") {
        setCanceled(true);
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleManualValidate = async () => {
    if (!steamcmdPath) { setError("Enter the path to your SteamCMD executable."); return; }
    setError("");
    setSteamcmdValidated(false);
    setLoading(true, "Validating SteamCMD...");
    setOutputChannel("validate");
    try {
      const ok = await tauriCmd.validateSteamcmd(steamcmdPath);
      if (ok) {
        setSteamcmdValidated(true);
      } else {
        setError("SteamCMD validation failed. Make sure the path is correct.");
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const pickExe = async () => {
    const selected = await open({
      multiple: false,
      title: "Select SteamCMD Executable",
      filters: [{ name: "SteamCMD", extensions: ["exe", "sh", "*"] }],
    });
    if (typeof selected === "string" && selected) {
      setSteamcmdPath(selected);
      setSteamcmdValidated(false);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-bold mb-1 text-glow-purple" style={{ color: "var(--neon-purple)" }}>
          SteamCMD Setup
        </h2>
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          SteamCMD is required to download and update ASA server files from Steam.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {[
          { mode: "auto" as const, label: "Auto-Download", desc: `Download into ${autoSteamcmdTarget}` },
          { mode: "manual" as const, label: "I have SteamCMD", desc: "Point to an existing install" },
        ].map(({ mode, label, desc }) => (
          <button
            key={mode}
            onClick={() => { if (!isLoading && !steamcmdValidated) { setSteamcmdMode(mode); setSteamcmdValidated(false); setError(""); } }}
            disabled={isLoading || steamcmdValidated}
            className="rounded-lg p-4 text-left transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            style={{
              background: steamcmdMode === mode ? "rgba(191,0,255,0.1)" : "rgba(10,10,30,0.5)",
              border: `1px solid ${steamcmdMode === mode ? "rgba(191,0,255,0.5)" : "rgba(191,0,255,0.15)"}`,
              boxShadow: steamcmdMode === mode ? "0 0 16px rgba(191,0,255,0.15)" : "none",
            }}
          >
            <p className="text-sm font-semibold" style={{ color: steamcmdMode === mode ? "var(--neon-purple)" : "var(--text-primary)" }}>
              {label}
            </p>
            <p className="text-xs mt-1 font-mono" style={{ color: "var(--text-muted)" }}>{desc}</p>
          </button>
        ))}
      </div>

      {steamcmdMode === "auto" && (
        <div className="space-y-2">
          <Button
            onClick={handleAutoDownload}
            disabled={isLoading || !baseDir || steamcmdValidated}
            className="w-full gap-2"
            style={{
              background: steamcmdValidated ? "rgba(0,255,136,0.1)" : "rgba(191,0,255,0.15)",
              border: `1px solid ${steamcmdValidated ? "rgba(0,255,136,0.4)" : "rgba(191,0,255,0.4)"}`,
              color: steamcmdValidated ? "var(--neon-green)" : "var(--neon-purple)",
            }}
          >
            {isLoading ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Downloading…</>
            ) : steamcmdValidated ? (
              <><CheckCircle2 className="w-4 h-4" /> SteamCMD Ready</>
            ) : (
              <><Terminal className="w-4 h-4" /> Download &amp; Validate SteamCMD</>
            )}
          </Button>
          {isLoading && outputChannel !== null && (
            <Button
              onClick={async () => { await tauriCmd.abortOperation("steamcmd_install"); }}
              size="sm" variant="ghost" className="w-full gap-1.5"
              style={{ color: "var(--neon-red)", border: "1px solid rgba(255,0,85,0.3)" }}>
              <StopCircle className="w-3 h-3" /> Cancel Install
            </Button>
          )}
        </div>
      )}

      {steamcmdMode === "manual" && (
        <div className="space-y-3">
          <div className="flex gap-2">
            <Input
              value={steamcmdPath}
              onChange={(e) => { setSteamcmdPath(e.target.value); setSteamcmdValidated(false); }}
              placeholder="/path/to/steamcmd.sh"
              className="flex-1 font-mono text-sm"
              style={{
                background: "rgba(10,10,30,0.8)",
                borderColor: steamcmdValidated ? "rgba(0,255,136,0.4)" : "rgba(191,0,255,0.2)",
                color: "var(--text-primary)",
              }}
            />
            <Button
              onClick={pickExe}
              variant="outline"
              className="gap-2 shrink-0"
              style={{ borderColor: "rgba(191,0,255,0.4)", color: "var(--neon-purple)", background: "rgba(191,0,255,0.05)" }}
            >
              <FolderOpen className="w-4 h-4" /> Browse
            </Button>
          </div>
          <Button
            onClick={handleManualValidate}
            disabled={isLoading || !steamcmdPath || steamcmdValidated}
            className="w-full gap-2"
            style={{
              background: steamcmdValidated ? "rgba(0,255,136,0.1)" : "rgba(191,0,255,0.15)",
              border: `1px solid ${steamcmdValidated ? "rgba(0,255,136,0.4)" : "rgba(191,0,255,0.4)"}`,
              color: steamcmdValidated ? "var(--neon-green)" : "var(--neon-purple)",
            }}
          >
            {isLoading ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Validating…</>
            ) : steamcmdValidated ? (
              <><CheckCircle2 className="w-4 h-4" /> SteamCMD Validated</>
            ) : (
              "Validate SteamCMD"
            )}
          </Button>
        </div>
      )}

      {outputChannel && (
        <CommandOutputPanel
          key={attempt}
          eventChannel={outputChannel === "install" ? "steamcmd://output/setup" : "steamcmd://output/validate"}
          label={outputChannel === "install" ? "Downloading SteamCMD" : "Validating SteamCMD"}
          completed={!isLoading}
          canceled={canceled}
          className="mt-2"
        />
      )}

      {canceled && !isLoading && (
        <Button
          onClick={handleAutoDownload}
          variant="outline" size="sm" className="gap-1.5"
          style={{ borderColor: "rgba(191,0,255,0.4)", color: "var(--neon-purple)" }}
        >
          <RefreshCw className="w-3 h-3" /> Reinstall SteamCMD
        </Button>
      )}

      {error && (
        <p className="text-xs flex items-center gap-1.5" style={{ color: "var(--neon-red)" }}>
          <AlertCircle className="w-3.5 h-3.5 shrink-0" /> {error}
        </p>
      )}
    </div>
  );
}

function ProtonGEStep() {
  const {
    baseDir,
    protonMode, setProtonMode,
    protonPath, setProtonPath,
    protonValidated, setProtonValidated,
    isLoading, setLoading,
  } = useSetupStore();

  const [scanning, setScanning] = useState(false);
  const [found, setFound] = useState<ProtonEntry[]>([]);
  const [validating, setValidating] = useState<string | null>(null);
  const [manualPath, setManualPath] = useState("");
  const [showDownload, setShowDownload] = useState(false);
  const [error, setError] = useState("");
  const [protonVersion, setProtonVersion] = useState("");
  const [protonPhase, setProtonPhase] = useState<"downloading" | "extracting">("downloading");
  const [attempt, setAttempt] = useState(0);
  const [canceled, setCanceled] = useState(false);

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      const results = await tauriCmd.scanForProton(baseDir);
      setFound(results);
    } catch { /* ignore */ } finally {
      setScanning(false);
    }
  }, [baseDir]);

  useEffect(() => {
    if (protonMode === "existing") scan();
  }, [protonMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSelectDetected = async (entry: ProtonEntry) => {
    if (validating) return;
    setError("");
    setProtonValidated(false);
    setProtonPath("");
    setValidating(entry.path);
    try {
      const ok = await tauriCmd.validateProtonPath(entry.path);
      if (ok) {
        setProtonPath(entry.path);
        setProtonValidated(true);
        setProtonVersion(entry.version);
      } else {
        setError(`${entry.version} does not appear to be a valid Proton-GE installation.`);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setValidating(null);
    }
  };

  const handleDownload = async () => {
    const targetDir = baseDir.replace(/[/\\]$/, "") + "/proton";
    setError("");
    setCanceled(false);
    setAttempt((a) => a + 1);
    setShowDownload(true);
    setProtonPhase("downloading");
    setLoading(true, "Downloading Proton-GE…");

    // Listen for the extraction phase so the button label can update
    const unlisten = await listen<{ line: string }>("proton://output/download", (e) => {
      if (e.payload.line.toLowerCase().includes("extracting")) {
        setProtonPhase("extracting");
      }
    });

    try {
      const path = await tauriCmd.downloadProtonGe(targetDir);
      setProtonPath(path);
      setProtonValidated(true);
      // Extract version name from path (e.g. GE-Proton9-27)
      setProtonVersion(path.split("/").pop() || path.split("\\").pop() || "Proton-GE");
    } catch (e) {
      const msg = String(e);
      if (msg === "Aborted") {
        setCanceled(true);
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
      setProtonPhase("downloading");
      unlisten();
    }
  };

  const handleManualValidate = async () => {
    if (!manualPath.trim()) { setError("Enter the path to your Proton-GE directory."); return; }
    setError("");
    setProtonValidated(false);
    setProtonPath("");
    const path = manualPath.trim();
    const versionName = path.split("/").pop() || path;
    try {
      const ok = await tauriCmd.validateProtonPath(path);
      if (ok) {
        const newEntry: ProtonEntry = { path, version: versionName };
        setFound(prev => [...prev.filter(e => e.path !== path), newEntry]);
        setProtonPath(path);
        setProtonValidated(true);
        setProtonVersion(versionName);
      } else {
        setError("Validation failed — check the path contains a `proton` script and `files/bin/wine64`.");
      }
    } catch (e) { setError(String(e)); }
  };

  const pickDir = async () => {
    const picked = await open({ directory: true, multiple: false, title: "Select Proton-GE Directory" });
    if (typeof picked === "string" && picked) setManualPath(picked);
  };

  const managedTarget = baseDir
    ? baseDir.replace(/\/$/, "").replace(/\\$/, "") + "/proton"
    : "/your/base/dir/proton";

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-bold mb-1 text-glow-purple" style={{ color: "var(--neon-purple)" }}>
          Proton-GE Setup
        </h2>
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          ASA only ships a Windows binary. Proton-GE allows us to run the Windows binary on Linux.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {([
          { mode: "managed" as const, label: "Managed by LokiASAM", desc: `Download & update automatically into ${managedTarget}` },
          { mode: "existing" as const, label: "Use existing installation", desc: "Point to a Proton-GE you already have" },
        ]).map(({ mode, label, desc }) => (
          <button
            key={mode}
            onClick={() => { if (!isLoading && !protonValidated) { setProtonMode(mode); setError(""); } }}
            disabled={isLoading || protonValidated}
            className="rounded-lg p-4 text-left transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            style={{
              background: protonMode === mode ? "rgba(191,0,255,0.1)" : "rgba(10,10,30,0.5)",
              border: `1px solid ${protonMode === mode ? "rgba(191,0,255,0.5)" : "rgba(191,0,255,0.15)"}`,
              boxShadow: protonMode === mode ? "0 0 16px rgba(191,0,255,0.15)" : "none",
            }}
          >
            <p className="text-sm font-semibold" style={{ color: protonMode === mode ? "var(--neon-purple)" : "var(--text-primary)" }}>
              {label}
            </p>
            <p className="text-xs mt-1 font-mono" style={{ color: "var(--text-muted)" }}>{desc}</p>
          </button>
        ))}
      </div>

      {protonMode === "managed" && (
        <div className="space-y-2">
          <Button
            onClick={handleDownload}
            disabled={isLoading || !baseDir || protonValidated}
            className="w-full gap-2"
            style={{
              background: protonValidated ? "rgba(0,255,136,0.1)" : "rgba(191,0,255,0.15)",
              border: `1px solid ${protonValidated ? "rgba(0,255,136,0.4)" : "rgba(191,0,255,0.4)"}`,
              color: protonValidated ? "var(--neon-green)" : "var(--neon-purple)",
            }}
          >
            {isLoading ? (
              protonPhase === "extracting"
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Extracting…</>
                : <><Loader2 className="w-4 h-4 animate-spin" /> Downloading…</>
            ) : protonValidated ? (
              <><CheckCircle2 className="w-4 h-4" /> {protonVersion || "Proton-GE"} Ready</>
            ) : (
              <><Cpu className="w-4 h-4" /> Download &amp; Install Proton-GE</>
            )}
          </Button>
          {isLoading && showDownload && (
            <Button
              onClick={async () => { await tauriCmd.abortOperation("proton_download"); }}
              size="sm" variant="ghost" className="w-full gap-1.5"
              style={{ color: "var(--neon-red)", border: "1px solid rgba(255,0,85,0.3)" }}>
              <StopCircle className="w-3 h-3" /> Cancel Install
            </Button>
          )}
        </div>
      )}

      {protonMode === "managed" && showDownload && (
        <>
          <CommandOutputPanel
            key={attempt}
            eventChannel="proton://output/download"
            label="Proton-GE Download"
            completed={!isLoading}
            canceled={canceled}
            className="mt-1"
          />
          {error && !isLoading && (
            <p className="text-xs flex items-center gap-1.5" style={{ color: "var(--neon-red)" }}>
              <AlertCircle className="w-3.5 h-3.5 shrink-0" /> {error}
            </p>
          )}
        </>
      )}

      {protonMode === "existing" && (
        <div className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label style={{ color: "var(--text-primary)" }}>Detected Installations</Label>
              <button
                onClick={scan}
                disabled={scanning}
                className="flex items-center gap-1 text-xs"
                style={{ color: "var(--text-muted)" }}
              >
                <RefreshCw className={`w-3 h-3 ${scanning ? "animate-spin" : ""}`} />
                Rescan
              </button>
            </div>

            {scanning ? (
              <p className="text-xs flex items-center gap-1.5" style={{ color: "var(--text-muted)" }}>
                <Loader2 className="w-3 h-3 animate-spin" /> Scanning…
              </p>
            ) : found.length === 0 ? (
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                No Proton-GE installations detected. Enter a path manually below or switch to Managed mode.
              </p>
            ) : (
              <div className="space-y-1.5 max-h-40 overflow-y-auto">
                {found.map((entry) => {
                  const isValidating = validating === entry.path;
                  const isSelected = protonValidated && protonPath === entry.path;
                  return (
                    <button
                      key={entry.path}
                      onClick={() => handleSelectDetected(entry)}
                      disabled={!!validating}
                      className="w-full text-left rounded-lg px-3 py-2 text-xs transition-all disabled:opacity-60"
                      style={{
                        background: isSelected ? "rgba(0,255,136,0.07)" : isValidating ? "rgba(191,0,255,0.1)" : "rgba(10,10,30,0.5)",
                        border: `1px solid ${isSelected ? "rgba(0,255,136,0.4)" : isValidating ? "rgba(191,0,255,0.4)" : "rgba(191,0,255,0.15)"}`,
                      }}
                    >
                      <span className="flex items-center gap-2">
                        {isSelected ? (
                          <CheckCircle2 className="w-3 h-3 shrink-0" style={{ color: "var(--neon-green)" }} />
                        ) : isValidating ? (
                          <Loader2 className="w-3 h-3 animate-spin shrink-0" style={{ color: "var(--neon-purple)" }} />
                        ) : (
                          <Cpu className="w-3 h-3 shrink-0" style={{ color: "var(--neon-purple)" }} />
                        )}
                        <span className="font-semibold" style={{ color: isSelected ? "var(--neon-green)" : "var(--text-primary)" }}>
                          {entry.version}
                        </span>
                      </span>
                      <span className="block font-mono mt-0.5 truncate pl-5" style={{ color: "var(--text-muted)", fontSize: "10px" }}>
                        {entry.path}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label style={{ color: "var(--text-primary)" }}>
              Manual Path
              <span className="ml-2 text-xs" style={{ color: "var(--text-muted)" }}>(optional)</span>
            </Label>
            <div className="flex gap-2">
              <Input
                value={manualPath}
                onChange={(e) => setManualPath(e.target.value)}
                placeholder="/home/user/.steam/root/compatibilitytools.d/GE-Proton9-27"
                className="flex-1 font-mono text-sm"
                style={{ background: "rgba(10,10,30,0.8)", borderColor: "rgba(191,0,255,0.2)", color: "var(--text-primary)" }}
              />
              <Button
                onClick={pickDir}
                variant="outline"
                className="shrink-0"
                style={{ borderColor: "rgba(191,0,255,0.4)", color: "var(--neon-purple)", background: "rgba(191,0,255,0.05)" }}
              >
                <FolderOpen className="w-4 h-4" />
              </Button>
            </div>
            <Button
              onClick={handleManualValidate}
              disabled={!manualPath.trim()}
              size="sm"
              className="gap-2"
              style={{ background: "rgba(191,0,255,0.08)", border: "1px solid rgba(191,0,255,0.3)", color: "var(--neon-purple)" }}
            >
              Validate Path
            </Button>
          </div>
        </div>
      )}

      {/* Show error for "existing" mode (managed shows inline in its own block) */}
      {error && protonMode === "existing" && (
        <p className="text-xs flex items-center gap-1.5" style={{ color: "var(--neon-red)" }}>
          <AlertCircle className="w-3.5 h-3.5 shrink-0" /> {error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toggle helper used in Notifications and Tray steps
// ---------------------------------------------------------------------------

function ToggleRow({
  label,
  description,
  value,
  onChange,
  disabled,
}: {
  label: string;
  description?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>{label}</p>
        {description && <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>{description}</p>}
      </div>
      <button
        onClick={() => !disabled && onChange(!value)}
        disabled={disabled}
        className="shrink-0 flex items-center gap-1.5 disabled:opacity-50"
        aria-label={value ? "Disable" : "Enable"}
      >
        {value ? (
          <ToggleRight className="w-8 h-8" style={{ color: "var(--neon-purple)" }} />
        ) : (
          <ToggleLeft className="w-8 h-8" style={{ color: "var(--text-subtle)" }} />
        )}
      </button>
    </div>
  );
}

function NotificationsStep() {
  const {
    discordWebhook, setDiscordWebhook,
    smtpHost, setSmtpHost,
    smtpPort, setSmtpPort,
    smtpUsername, setSmtpUsername,
    smtpPassword, setSmtpPassword,
    smtpUseTls, setSmtpUseTls,
    smtpFrom, setSmtpFrom,
    smtpTo, setSmtpTo,
  } = useSetupStore();

  const [testingDiscord, setTestingDiscord] = useState(false);
  const [testingEmail,   setTestingEmail]   = useState(false);

  const handleTestDiscord = async () => {
    if (!discordWebhook.trim()) { toast.error("Enter a webhook URL first."); return; }
    setTestingDiscord(true);
    try {
      await tauriCmd.sendDiscordNotification(discordWebhook.trim(), {
        title: "LokiASAM Test", description: "Discord notifications are working!",
        color: 0x00ff88, serverName: "Setup Wizard", eventType: "test",
      });
      toast.success("Test notification sent to Discord.");
    } catch (e) {
      toast.error(`Discord test failed: ${e}`);
    } finally {
      setTestingDiscord(false);
    }
  };

  const handleTestEmail = async () => {
    if (!smtpHost.trim() || !smtpTo.trim()) { toast.error("Enter SMTP host and To address first."); return; }
    setTestingEmail(true);
    try {
      await tauriCmd.sendEmailNotification(
        {
          host: smtpHost, port: Number(smtpPort || 587),
          username: smtpUsername, password: smtpPassword,
          fromAddress: smtpFrom || "noreply@lokiasam",
          toAddress: smtpTo, useTls: smtpUseTls,
        },
        { subject: "LokiASAM Test", body: "Email notifications are working!" }
      );
      toast.success("Test email sent.");
    } catch (e) {
      toast.error(`Email test failed: ${e}`);
    } finally {
      setTestingEmail(false);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-bold mb-1 text-glow-purple" style={{ color: "var(--neon-purple)" }}>
          What notifications would you like?
        </h2>
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          All channels are optional — you can change these at any time in Settings.
        </p>
      </div>

      {/* Discord webhook */}
      <div
        className="rounded-lg p-4 space-y-3"
        style={{ background: "rgba(10,10,30,0.5)", border: "1px solid rgba(191,0,255,0.1)" }}
      >
        <div className="flex items-center justify-between">
          <Label htmlFor="discord-webhook" style={{ color: "var(--text-primary)" }}>
            Discord Webhook
            <span className="ml-2 text-xs" style={{ color: "var(--text-muted)" }}>(optional)</span>
          </Label>
          {discordWebhook.trim() && (
            <Button
              onClick={handleTestDiscord}
              disabled={testingDiscord}
              size="sm"
              variant="ghost"
              className="gap-1.5 h-7 text-xs"
              style={{ color: "var(--text-muted)" }}
            >
              {testingDiscord ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
              Test
            </Button>
          )}
        </div>
        <Input
          id="discord-webhook"
          value={discordWebhook}
          onChange={(e) => setDiscordWebhook(e.target.value)}
          placeholder="https://discord.com/api/webhooks/..."
          className="font-mono text-sm"
          style={{
            background: "rgba(10,10,30,0.8)",
            borderColor: discordWebhook ? "rgba(191,0,255,0.4)" : "rgba(191,0,255,0.2)",
            color: "var(--text-primary)",
          }}
        />
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          In Discord: Server Settings → Integrations → Webhooks.
        </p>
      </div>

      {/* Email / SMTP */}
      <div
        className="rounded-lg p-4 space-y-3"
        style={{ background: "rgba(10,10,30,0.5)", border: "1px solid rgba(191,0,255,0.1)" }}
      >
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            Email / SMTP
            <span className="ml-2 text-xs font-normal" style={{ color: "var(--text-muted)" }}>(optional)</span>
          </p>
          {smtpHost.trim() && smtpTo.trim() && (
            <Button
              onClick={handleTestEmail}
              disabled={testingEmail}
              size="sm"
              variant="ghost"
              className="gap-1.5 h-7 text-xs"
              style={{ color: "var(--text-muted)" }}
            >
              {testingEmail ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
              Test
            </Button>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className="text-xs" style={{ color: "var(--text-muted)" }}>SMTP Host</Label>
            <Input value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)}
              placeholder="smtp.example.com" className="font-mono text-xs"
              style={{ background: "rgba(10,10,30,0.8)", borderColor: "rgba(191,0,255,0.2)", color: "var(--text-primary)" }}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs" style={{ color: "var(--text-muted)" }}>Port</Label>
            <Input value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)}
              placeholder="587" className="font-mono text-xs"
              style={{ background: "rgba(10,10,30,0.8)", borderColor: "rgba(191,0,255,0.2)", color: "var(--text-primary)" }}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className="text-xs" style={{ color: "var(--text-muted)" }}>Username</Label>
            <Input value={smtpUsername} onChange={(e) => setSmtpUsername(e.target.value)}
              placeholder="user@example.com" className="font-mono text-xs"
              style={{ background: "rgba(10,10,30,0.8)", borderColor: "rgba(191,0,255,0.2)", color: "var(--text-primary)" }}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs" style={{ color: "var(--text-muted)" }}>Password</Label>
            <Input type="password" value={smtpPassword} onChange={(e) => setSmtpPassword(e.target.value)}
              placeholder="••••••••" className="font-mono text-xs"
              style={{ background: "rgba(10,10,30,0.8)", borderColor: "rgba(191,0,255,0.2)", color: "var(--text-primary)" }}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className="text-xs" style={{ color: "var(--text-muted)" }}>From Address</Label>
            <Input value={smtpFrom} onChange={(e) => setSmtpFrom(e.target.value)}
              placeholder="noreply@example.com" className="font-mono text-xs"
              style={{ background: "rgba(10,10,30,0.8)", borderColor: "rgba(191,0,255,0.2)", color: "var(--text-primary)" }}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs" style={{ color: "var(--text-muted)" }}>To Address</Label>
            <Input value={smtpTo} onChange={(e) => setSmtpTo(e.target.value)}
              placeholder="admin@example.com" className="font-mono text-xs"
              style={{ background: "rgba(10,10,30,0.8)", borderColor: "rgba(191,0,255,0.2)", color: "var(--text-primary)" }}
            />
          </div>
        </div>
        <ToggleRow label="Use TLS / STARTTLS" value={smtpUseTls} onChange={setSmtpUseTls} />
      </div>

      {/* Notification event matrix */}
      <div
        className="rounded-lg p-4 space-y-3"
        style={{ background: "rgba(10,10,30,0.5)", border: "1px solid rgba(191,0,255,0.1)" }}
      >
        <div>
          <p className="text-xs font-semibold" style={{ color: "var(--neon-purple)" }}>Notification Events</p>
          <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
            Choose which events trigger each channel. Configure credentials above to unlock Discord and SMTP columns.
          </p>
        </div>
        <NotificationMatrix />
      </div>
    </div>
  );
}

function TrayStep() {
  const { closeToTray, setCloseToTray } = useSetupStore();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold mb-1 text-glow-purple" style={{ color: "var(--neon-purple)" }}>
          System Tray Behavior
        </h2>
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          Choose what happens when you click the X button on the main window.
        </p>
      </div>

      <div className="space-y-3">
        {[
          {
            value: true,
            label: "Minimize to system tray",
            desc: "The app keeps running in the background. Servers stay alive and schedules keep firing even when the window is closed. A tray icon lets you bring it back.",
            recommended: true,
          },
          {
            value: false,
            label: "Exit completely",
            desc: "Closing the window exits LokiASAM entirely. Running servers will continue on their own, but in-app monitoring, scheduled tasks, and notifications will stop.",
            recommended: false,
          },
        ].map(({ value, label, desc, recommended }) => (
          <button
            key={String(value)}
            onClick={() => setCloseToTray(value)}
            className="w-full text-left rounded-lg p-4 transition-all"
            style={{
              background: closeToTray === value ? "rgba(191,0,255,0.1)" : "rgba(10,10,30,0.5)",
              border: `1px solid ${closeToTray === value ? "rgba(191,0,255,0.5)" : "rgba(191,0,255,0.15)"}`,
              boxShadow: closeToTray === value ? "0 0 16px rgba(191,0,255,0.12)" : "none",
            }}
          >
            <div className="flex items-center gap-2 mb-1">
              <div
                className="w-3.5 h-3.5 rounded-full border-2 flex-shrink-0 flex items-center justify-center"
                style={{ borderColor: closeToTray === value ? "var(--neon-purple)" : "rgba(191,0,255,0.3)" }}
              >
                {closeToTray === value && (
                  <div className="w-2 h-2 rounded-full" style={{ background: "var(--neon-purple)" }} />
                )}
              </div>
              <p className="text-sm font-semibold" style={{ color: closeToTray === value ? "var(--neon-purple)" : "var(--text-primary)" }}>
                {label}
                {recommended && (
                  <span className="ml-2 text-xs font-normal px-1.5 py-0.5 rounded" style={{ background: "rgba(191,0,255,0.15)", color: "var(--neon-purple)" }}>
                    Recommended
                  </span>
                )}
              </p>
            </div>
            <p className="text-xs pl-5" style={{ color: "var(--text-muted)" }}>{desc}</p>
          </button>
        ))}
      </div>

      <div
        className="rounded-lg p-3"
        style={{ background: "rgba(191,0,255,0.05)", border: "1px solid rgba(191,0,255,0.12)" }}
      >
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          <span className="font-semibold" style={{ color: "var(--neon-purple)" }}>Note: </span>
          You can change this at any time in Settings. The first time you minimize to tray, you&apos;ll get a desktop notification confirming the app is still running.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AutoUpdateStep — configure update check preferences before completing setup
// ---------------------------------------------------------------------------

function AutoUpdateStep() {
  const {
    asaAutoUpdateEnabled, setAsaAutoUpdateEnabled,
    appAutoUpdateEnabled, setAppAutoUpdateEnabled,
    protonAutoCheckEnabled, setProtonAutoCheckEnabled,
  } = useSetupStore();

  const rows = [
    {
      key: "asa", label: "ASA Server Updates",
      desc: "Automatically check for ARK: Survival Ascended server updates via Steam.",
      value: asaAutoUpdateEnabled, set: setAsaAutoUpdateEnabled,
    },
    {
      key: "app", label: "LokiASAM App Updates",
      desc: "Automatically check for LokiASAM application updates on startup.",
      value: appAutoUpdateEnabled, set: setAppAutoUpdateEnabled,
    },
    ...(IS_LINUX ? [{
      key: "proton", label: "Proton-GE Updates",
      desc: "Automatically check GitHub for new GE-Proton releases once per day.",
      value: protonAutoCheckEnabled, set: setProtonAutoCheckEnabled,
    }] : []),
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold mb-1 text-glow-purple" style={{ color: "var(--neon-purple)" }}>
          Auto-Update Settings
        </h2>
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          Choose which components LokiASAM checks for updates automatically. You can change these anytime in Settings.
        </p>
      </div>

      <div className="space-y-4">
        {rows.map((row) => (
          <div key={row.key} className="rounded-xl px-4 py-3"
            style={{ background: "rgba(10,10,30,0.5)", border: "1px solid rgba(191,0,255,0.12)" }}>
            <ToggleRow label={row.label} description={row.desc} value={row.value} onChange={row.set} />
          </div>
        ))}
      </div>
    </div>
  );
}

function CompleteStep({ onComplete }: { onComplete: () => void }) {
  const { baseDir, backupDir, steamcmdPath, protonPath } = useSetupStore();

  const summaryRows = [
    { label: "Servers Directory", value: baseDir },
    { label: "Backup Directory",  value: backupDir },
    { label: "SteamCMD",          value: steamcmdPath },
    ...(IS_LINUX ? [{ label: "Proton-GE", value: protonPath }] : []),
  ];

  return (
    <div className="flex flex-col items-center text-center gap-6">
      <div
        className="w-20 h-20 rounded-full flex items-center justify-center"
        style={{
          background: "rgba(0,255,136,0.1)",
          border: "1px solid rgba(0,255,136,0.4)",
          boxShadow: "0 0 30px rgba(0,255,136,0.2)",
        }}
      >
        <CheckCircle2 className="w-10 h-10" style={{ color: "var(--neon-green)" }} />
      </div>

      <div className="space-y-2">
        <h2 className="text-2xl font-bold text-glow-green" style={{ color: "var(--neon-green)" }}>
          Setup Complete!
        </h2>
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          LokiASAM is configured and ready. Here&apos;s a summary of your choices:
        </p>
      </div>

      <div className="w-full space-y-2 text-left">
        {summaryRows.map(({ label, value }) => (
          <div
            key={label}
            className="rounded-lg px-4 py-3 flex items-center justify-between gap-4"
            style={{ background: "rgba(10,10,30,0.6)", border: "1px solid rgba(191,0,255,0.15)" }}
          >
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>{label}</span>
            <span className="text-xs font-mono truncate max-w-xs" style={{ color: "var(--text-primary)" }}>{value || "—"}</span>
          </div>
        ))}
      </div>

      <Button
        onClick={onComplete}
        size="lg"
        className="gap-2 px-8"
        style={{
          background: "rgba(191,0,255,0.2)",
          border: "1px solid rgba(191,0,255,0.5)",
          color: "var(--neon-purple)",
          boxShadow: "0 0 20px rgba(191,0,255,0.2)",
        }}
      >
        Go to Dashboard
        <ArrowRight className="w-4 h-4" />
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main SetupWizard
// ---------------------------------------------------------------------------

export function SetupWizard({ onComplete }: SetupWizardProps) {
  const {
    step, nextStep, prevStep, setStep,
    baseDir, backupDir, baseDirWritable, backupDirWritable,
    steamcmdPath, steamcmdValidated,
    protonPath, protonValidated,
    setBaseDir, setBackupDir, setSteamcmdPath, setSteamcmdValidated,
    setProtonPath, setProtonValidated,
    discordWebhook,
    smtpHost, smtpPort, smtpUsername, smtpPassword, smtpUseTls, smtpFrom, smtpTo,
    closeToTray,
    asaAutoUpdateEnabled, appAutoUpdateEnabled, protonAutoCheckEnabled,
    isLoading,
    importMode, importValid, importDir,
  } = useSetupStore();
  const [direction, setDirection] = useState(1);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [appVersion, setAppVersion] = useState("...");
  const scrollAreaRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion(""));
  }, []);

  // Scroll card to top on every step change
  useEffect(() => {
    if (scrollAreaRef.current) {
      scrollAreaRef.current.scrollTop = 0;
    }
  }, [step]);

  // Scroll card to bottom when a long-running operation starts (SteamCMD / Proton)
  useEffect(() => {
    if (isLoading && scrollAreaRef.current) {
      const el = scrollAreaRef.current;
      setTimeout(() => {
        if (el) el.scrollTop = el.scrollHeight;
      }, 80);
    }
  }, [isLoading]);

  const canAdvance = () => {
    if (step === 1 && importMode) return importValid; // import tab needs a valid DB
    switch (step) {
      case 0: return true;
      case 1: return baseDirWritable;
      case 2: return backupDirWritable;
      case 3: return steamcmdValidated;
      case 4: return IS_LINUX ? protonValidated : true; // proton on linux, notifications on windows
      case 5: return true;  // notifications — always ok
      case 6: return true;  // tray / updates — always ok
      case 7: return IS_LINUX ? true : true;            // updates / complete — always ok
      default: return false;
    }
  };

  // Called when the user clicks "Import & Finish" from the bottom nav bar
  const handleImportComplete = async () => {
    setSaving(true);
    setSaveError("");
    try {
      // Write bootstrap so the app knows where the DB lives on next launch
      await tauriCmd.writeBootstrap(importDir);

      const sep = importDir.includes("\\") ? "\\" : "/";
      const dbPath = importDir.replace(/[/\\]$/, "") + sep + "lokiasam" + sep + "lokiasam.db";
      const { initDb: _init, getAppSetting: getSetting } = await import("@/lib/db");
      await _init(dbPath);
      await setAppSetting("setup_complete", "true");

      // Read actual paths from the imported DB so the Complete step shows correct info
      const [storedBase, storedBackup, storedScmd, storedProton] = await Promise.all([
        getSetting("base_dir"),
        getSetting("backup_dir"),
        getSetting("steamcmd_path"),
        getSetting("proton_path"),
      ]);
      if (storedBase)   setBaseDir(storedBase);
      if (storedBackup) setBackupDir(storedBackup);
      if (storedScmd)   { setSteamcmdPath(storedScmd);   setSteamcmdValidated(true); }
      if (storedProton) { setProtonPath(storedProton);   setProtonValidated(true); }

      setDirection(1);
      setStep(TOTAL_STEPS - 1);
    } catch (err) {
      setSaveError(`Import failed: ${err}`);
    } finally {
      setSaving(false);
    }
  };

  const handleNext = async () => {
    // Handle import mode on step 1 — skip to Complete after saving
    if (step === 1 && importMode && importValid) {
      await handleImportComplete();
      return;
    }

    if (step === TOTAL_STEPS - 2) {
      // Save all settings before the Complete step
      setSaving(true);
      setSaveError("");
      try {
        await tauriCmd.writeBootstrap(baseDir);

        const sep = baseDir.includes("\\") ? "\\" : "/";
        const dbPath = baseDir.replace(/[/\\]$/, "") + sep + "lokiasam" + sep + "lokiasam.db";
        await initDb(dbPath);

        await setAppSetting("base_dir", baseDir);
        await setAppSetting("backup_dir", backupDir);
        await setAppSetting("steamcmd_path", steamcmdPath);
        if (IS_LINUX && protonPath) {
          await setAppSetting("proton_path", protonPath);
          const prefix = baseDir.replace(/[/\\]$/, "") + sep + "proton" + sep + "prefix";
          await setAppSetting("proton_prefix_path", prefix);
        }
        if (discordWebhook) await setAppSetting("discord_webhook", discordWebhook);

        // SMTP (only if host is set)
        if (smtpHost) {
          await setAppSetting("smtp_host",     smtpHost);
          await setAppSetting("smtp_port",     smtpPort);
          await setAppSetting("smtp_username", smtpUsername);
          await setAppSetting("smtp_password", smtpPassword);
          await setAppSetting("smtp_use_tls",  String(smtpUseTls));
          await setAppSetting("smtp_from",     smtpFrom);
          await setAppSetting("smtp_to",       smtpTo);
        }

        // Tray preference
        await setAppSetting("close_to_tray", String(closeToTray));

        // Auto-update preferences
        await setAppSetting("asa_auto_update_enabled",  String(asaAutoUpdateEnabled));
        await setAppSetting("app_auto_update_enabled",  String(appAutoUpdateEnabled));
        if (IS_LINUX) await setAppSetting("proton_ge_auto_check", String(protonAutoCheckEnabled));

        await setAppSetting("setup_complete", "true");
        setDirection(1);
        nextStep();
      } catch (err) {
        setSaveError(`Failed to save settings: ${err}`);
      } finally {
        setSaving(false);
      }
    } else {
      setDirection(1);
      nextStep();
    }
  };

  const handlePrev = () => {
    setDirection(-1);
    prevStep();
  };

  const handleComplete = () => {
    onComplete(closeToTray);
  };

  const stepComponents = IS_LINUX
    ? [
        <WelcomeStep key="welcome" />,
        <BaseDirStep key="basedir" />,
        <BackupDirStep key="backupdir" />,
        <SteamCmdStep key="steamcmd" />,
        <ProtonGEStep key="proton" />,
        <NotificationsStep key="notifications" />,
        <TrayStep key="tray" />,
        <AutoUpdateStep key="autoupdate" />,
        <CompleteStep key="complete" onComplete={handleComplete} />,
      ]
    : [
        <WelcomeStep key="welcome" />,
        <BaseDirStep key="basedir" />,
        <BackupDirStep key="backupdir" />,
        <SteamCmdStep key="steamcmd" />,
        <NotificationsStep key="notifications" />,
        <TrayStep key="tray" />,
        <AutoUpdateStep key="autoupdate" />,
        <CompleteStep key="complete" onComplete={handleComplete} />,
      ];

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col"
      style={{ background: "var(--background)" }}
    >
      {/* Background texture */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage: "radial-gradient(ellipse 80% 50% at 50% -20%, rgba(191,0,255,0.08) 0%, transparent 60%)",
        }}
      />

      {/* Progress bar at top */}
      <div className="relative z-10 w-full h-1" style={{ background: "rgba(191,0,255,0.1)" }}>
        <div
          className="h-full transition-all duration-500"
          style={{
            width: `${((step + 1) / TOTAL_STEPS) * 100}%`,
            background: "var(--neon-purple)",
            boxShadow: "0 0 8px rgba(191,0,255,0.6)",
          }}
        />
      </div>

      {/* Step indicator pills */}
      <div className="relative z-10 flex justify-center gap-2 pt-6">
        {STEPS.map((s, i) => (
          <div
            key={s.label}
            className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs transition-all duration-300"
            style={{
              background: i === step ? "rgba(191,0,255,0.15)" : "transparent",
              border: `1px solid ${i <= step ? "rgba(191,0,255,0.4)" : "rgba(191,0,255,0.1)"}`,
              color: i === step ? "var(--neon-purple)" : i < step ? "rgba(191,0,255,0.6)" : "var(--text-subtle)",
            }}
          >
            <s.icon className="w-3 h-3" />
            <span className="hidden sm:inline">{s.label}</span>
          </div>
        ))}
      </div>

      {/* Main content card */}
      <div className="relative z-10 flex-1 flex items-center justify-center p-6">
        <div
          className="w-full max-w-2xl flex flex-col"
          style={{
            background: "rgba(10,10,30,0.8)",
            border: "1px solid rgba(191,0,255,0.2)",
            borderRadius: "1rem",
            backdropFilter: "blur(12px)",
            boxShadow: "0 0 60px rgba(191,0,255,0.1)",
            maxHeight: "calc(100vh - 160px)",
            minHeight: "420px",
          }}
        >
          <div className="p-8 flex-1 flex flex-col min-h-0 overflow-hidden">
            <div ref={scrollAreaRef} className="flex-1 min-h-0 overflow-y-auto pr-2">
              <AnimatePresence mode="wait" custom={direction}>
                <motion.div
                  key={step}
                  custom={direction}
                  variants={stepVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={{ duration: 0.25, ease: "easeInOut" }}
                >
                  {stepComponents[step]}
                </motion.div>
              </AnimatePresence>
            </div>

            {saveError && (
              <p className="text-xs mt-4 flex items-center gap-1.5" style={{ color: "var(--neon-red)" }}>
                <AlertCircle className="w-3.5 h-3.5 shrink-0" /> {saveError}
              </p>
            )}

            {/* Navigation — hidden on the Complete step */}
            {step < TOTAL_STEPS - 1 && (
              <div className="flex items-center justify-between mt-6 pt-4 border-t" style={{ borderColor: "rgba(191,0,255,0.1)" }}>
                {/* Back button — hidden on page 0 */}
                {step === 0 ? (
                  <div />
                ) : (
                  <Button
                    variant="ghost"
                    onClick={handlePrev}
                    disabled={isLoading}
                    className="gap-2"
                    style={{ color: "var(--text-muted)" }}
                  >
                    <ArrowLeft className="w-4 h-4" /> Back
                  </Button>
                )}

                <span className="text-xs" style={{ color: "var(--text-subtle)" }}>
                  {step + 1} / {TOTAL_STEPS}
                </span>

                {/* Hide the default Next button when import mode is showing its own button */}
                {!(step === 1 && importMode && importValid) && (
                  <Button
                    onClick={handleNext}
                    disabled={!canAdvance() || isLoading || saving}
                    className="gap-2"
                    style={{
                      background: canAdvance() && !isLoading ? "rgba(191,0,255,0.15)" : "rgba(191,0,255,0.05)",
                      border: "1px solid rgba(191,0,255,0.4)",
                      color: canAdvance() && !isLoading ? "var(--neon-purple)" : "var(--text-muted)",
                    }}
                  >
                    {saving ? (
                      <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</>
                    ) : step === TOTAL_STEPS - 2 ? (
                      <>Finish <CheckCircle2 className="w-4 h-4" /></>
                    ) : (
                      <>Next <ArrowRight className="w-4 h-4" /></>
                    )}
                  </Button>
                )}

                {/* Import mode: show an Import button in place of Next */}
                {step === 1 && importMode && importValid && (
                  <Button
                    onClick={handleNext}
                    disabled={saving}
                    className="gap-2"
                    style={{
                      background: "rgba(0,255,136,0.12)",
                      border: "1px solid rgba(0,255,136,0.4)",
                      color: "var(--neon-green)",
                    }}
                  >
                    {saving ? (
                      <><Loader2 className="w-4 h-4 animate-spin" /> Importing…</>
                    ) : (
                      <>Import &amp; Finish <CheckCircle2 className="w-4 h-4" /></>
                    )}
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Branding footer */}
      <div className="relative z-10 text-center pb-4">
        <p className="text-xs" style={{ color: "var(--text-subtle)" }}>
          LokiASAM{appVersion ? ` v${appVersion}` : ""} · lokisoft.xyz
        </p>
      </div>
    </div>
  );
}
