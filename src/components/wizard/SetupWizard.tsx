"use client";

/**
 * SetupWizard — first-time setup wizard rendered as a full-screen overlay.
 *
 * Steps:
 *   0 - Welcome
 *   1 - Base Install Directory
 *   2 - Backup Directory
 *   3 - SteamCMD Setup (auto-download or manual path)
 *   4 - Notification Defaults (optional)
 *   5 - Complete
 *
 * On completion, writes settings to SQLite and calls onComplete().
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { FolderOpen, HardDrive, Terminal, Bell, CheckCircle2, ArrowRight, ArrowLeft, Loader2, AlertCircle, HardDrive as DiskIcon, Cpu, RefreshCw } from "lucide-react";
import { LokiIcon } from "@/components/shared/LokiIcon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CommandOutputPanel } from "@/components/shared/CommandOutputPanel";
import { useSetupStore } from "@/store/useSetupStore";
import { tauriCmd, type DirCheckResult, type ProtonEntry } from "@/lib/tauri-commands";
import { setAppSetting, initDb } from "@/lib/db";
import { open } from "@tauri-apps/plugin-dialog";
import { homeDir } from "@tauri-apps/api/path";

interface SetupWizardProps {
  onComplete: () => void;
}

// Detect Linux at module load time (same heuristic used elsewhere in this file).
const IS_LINUX =
  typeof navigator !== "undefined" && !navigator.userAgent.includes("Windows");

const STEPS_WIN = [
  { label: "Welcome",       icon: LokiIcon },
  { label: "Install Dir",   icon: HardDrive },
  { label: "Backup Dir",    icon: FolderOpen },
  { label: "SteamCMD",      icon: Terminal },
  { label: "Notifications", icon: Bell },
  { label: "Complete",      icon: CheckCircle2 },
];

const STEPS_LINUX = [
  { label: "Welcome",       icon: LokiIcon },
  { label: "Install Dir",   icon: HardDrive },
  { label: "Backup Dir",    icon: FolderOpen },
  { label: "SteamCMD",      icon: Terminal },
  { label: "Proton-GE",     icon: Cpu },
  { label: "Notifications", icon: Bell },
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
          <CheckCircle2 className="w-3 h-3" /> Directory is writable
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

      <div
        className="grid grid-cols-3 gap-3 w-full max-w-sm"
      >
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

function BaseDirStep() {
  const { baseDir, setBaseDir, setBackupDir, setBaseDirWritable } = useSetupStore();
  const [dirResult, setDirResult] = useState<DirCheckResult | null>(null);
  const [checking, setChecking] = useState(false);

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

  // Auto-fill with platform default and validate on mount
  useEffect(() => {
    (async () => {
      try {
        const home = await homeDir();
        const sep = home.includes("\\") ? "\\" : "/";
        const defaultDir = home.replace(/[/\\]$/, "") + sep + "ArkServers";
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
    const selected = await open({ directory: true, multiple: false, title: "Select Base Server Installation Directory" });
    if (typeof selected === "string" && selected) {
      handleChange(selected);
      await validateDir(selected);
    }
  };

  const borderColor = dirResult
    ? dirResult.writable ? "rgba(0,255,136,0.5)" : "rgba(255,60,60,0.5)"
    : baseDir ? "rgba(191,0,255,0.4)" : "rgba(191,0,255,0.2)";

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold mb-1 text-glow-purple" style={{ color: "var(--neon-purple)" }}>
          Base Installation Directory
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
            placeholder="/home/user/ArkServers"
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

  // Validate on mount if backupDir was pre-filled from the base dir step
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
          Backup Directory
        </h2>
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          Where backup ZIP archives will be stored. Can be on a different drive for safety.
          We&apos;ve pre-filled this based on your base directory.
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
            placeholder="/home/user/ArkServers/Backups"
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

  const autoSteamcmdTarget = baseDir
    ? baseDir.replace(/\/$/, "").replace(/\\$/, "") + "/.steamcmd"
    : "/your/base/dir/.steamcmd";

  const autoExePath = autoSteamcmdTarget +
    (typeof window !== "undefined" && navigator.userAgent.includes("Windows") ? "\\steamcmd.exe" : "/steamcmd.sh");

  const handleAutoDownload = async () => {
    setError("");
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
        // Validate the existing install first; only re-download if it fails.
        setLoading(true, "Found existing SteamCMD, validating...");
        setOutputChannel("validate");
        const ok = await tauriCmd.validateSteamcmd(autoExePath);
        if (ok) {
          setSteamcmdPath(autoExePath);
          setSteamcmdValidated(true);
          return;
        }
        // Validation failed — existing install is broken, re-download.
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
      setError(String(err));
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
      filters: [
        { name: "SteamCMD", extensions: ["exe", "sh", "*"] },
      ],
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

      {/* Mode selector */}
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

      {/* Auto-download action */}
      {steamcmdMode === "auto" && (
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
      )}

      {/* Manual path input */}
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

      {/* Live output panel */}
      {outputChannel && (
        <CommandOutputPanel
          eventChannel={outputChannel === "install" ? "steamcmd://output/setup" : "steamcmd://output/validate"}
          label={outputChannel === "install" ? "Downloading SteamCMD" : "Validating SteamCMD"}
          completed={!isLoading}
          className="mt-2"
        />
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
  const [validating, setValidating] = useState<string | null>(null); // path currently being validated
  const [manualPath, setManualPath] = useState("");
  const [showDownload, setShowDownload] = useState(false);
  const [error, setError] = useState("");

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      const results = await tauriCmd.scanForProton(baseDir);
      setFound(results);
    } catch { /* ignore */ } finally {
      setScanning(false);
    }
  }, [baseDir]);

  // Scan on mount and whenever the user switches to the "existing" mode.
  useEffect(() => {
    if (protonMode === "existing") scan();
  }, [protonMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSelectDetected = async (entry: ProtonEntry) => {
    if (validating) return;
    setError("");
    // Clear any previous validation so the Next button unlocks only on success.
    setProtonValidated(false);
    setProtonPath("");
    setValidating(entry.path);
    try {
      const ok = await tauriCmd.validateProtonPath(entry.path);
      if (ok) {
        setProtonPath(entry.path);
        setProtonValidated(true);
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
    setShowDownload(true);
    setLoading(true, "Downloading Proton-GE…");
    try {
      const path = await tauriCmd.downloadProtonGe(targetDir);
      setProtonPath(path);
      setProtonValidated(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
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
        // Add to (or update in) the detected list so it shows with a validated highlight.
        const newEntry: ProtonEntry = { path, version: versionName };
        setFound(prev => [...prev.filter(e => e.path !== path), newEntry]);
        setProtonPath(path);
        setProtonValidated(true);
      } else {
        setError("Validation failed — check the path contains a `proton` script and `files/bin/wine64`.");
      }
    } catch (e) { setError(String(e)); }
  };

  const pickDir = async () => {
    const picked = await open({ directory: true, multiple: false, title: "Select Proton-GE Directory" });
    if (typeof picked === "string" && picked) {
      setManualPath(picked);
    }
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
          ASA only ships a Windows binary. Proton-GE lets it run natively on Linux.
        </p>
      </div>

      {/* Mode selector */}
      <div className="grid grid-cols-2 gap-3">
        {([
          {
            mode: "managed" as const,
            label: "Managed by LokiASAM",
            desc: `Download & update automatically into ${managedTarget}`,
          },
          {
            mode: "existing" as const,
            label: "Use existing installation",
            desc: "Point to a Proton-GE you already have",
          },
        ]).map(({ mode, label, desc }) => (
          <button
            key={mode}
            onClick={() => {
              if (!isLoading && !protonValidated) {
                setProtonMode(mode);
                setError("");
              }
            }}
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

      {/* ── Managed mode ── */}
      {protonMode === "managed" && (
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
            <><Loader2 className="w-4 h-4 animate-spin" /> Downloading…</>
          ) : protonValidated ? (
            <><CheckCircle2 className="w-4 h-4" /> Proton-GE Ready</>
          ) : (
            <><Cpu className="w-4 h-4" /> Download &amp; Install Proton-GE</>
          )}
        </Button>
      )}

      {protonMode === "managed" && showDownload && (
        <CommandOutputPanel
          eventChannel="proton://output/download"
          label="Proton-GE Download"
          completed={!isLoading}
          className="mt-1"
        />
      )}

      {/* ── Existing mode ── always visible so the user can change their selection */}
      {protonMode === "existing" && (
        <div className="space-y-4">
          {/* Detected installations */}
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
                        background: isSelected
                          ? "rgba(0,255,136,0.07)"
                          : isValidating
                          ? "rgba(191,0,255,0.1)"
                          : "rgba(10,10,30,0.5)",
                        border: `1px solid ${
                          isSelected
                            ? "rgba(0,255,136,0.4)"
                            : isValidating
                            ? "rgba(191,0,255,0.4)"
                            : "rgba(191,0,255,0.15)"
                        }`,
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

          {/* Manual path */}
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
                style={{
                  background: "rgba(10,10,30,0.8)",
                  borderColor: "rgba(191,0,255,0.2)",
                  color: "var(--text-primary)",
                }}
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
              style={{
                background: "rgba(191,0,255,0.08)",
                border: "1px solid rgba(191,0,255,0.3)",
                color: "var(--neon-purple)",
              }}
            >
              Validate Path
            </Button>
          </div>
        </div>
      )}

      {/* Validated badge (both modes) */}
      {protonValidated && (
        <div
          className="rounded-lg px-4 py-3 flex items-center gap-2"
          style={{ background: "rgba(0,255,136,0.07)", border: "1px solid rgba(0,255,136,0.3)" }}
        >
          <CheckCircle2 className="w-4 h-4 shrink-0" style={{ color: "var(--neon-green)" }} />
          <div>
            <p className="text-xs font-semibold" style={{ color: "var(--neon-green)" }}>Proton-GE Ready</p>
            <p className="text-[10px] font-mono mt-0.5 truncate" style={{ color: "var(--text-muted)" }}>{protonPath}</p>
          </div>
        </div>
      )}

      {error && (
        <p className="text-xs flex items-center gap-1.5" style={{ color: "var(--neon-red)" }}>
          <AlertCircle className="w-3.5 h-3.5 shrink-0" /> {error}
        </p>
      )}
    </div>
  );
}

function NotificationsStep() {
  const { discordWebhook, setDiscordWebhook } = useSetupStore();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold mb-1 text-glow-purple" style={{ color: "var(--neon-purple)" }}>
          Notification Defaults
        </h2>
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          Get notified when servers start, crash, or finish updates. All fields are optional —
          you can configure per-server notifications later.
        </p>
      </div>

      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="discord-webhook" style={{ color: "var(--text-primary)" }}>
            Discord Webhook URL
            <span className="ml-2 text-xs" style={{ color: "var(--text-muted)" }}>(optional)</span>
          </Label>
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
            Server Admin → Integrations → Webhooks in Discord to create one.
          </p>
        </div>

        <div
          className="rounded-lg p-4"
          style={{ background: "rgba(191,0,255,0.05)", border: "1px solid rgba(191,0,255,0.15)" }}
        >
          <p className="text-xs font-semibold mb-2" style={{ color: "var(--neon-purple)" }}>
            Desktop notifications
          </p>
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            Always enabled — OS toast notifications appear for server crashes and critical events.
          </p>
        </div>
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
    step, nextStep, prevStep,
    baseDir, backupDir, baseDirWritable, backupDirWritable,
    steamcmdPath, steamcmdValidated,
    protonPath, protonValidated,
    discordWebhook, isLoading,
  } = useSetupStore();
  const [direction, setDirection] = useState(1);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const scrollAreaRef = useRef<HTMLDivElement>(null);

  // Scroll the card content to bottom when a long-running operation starts
  // (e.g. SteamCMD download) so the terminal output panel is immediately visible.
  useEffect(() => {
    if (isLoading && scrollAreaRef.current) {
      setTimeout(() => {
        if (scrollAreaRef.current) {
          scrollAreaRef.current.scrollTop = scrollAreaRef.current.scrollHeight;
        }
      }, 80);
    }
  }, [isLoading]);

  const canAdvance = () => {
    switch (step) {
      case 0: return true;
      case 1: return baseDirWritable;
      case 2: return backupDirWritable;
      case 3: return steamcmdValidated;
      // Step 4: ProtonGE on Linux, Notifications on Windows (always ok)
      case 4: return IS_LINUX ? protonValidated : true;
      // Step 5: Notifications on Linux (always ok) — doesn't exist on Windows
      case 5: return IS_LINUX ? true : false;
      default: return false;
    }
  };

  const handleNext = async () => {
    if (step === TOTAL_STEPS - 2) {
      // Before completing, initialise the DB at its permanent location then save all settings.
      setSaving(true);
      setSaveError("");
      try {
        // 1. Write bootstrap + create {base_dir}/lokiasam/ (Rust handles old-DB copy).
        await tauriCmd.writeBootstrap(baseDir);

        // 2. Open the DB at its permanent path, applying all migrations.
        const sep = baseDir.includes("\\") ? "\\" : "/";
        const dbPath = baseDir.replace(/[/\\]$/, "") +
          sep + "lokiasam" + sep + "lokiasam.db";
        await initDb(dbPath);

        await setAppSetting("base_dir", baseDir);
        await setAppSetting("backup_dir", backupDir);
        await setAppSetting("steamcmd_path", steamcmdPath);
        if (IS_LINUX && protonPath) {
          await setAppSetting("proton_path", protonPath);
          // Prefix lives alongside the runtime: {baseDir}/proton/prefix/
          // This keeps the fake C: drive co-located with the Proton binaries.
          const sep = baseDir.includes("\\") ? "\\" : "/";
          const prefix = baseDir.replace(/[/\\]$/, "") + sep + "proton" + sep + "prefix";
          await setAppSetting("proton_prefix_path", prefix);
        }
        if (discordWebhook) {
          await setAppSetting("discord_webhook", discordWebhook);
        }
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
    onComplete();
  };

  const stepComponents = IS_LINUX
    ? [
        <WelcomeStep key="welcome" />,
        <BaseDirStep key="basedir" />,
        <BackupDirStep key="backupdir" />,
        <SteamCmdStep key="steamcmd" />,
        <ProtonGEStep key="proton" />,
        <NotificationsStep key="notifications" />,
        <CompleteStep key="complete" onComplete={handleComplete} />,
      ]
    : [
        <WelcomeStep key="welcome" />,
        <BaseDirStep key="basedir" />,
        <BackupDirStep key="backupdir" />,
        <SteamCmdStep key="steamcmd" />,
        <NotificationsStep key="notifications" />,
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
          backgroundImage:
            "radial-gradient(ellipse 80% 50% at 50% -20%, rgba(191,0,255,0.08) 0%, transparent 60%)",
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

      {/* Main content */}
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

            {/* Navigation — hidden on the Complete step (it has its own button) */}
            {step < TOTAL_STEPS - 1 && (
              <div className="flex items-center justify-between mt-6 pt-4 border-t" style={{ borderColor: "rgba(191,0,255,0.1)" }}>
                <Button
                  variant="ghost"
                  onClick={handlePrev}
                  disabled={step === 0 || isLoading}
                  className="gap-2"
                  style={{ color: "var(--text-muted)" }}
                >
                  <ArrowLeft className="w-4 h-4" /> Back
                </Button>

                <span className="text-xs" style={{ color: "var(--text-subtle)" }}>
                  {step + 1} / {TOTAL_STEPS}
                </span>

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
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Branding footer */}
      <div className="relative z-10 text-center pb-4">
        <p className="text-xs" style={{ color: "var(--text-subtle)" }}>
          LokiASAM v0.1.0 · lokisoft.xyz
        </p>
      </div>
    </div>
  );
}
