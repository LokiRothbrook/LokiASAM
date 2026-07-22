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
  MonitorDown, ToggleLeft, ToggleRight, Layers, Send, StopCircle, Palette,
  BookOpen, ShieldCheck, Trash2, TriangleAlert, Eye, EyeOff, Shield,
} from "lucide-react";
import { toast } from "sonner";
import { LokiIcon } from "@/components/shared/LokiIcon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { CommandOutputPanel } from "@/components/shared/CommandOutputPanel";
import { useSetupStore } from "@/store/useSetupStore";
import { useAppStore } from "@/store/useAppStore";
import { tauriCmd, type DirCheckResult, type ProtonEntry, type FirewallStatus, type PortDef } from "@/lib/tauri-commands";
import { applyTheme, ACCENT_OPTIONS, THEME_PRESETS, type ThemeAccent, type ThemePreset } from "@/lib/theme";
import { setAppSetting, initDb, saveNotificationConfig, saveGlobalChannelEvents } from "@/lib/db";
import { NOTIFICATION_EVENTS } from "@/data/game-data";
import { NotificationMatrix } from "@/components/shared/NotificationMatrix";
import { open } from "@tauri-apps/plugin-dialog";
import { useAutostart } from "@/hooks/useAutostart";
import { useOnMount } from "@/hooks/useOnMount";
import { homeDir, tempDir } from "@tauri-apps/api/path";
import { getVersion } from "@tauri-apps/api/app";

interface SetupWizardProps {
  onComplete: (closeToTray: boolean) => void;
}

const IS_LINUX =
  typeof navigator !== "undefined" && !navigator.userAgent.includes("Windows");

const STEPS_WIN = [
  { label: "Welcome",       icon: LokiIcon },
  { label: "Theme",         icon: Palette },
  { label: "Install Dir",   icon: HardDrive },
  { label: "Backup Dir",    icon: FolderOpen },
  { label: "SteamCMD",      icon: Terminal },
  { label: "Mod API Cert",  icon: ShieldCheck },
  { label: "Notifications", icon: Bell },
  { label: "System Tray",   icon: Layers },
  { label: "Updates",       icon: RefreshCw },
  { label: "Complete",      icon: CheckCircle2 },
];

const STEPS_LINUX = [
  { label: "Welcome",       icon: LokiIcon },
  { label: "Theme",         icon: Palette },
  { label: "Install Dir",   icon: HardDrive },
  { label: "Backup Dir",    icon: FolderOpen },
  { label: "SteamCMD",      icon: Terminal },
  { label: "Proton-GE",     icon: Cpu },
  { label: "Mod API Cert",  icon: ShieldCheck },
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
// WipeLokiAsamDialog
// ---------------------------------------------------------------------------

interface WipeLokiAsamDialogProps {
  open: boolean;
  path: string;
  onClose: () => void;
  onWiped: () => void;
}

function WipeLokiAsamDialog({ open, path, onClose, onWiped }: WipeLokiAsamDialogProps) {
  const [fullWipe, setFullWipe] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [wiping, setWiping] = useState(false);

  // When the outer dialog closes, reset state — compared during render
  // rather than in an effect, since it's a synchronous derivation of `open`.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (!open) { setFullWipe(false); setConfirmOpen(false); setWiping(false); }
  }

  const handleFullWipeToggle = () => {
    if (!fullWipe) {
      // Require the secondary confirmation before checking the box.
      setConfirmOpen(true);
    } else {
      setFullWipe(false);
    }
  };

  const handleConfirmFullWipe = () => {
    setConfirmOpen(false);
    setFullWipe(true);
  };

  const handleWipe = async () => {
    setWiping(true);
    try {
      await tauriCmd.wipeLokiAsamDir(path, fullWipe);
      toast.success(fullWipe ? "Directory wiped — ready for a clean install." : "LokiASAM data removed — ready for a clean install.");
      onWiped();
      onClose();
    } catch (e) {
      toast.error("Failed to delete files", { description: String(e) });
    } finally {
      setWiping(false);
    }
  };

  return (
    <>
      {/* Main delete dialog */}
      <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
        <DialogContent showCloseButton={false} className="max-w-md" style={{ background: "var(--popover)", border: "1px solid rgba(255,60,60,0.3)" }}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2" style={{ color: "#ff3c3c" }}>
              <Trash2 className="w-4 h-4" /> Delete LokiASAM Data
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 text-sm" style={{ color: "var(--text-muted)" }}>
            <p>
              This will remove the existing LokiASAM installation from <span className="font-mono text-xs break-all" style={{ color: "var(--text-primary)" }}>{path}</span>.
            </p>

            {/* Base case — always deleted */}
            <div className="rounded-lg p-3 space-y-1" style={{ background: "rgba(255,60,60,0.08)", border: "1px solid rgba(255,60,60,0.2)" }}>
              <p className="font-semibold text-xs uppercase tracking-wide" style={{ color: "#ff3c3c" }}>Will be deleted</p>
              <p className="text-xs">The <span className="font-mono">lokiasam/</span> subfolder — database, config, and logs. Server game files are kept.</p>
            </div>

            {/* Full wipe toggle */}
            <label
              className="flex items-start gap-3 rounded-lg p-3 cursor-pointer transition-colors"
              style={{
                background: fullWipe ? "rgba(255,60,60,0.12)" : "rgba(255,255,255,0.03)",
                border: `1px solid ${fullWipe ? "rgba(255,60,60,0.4)" : "rgba(255,255,255,0.08)"}`,
              }}
            >
              <input
                type="checkbox"
                checked={fullWipe}
                onChange={handleFullWipeToggle}
                className="mt-0.5 shrink-0 accent-red-500"
              />
              <div className="space-y-0.5">
                <p className="font-semibold text-xs" style={{ color: fullWipe ? "#ff3c3c" : "var(--text-primary)" }}>
                  Also delete server files, backups, and all other content
                </p>
                <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                  Permanently removes everything inside this folder — including downloaded game files which may total hundreds of GB. Cannot be undone.
                </p>
              </div>
            </label>
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={onClose} disabled={wiping}
              style={{ borderColor: "rgba(255,255,255,0.15)", color: "var(--text-muted)" }}>
              Cancel
            </Button>
            <Button onClick={handleWipe} disabled={wiping}
              style={{ background: "rgba(255,60,60,0.15)", borderColor: "rgba(255,60,60,0.5)", color: "#ff3c3c" }}>
              {wiping
                ? <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" /> Deleting…</>
                : fullWipe ? <><Trash2 className="w-3 h-3 mr-1.5" /> Delete Everything</> : <><Trash2 className="w-3 h-3 mr-1.5" /> Delete LokiASAM Data</>
              }
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Nested confirmation for full wipe */}
      <Dialog open={confirmOpen} onOpenChange={(v) => { if (!v) setConfirmOpen(false); }}>
        <DialogContent showCloseButton={false} className="max-w-sm" style={{ background: "var(--popover)", border: "1px solid rgba(255,60,60,0.5)" }}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2" style={{ color: "#ff3c3c" }}>
              <TriangleAlert className="w-4 h-4" /> Complete Data Loss Warning
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-3 text-sm">
            <p style={{ color: "var(--text-muted)" }}>
              This will permanently delete <strong style={{ color: "var(--text-primary)" }}>everything</strong> inside:
            </p>
            <p className="font-mono text-xs break-all rounded px-2 py-1.5" style={{ background: "rgba(255,60,60,0.1)", color: "#ff3c3c" }}>
              {path}
            </p>
            <p style={{ color: "var(--text-muted)" }}>
              All old LokiASAM data, server configurations, downloaded game files, and backups will be gone permanently. This cannot be undone.
            </p>
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setConfirmOpen(false)}
              style={{ borderColor: "rgba(255,255,255,0.15)", color: "var(--text-muted)" }}>
              Cancel
            </Button>
            <Button onClick={handleConfirmFullWipe}
              style={{ background: "rgba(255,60,60,0.2)", borderColor: "rgba(255,60,60,0.6)", color: "#ff3c3c" }}>
              <TriangleAlert className="w-3 h-3 mr-1.5" /> Yes, Delete Everything
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
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
            background: "rgba(var(--neon-purple-rgb),0.1)",
            border: "1px solid rgba(var(--neon-purple-rgb),0.3)",
            boxShadow: "0 0 40px rgba(var(--neon-purple-rgb),0.2)",
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
          { label: "Server Management", desc: "Start, Stop & Monitor" },
          { label: "Auto Scheduling",   desc: "Backups & Restarts" },
          { label: "Mod Browser",       desc: "CurseForge integration" },
        ].map((feat) => (
          <div
            key={feat.label}
            className="rounded-lg p-3 text-center"
            style={{
              background: "rgba(var(--neon-purple-rgb),0.05)",
              border: "1px solid rgba(var(--neon-purple-rgb),0.15)",
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
// ThemeStep
// ---------------------------------------------------------------------------

const PRESET_ORDER: ThemePreset[] = ["neon", "abyss", "toxic", "storm"];

function ThemeStep() {
  const { themePreset, themeAccent, setThemePreset, setThemeAccent } = useSetupStore();

  const handlePreset = (p: ThemePreset) => {
    const defaultAccent = THEME_PRESETS[p].defaultAccent;
    setThemePreset(p);
    setThemeAccent(defaultAccent);
    applyTheme(p, defaultAccent);
  };

  const handleAccent = (a: ThemeAccent) => {
    setThemeAccent(a);
    applyTheme(themePreset, a);
  };

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Palette className="w-5 h-5 shrink-0" style={{ color: "var(--neon-purple)", filter: "drop-shadow(0 0 6px rgba(var(--neon-purple-rgb),0.8))" }} />
          <h2 className="text-xl font-bold text-glow-purple" style={{ color: "var(--neon-purple)" }}>
            Choose Your Theme
          </h2>
        </div>
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          Pick a background preset and accent color. You can change these at any time in Settings.
        </p>
      </div>

      {/* Preset selector */}
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
          Background Preset
        </p>
        <div className="grid grid-cols-2 gap-3">
          {PRESET_ORDER.map((p) => {
            const preset = THEME_PRESETS[p];
            const selected = themePreset === p;
            return (
              <button
                key={p}
                onClick={() => handlePreset(p)}
                className="rounded-lg p-3 text-left transition-all"
                style={{
                  background: selected ? "rgba(var(--neon-purple-rgb),0.12)" : preset.background,
                  border: `1px solid ${selected ? "rgba(var(--neon-purple-rgb),0.5)" : "rgba(var(--neon-purple-rgb),0.15)"}`,
                  boxShadow: selected ? "0 0 16px rgba(var(--neon-purple-rgb),0.15)" : "none",
                }}
              >
                <div className="flex items-center gap-2 mb-1">
                  <div className="w-3 h-3 rounded-full" style={{ background: `#${p === "neon" ? "bf00ff" : p === "abyss" ? "4080ff" : p === "toxic" ? "00ff88" : "4080ff"}` }} />
                  <span className="text-sm font-semibold" style={{ color: selected ? "var(--neon-purple)" : "#fff" }}>
                    {preset.label}
                    {selected && <span className="ml-2 text-[10px] font-normal px-1 py-0.5 rounded" style={{ background: "rgba(var(--neon-purple-rgb),0.2)", color: "var(--neon-purple)" }}>Active</span>}
                  </span>
                </div>
                <div className="flex gap-1 mt-1">
                  {[preset.background, preset.surface, preset.textMuted].map((c, i) => (
                    <div key={i} className="h-2 flex-1 rounded" style={{ background: c }} />
                  ))}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Accent selector */}
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
          Accent Color
        </p>
        <div className="flex flex-wrap gap-2 px-1.5 py-1">
          {ACCENT_OPTIONS.map(({ value, label }) => {
            const selected = themeAccent === value;
            const hexMap: Record<ThemeAccent, string> = {
              purple: "#bf00ff", cyan: "#00ffff", green: "#00ff88", pink: "#ff0080",
              orange: "#ff8800", red: "#ff0055", blue: "#4080ff", teal: "#00ffc8", yellow: "#ffdc00",
            };
            const hex = hexMap[value as ThemeAccent] ?? "#bf00ff";
            return (
              <button
                key={value}
                onClick={() => handleAccent(value as ThemeAccent)}
                title={label}
                className="w-8 h-8 rounded-full transition-all"
                style={{
                  background: hex,
                  boxShadow: selected
                    ? `0 0 0 2px #050510, 0 0 0 4px ${hex}, 0 0 10px ${hex}`
                    : "none",
                }}
              />
            );
          })}
        </div>
      </div>

      <div
        className="rounded-lg p-3"
        style={{ background: "rgba(var(--neon-purple-rgb),0.05)", border: "1px solid rgba(var(--neon-purple-rgb),0.12)" }}
      >
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          <span className="font-semibold" style={{ color: "var(--neon-purple)" }}>Tip: </span>
          Changes apply instantly — what you see right now is exactly what you&apos;ll get.
        </p>
      </div>
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
  info: {
    servers: number;
    steamcmd: string;
    proton?: string;
    protonPrefix?: string;
    steamcmdMissing?: boolean;
    protonMissing?: boolean;
    allServersPorts?: Array<{
      serverId: string;
      serverName: string;
      gamePort: number;
      queryPort: number;
      rconPort: number;
    }>;
  };
  importDir: string;
}) {
  const { setSteamcmdPath, setSteamcmdValidated, setProtonPath, setProtonValidated, protonPath } = useSetupStore();
  const [installingSteamcmd, setInstallingSteamcmd] = useState(false);
  const [steamcmdDone, setSteamcmdDone]             = useState(false);
  const [installingProton, setInstallingProton]     = useState(false);
  const [protonDone, setProtonDone]                 = useState(false);

  // Mod Certs
  const [certPhase, setCertPhase] = useState<"idle" | "downloading" | "installing" | "done" | "error">("idle");
  const [certError, setCertError] = useState("");
  const [certSkipped] = useState(false);

  // Firewall
  const [fwPhase, setFwPhase] = useState<"idle" | "checking" | "ready" | "opening" | "done" | "error">("idle");
  const [fwStatus, setFwStatus] = useState<FirewallStatus | null>(null);
  const [fwError, setFwError] = useState("");
  const [fwSkipped] = useState(false);
  const [showFwDialog, setShowFwDialog] = useState(false);

  const handleInstallSteamcmd = async () => {
    const sep = importDir.includes("\\") ? "\\" : "/";
    const targetDir = importDir.replace(/[/\\]$/, "") + sep + "lokiasam" + sep + "steamcmd";
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
    const targetDir = importDir.replace(/[/\\]$/, "") + sep + "lokiasam" + sep + "proton";
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

  const handleInstallCerts = async () => {
    setCertError("");
    try {
      const tmp = await tempDir();
      setCertPhase("downloading");
      const certPath = await tauriCmd.downloadAmazonRootCa(tmp);

      setCertPhase("installing");
      if (IS_LINUX && !protonPath && !info.proton) {
        throw new Error("Proton-GE path not found. Please ensure Proton-GE is validated first.");
      }
      // Use protonPath from setup store if user just selected proton, otherwise use info.proton
      const resolvedProtonPath = protonPath || info.proton;
      const proton = IS_LINUX && resolvedProtonPath ? resolvedProtonPath : undefined;
      const prefix = IS_LINUX && info.protonPrefix ? info.protonPrefix : undefined;
      await tauriCmd.installAmazonRootCa(certPath, proton, prefix);
      setCertPhase("done");
    } catch (e) {
      if (!String(e).includes("Aborted")) {
        setCertError(String(e));
        setCertPhase("error");
      }
    }
  };

  const handleCheckFirewall = useCallback(async () => {
    setFwError("");
    setFwPhase("checking");
    try {
      if (!info.allServersPorts || info.allServersPorts.length === 0) {
        setFwStatus({ firewallType: "none", active: false, ports: [] });
        setFwPhase("done");
        return;
      }

      const allPorts: PortDef[] = [];
      const seen = new Set<string>();
      for (const srv of info.allServersPorts) {
        for (const p of [
          { port: srv.gamePort, protocol: "udp" as const },
          { port: srv.queryPort, protocol: "udp" as const },
          { port: srv.rconPort, protocol: "tcp" as const },
        ]) {
          const key = `${p.port}/${p.protocol}`;
          if (!seen.has(key)) {
            seen.add(key);
            allPorts.push(p);
          }
        }
      }

      if (allPorts.length === 0) {
        setFwStatus({ firewallType: "none", active: false, ports: [] });
        setFwPhase("done");
        return;
      }

      const result = await tauriCmd.checkFirewallPorts(allPorts);
      setFwStatus(result);
      const allCovered = !result.active || result.ports.every((p) => p.covered);
      setFwPhase(allCovered ? "done" : "ready");
    } catch (e) {
      setFwError(String(e));
      setFwPhase("error");
    }
  }, [info.allServersPorts]);

  const handleOpenFirewallPorts = async () => {
    if (!fwStatus) return;
    setFwPhase("opening");
    try {
      const allPorts = fwStatus.ports.map((p) => ({
        port: p.port,
        protocol: p.protocol as "tcp" | "udp",
      }));
      const proton = IS_LINUX && protonDone ? protonPath : undefined;
      await tauriCmd.addFirewallRules(allPorts, proton);

      const updated = await tauriCmd.checkFirewallPorts(allPorts);
      setFwStatus(updated);
      setFwPhase("done");
      setShowFwDialog(false);
    } catch (e) {
      setFwError(String(e));
      setFwPhase("error");
    }
  };

  // Auto-check firewall when servers data loads (doesn't require Proton-GE for checking)
  const syncFirewallCheck = useCallback(() => {
    if (
      fwPhase === "idle" &&
      info.allServersPorts &&
      info.allServersPorts.length > 0
    ) {
      handleCheckFirewall();
    }
  }, [fwPhase, info.allServersPorts, handleCheckFirewall]);
  useOnMount(syncFirewallCheck);

  // Auto-validate found tools
  const syncAutoValidate = useCallback(() => {
    if (info && !info.steamcmdMissing && !steamcmdDone) {
      setSteamcmdDone(true);
    }
    if (info && !IS_LINUX && !info.steamcmdMissing && !protonDone) {
      setProtonDone(true);
    }
    if (info && IS_LINUX && !info.protonMissing && !protonDone) {
      setProtonDone(true);
    }
  }, [info, steamcmdDone, protonDone]);
  useOnMount(syncAutoValidate);

  // Check if cert is already installed
  useEffect(() => {
    (async () => {
      try {
        if (!IS_LINUX || !info.proton || !info.protonPrefix) return;
        const proton = info.proton;
        const prefix = info.protonPrefix;
        const installed = await tauriCmd.checkAmazonRootCaInstalled(proton, prefix);
        if (installed) {
          setCertPhase("done");
        }
      } catch {
        // If check fails, leave as idle so user can manually install
      }
    })();
  }, [protonDone, info?.proton, info?.protonPrefix]);

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
              style={{ background: "rgba(var(--neon-purple-rgb),0.12)", border: "1px solid rgba(var(--neon-purple-rgb),0.35)", color: "var(--neon-purple)" }}>
              {installingSteamcmd ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
              Install Now
            </Button>
            {installingSteamcmd && (
              <Button onClick={() => tauriCmd.abortOperation("steamcmd_install")} size="sm" variant="outline" className="gap-1 h-7 text-xs bg-[rgba(255,0,85,0.08)]! hover:bg-[rgba(255,0,85,0.2)]!"
                style={{ color: "var(--neon-red)", borderColor: "rgba(255,0,85,0.3)" }}>
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
              style={{ background: "rgba(var(--neon-purple-rgb),0.12)", border: "1px solid rgba(var(--neon-purple-rgb),0.35)", color: "var(--neon-purple)" }}>
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

      {/* Mod Certs row */}
      <div className="pt-2 border-t" style={{ borderColor: "rgba(255,255,255,0.1)" }}>
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-medium" style={{ color: "var(--text-primary)" }}>Amazon Mod API Cert</p>
          {certPhase === "done" && <CheckCircle2 className="w-3.5 h-3.5" style={{ color: "var(--neon-green)" }} />}
          {(certPhase === "downloading" || certPhase === "installing") && (
            <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: "var(--text-muted)" }} />
          )}
        </div>

        {certPhase === "idle" && !certSkipped && (
          <div className="space-y-2">
            <div className="flex gap-2 flex-wrap">
              <Button
                onClick={handleInstallCerts}
                disabled={!allGood || !protonAllGood}
                size="sm"
                className="gap-1.5 h-7 text-xs"
                style={{
                  background: !allGood || !protonAllGood ? "rgba(var(--neon-purple-rgb),0.08)" : "rgba(var(--neon-purple-rgb),0.12)",
                  border: "1px solid rgba(var(--neon-purple-rgb),0.35)",
                  color: !allGood || !protonAllGood ? "rgba(var(--neon-purple-rgb),0.5)" : "var(--neon-purple)",
                }}
              >
                <ShieldCheck className="w-3 h-3" /> Install Cert
              </Button>
            </div>
            <p className="text-xs" style={{ color: !allGood || !protonAllGood ? "var(--text-subtle)" : "var(--text-muted)" }}>
              {!allGood || !protonAllGood ? "SteamCMD and Proton-GE must be ready first." : "Install later in Settings if needed."}
            </p>
          </div>
        )}

        {(certPhase === "downloading" || certPhase === "installing") && (
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            {certPhase === "downloading" ? "Downloading…" : "Installing…"}
          </p>
        )}

        {certPhase === "done" && (
          <p className="text-xs" style={{ color: "var(--neon-green)" }}>✓ Installed</p>
        )}

        {certPhase === "error" && (
          <div className="text-xs space-y-1">
            <p style={{ color: "var(--neon-red)" }}>Installation failed</p>
            <p style={{ color: "var(--text-muted)" }}>{certError}</p>
            <Button
              onClick={handleInstallCerts}
              size="sm"
              className="gap-1.5 h-7 text-xs mt-2"
              style={{
                background: "rgba(var(--neon-purple-rgb),0.12)",
                border: "1px solid rgba(var(--neon-purple-rgb),0.35)",
                color: "var(--neon-purple)",
              }}
            >
              <ShieldCheck className="w-3 h-3" /> Retry
            </Button>
          </div>
        )}

        {certSkipped && certPhase !== "done" && (
          <p className="text-xs" style={{ color: "var(--text-subtle)" }}>
            Skipped — can be installed later in Settings.
          </p>
        )}
      </div>

      {/* Firewall row */}
      <div className="pt-2 border-t" style={{ borderColor: "rgba(255,255,255,0.1)" }}>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-medium" style={{ color: "var(--text-primary)" }}>Firewall Ports</p>
            {fwPhase === "done" && <CheckCircle2 className="w-3.5 h-3.5" style={{ color: "var(--neon-green)" }} />}
            {(fwPhase === "checking" || fwPhase === "opening") && (
              <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: "var(--text-muted)" }} />
            )}
          </div>

          {fwPhase === "checking" && (
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>Checking firewall…</p>
          )}

          {fwStatus && !fwStatus.active && (fwPhase === "done" || fwPhase === "ready") && (
            <p className="text-xs" style={{ color: "var(--neon-green)" }}>✓ No active firewall detected.</p>
          )}

          {fwStatus && fwStatus.active && (fwPhase === "ready" || fwPhase === "done") && (
            <div className="space-y-2">
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                {fwPhase === "done"
                  ? "✓ All ports covered."
                  : `${fwStatus.ports.filter((p) => !p.covered).length} port(s) need opening.`}
              </p>
              {fwPhase === "ready" && fwStatus.ports.filter((p) => !p.covered).length > 0 && (
                <Button
                  onClick={() => setShowFwDialog(true)}
                  disabled={!allGood || !protonAllGood}
                  size="sm"
                  className="gap-1.5 h-7 text-xs"
                  style={{
                    background: !allGood || !protonAllGood ? "rgba(var(--neon-purple-rgb),0.08)" : "rgba(var(--neon-purple-rgb),0.12)",
                    border: "1px solid rgba(var(--neon-purple-rgb),0.35)",
                    color: !allGood || !protonAllGood ? "rgba(var(--neon-purple-rgb),0.5)" : "var(--neon-purple)",
                  }}
                >
                  <Shield className="w-3 h-3" /> Open Missing Ports
                </Button>
              )}
              {fwPhase === "ready" && fwStatus.ports.filter((p) => !p.covered).length === 0 && (
                <Button
                  onClick={() => setFwPhase("done")}
                  size="sm"
                  className="gap-1.5 h-7 text-xs"
                  style={{
                    background: "rgba(0,255,136,0.08)",
                    border: "1px solid rgba(0,255,136,0.4)",
                    color: "var(--neon-green)",
                  }}
                >
                  <CheckCircle2 className="w-3 h-3" /> All Ports Open
                </Button>
              )}
            </div>
          )}

          {fwPhase === "error" && (
            <div className="text-xs space-y-1">
              <p style={{ color: "var(--neon-red)" }}>Check failed</p>
              <p style={{ color: "var(--text-muted)" }}>{fwError}</p>
              <Button
                onClick={handleCheckFirewall}
                size="sm"
                className="gap-1.5 h-7 text-xs mt-2"
                style={{
                  background: "rgba(var(--neon-purple-rgb),0.12)",
                  border: "1px solid rgba(var(--neon-purple-rgb),0.35)",
                  color: "var(--neon-purple)",
                }}
              >
                <Shield className="w-3 h-3" /> Retry Check
              </Button>
            </div>
          )}

          {fwSkipped && fwPhase !== "done" && (
            <p className="text-xs" style={{ color: "var(--text-subtle)" }}>
              Skipped — configure firewall manually if needed.
            </p>
          )}

        </div>

      {/* Firewall Dialog */}
      <Dialog open={showFwDialog} onOpenChange={setShowFwDialog}>
        <DialogContent
          showCloseButton={false}
          className="max-w-lg"
          style={{
            background: "var(--popover)",
            border: "1px solid rgba(var(--neon-purple-rgb),0.3)",
          }}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Shield className="w-4 h-4" style={{ color: "var(--neon-purple)" }} />
              Open Firewall Ports
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 max-h-96 overflow-y-auto">
            {info.allServersPorts?.map((srv) => {
              const srvPortDefs = [
                { port: srv.gamePort, protocol: "udp" as const, label: "Game Port" },
                { port: srv.queryPort, protocol: "udp" as const, label: "Query Port" },
                { port: srv.rconPort, protocol: "tcp" as const, label: "RCON Port" },
              ];

              const srvStatus = srvPortDefs
                .map((pd) => ({
                  ...pd,
                  status: fwStatus?.ports.find(
                    (p) => p.port === pd.port && p.protocol === pd.protocol
                  ),
                }))
                .filter((x) => x.status);

              if (srvStatus.length === 0) return null;

              return (
                <div key={srv.serverId} className="space-y-2">
                  <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                    {srv.serverName}
                  </p>
                  <div className="space-y-1 pl-3">
                    {srvStatus.map((pd) => (
                      <div
                        key={`${pd.port}-${pd.protocol}`}
                        className="flex items-center gap-2 text-xs"
                      >
                        {pd.status?.covered ? (
                          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--neon-green)" }} />
                        ) : (
                          <AlertCircle className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--neon-red)" }} />
                        )}
                        <span style={{ color: "var(--text-primary)" }}>
                          {pd.port}/{pd.protocol.toUpperCase()}
                        </span>
                        <span style={{ color: "var(--text-muted)" }}>
                          ({pd.label})
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setShowFwDialog(false)}
              style={{
                borderColor: "rgba(255,255,255,0.15)",
                color: "var(--text-muted)",
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleOpenFirewallPorts}
              disabled={fwPhase === "opening"}
              style={{
                background: "rgba(var(--neon-purple-rgb),0.15)",
                border: "1px solid rgba(var(--neon-purple-rgb),0.5)",
                color: "var(--neon-purple)",
              }}
            >
              {fwPhase === "opening" ? (
                <>
                  <Loader2 className="w-3 h-3 mr-1.5 animate-spin" /> Opening…
                </>
              ) : (
                <>
                  <Shield className="w-3 h-3 mr-1.5" /> Open Ports
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {allGood && protonAllGood && (
        <p className="text-xs mt-1" style={{ color: "var(--neon-green)" }}>
          ✓ SteamCMD and {IS_LINUX ? "Proton-GE are " : "is "} ready. Mod certs and firewall are optional. Click &quot;Import &amp; Finish&quot; below to continue.
        </p>
      )}
    </div>
  );
}

// BaseDirStep — includes "Import previous install" tab
// ---------------------------------------------------------------------------

/**
 * Shared directory-check-with-debounce state for BaseDirStep and
 * BackupDirStep, which were previously two copies of the same
 * dirResult/checking/validateDir/debounce-cleanup logic differing only in
 * which store setter they call.
 */
function useDirValidation(setWritable: (w: boolean) => void) {
  const [dirResult, setDirResult] = useState<DirCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const validateDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const validateDir = useCallback(async (path: string) => {
    if (!path.trim()) return;
    setChecking(true);
    setDirResult(null);
    try {
      const result = await tauriCmd.checkDir(path);
      setDirResult(result);
      setWritable(result.writable);
    } catch {
      const fallback: DirCheckResult = { writable: false, freeBytes: 0, error: "Could not check directory.", isNew: false, hasLokiasam: false, isEmpty: false };
      setDirResult(fallback);
      setWritable(false);
    } finally {
      setChecking(false);
    }
  }, [setWritable]);

  useEffect(() => () => { if (validateDebounceRef.current) clearTimeout(validateDebounceRef.current); }, []);

  /** Clears the current result and (re-)schedules a debounced validateDir call. */
  const validateDirDebounced = useCallback((path: string) => {
    setDirResult(null);
    setWritable(false);
    if (validateDebounceRef.current) clearTimeout(validateDebounceRef.current);
    if (path.trim()) {
      validateDebounceRef.current = setTimeout(() => validateDir(path), 600);
    }
  }, [validateDir, setWritable]);

  return { dirResult, checking, validateDir, validateDirDebounced };
}

function BaseDirStep() {
  const {
    baseDir, setBaseDir, setBackupDir, setBaseDirWritable,
    importMode, setImportMode, importDir, setImportDir, importValid, setImportValid,
  } = useSetupStore();
  const { dirResult, checking, validateDir, validateDirDebounced } = useDirValidation(setBaseDirWritable);
  const [wipeOpen, setWipeOpen] = useState(false);
  const [importChecking, setImportChecking] = useState(false);
  const [importError, setImportError] = useState("");
  const [importInfo, setImportInfo] = useState<{
    servers: number;
    steamcmd: string;
    proton?: string;
    protonPrefix?: string;
    steamcmdMissing?: boolean;
    protonMissing?: boolean;
    allServersPorts?: Array<{
      serverId: string;
      serverName: string;
      gamePort: number;
      queryPort: number;
      rconPort: number;
    }>;
  } | null>(null);

  // Auto-fill with platform default on mount
  useEffect(() => {
    (async () => {
      try {
        const home = await homeDir();
        const sep = home.includes("\\") ? "\\" : "/";
        const defaultDir = home.replace(/[/\\]$/, "") + sep + "Ark-Servers";
        setBaseDir(defaultDir);
        setBackupDir(defaultDir + sep + "backups");
        await validateDir(defaultDir);
      } catch {
        // Outside Tauri (dev preview) — leave blank
      }
    })();
  }, [setBaseDir, setBackupDir, validateDir]);

  const handleChange = (value: string) => {
    setBaseDir(value);
    const sep = value.includes("\\") ? "\\" : "/";
    setBackupDir(value.replace(/[/\\]$/, "") + sep + "backups");
    validateDirDebounced(value);
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

      // Check if stored paths exist; if not, check fallback locations in the importing folder
      let resolvedSteamcmdPath = steamcmdPath;
      let resolvedProtonPath = protonPath;
      let steamcmdExists = steamcmdPath ? await tauriCmd.checkFileExists(steamcmdPath) : false;
      let protonExists = protonPath ? await tauriCmd.checkFileExists(protonPath) : false;

      // If steamcmd not found at stored location, check fallback
      if (!steamcmdExists) {
        const isWindows = typeof window !== "undefined" && navigator.userAgent.includes("Windows");
        const fallbackSteamcmd = importDir.replace(/[/\\]$/, "") + sep + "lokiasam" + sep + "steamcmd" + sep + (isWindows ? "steamcmd.exe" : "steamcmd.sh");
        if (await tauriCmd.checkFileExists(fallbackSteamcmd)) {
          resolvedSteamcmdPath = fallbackSteamcmd;
          steamcmdExists = true;
        }
      }

      // If proton not found at stored location, check fallback directory (only on Linux)
      if (!protonExists && typeof window !== "undefined" && !navigator.userAgent.includes("Windows")) {
        const fallbackDir = importDir.replace(/[/\\]$/, "") + sep + "lokiasam" + sep + "proton";
        if (await tauriCmd.checkFileExists(fallbackDir)) {
          // Look specifically inside lokiasam/proton/ for GE-Proton* subdirectories
          // and verify each has a valid proton executable
          try {
            const found = await tauriCmd.scanForProton(importDir);
            // Filter to only those inside the fallback directory
            const localProtons = found.filter(p => p.path.startsWith(fallbackDir));
            if (localProtons.length > 0) {
              // Validate the first found Proton to ensure it's complete (has proton executable)
              const isValid = await tauriCmd.validateProtonPath(localProtons[0].path);
              if (isValid) {
                resolvedProtonPath = localProtons[0].path;
                protonExists = true;
              }
            }
          } catch {
            // If scanning fails, proton stays not found
          }
        }
      }

      // During import: ALWAYS compute prefix from importDir, ignore stored protonPrefixPath
      // Proton can be external, but prefix is always local to this installation
      let resolvedPrefix: string | undefined;
      if (typeof window !== "undefined" && !navigator.userAgent.includes("Windows")) {
        resolvedPrefix = importDir.replace(/[/\\]$/, "") + sep + "lokiasam" + sep + "proton" + sep + "prefix";
      }

      // Build all servers' port data for firewall checking
      const allServersPorts = servers.map((srv) => ({
        serverId: srv.id,
        serverName: srv.name,
        gamePort: srv.port,
        queryPort: srv.query_port,
        rconPort: srv.rcon_port,
      }));

      setImportInfo({
        servers: servers.length,
        steamcmd: resolvedSteamcmdPath ?? "(not set)",
        proton: resolvedProtonPath ?? undefined,
        protonPrefix: resolvedPrefix ?? undefined,
        steamcmdMissing: !resolvedSteamcmdPath || !steamcmdExists,
        protonMissing: typeof window !== "undefined" && !navigator.userAgent.includes("Windows") && (!resolvedProtonPath || !protonExists),
        allServersPorts,
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
    : baseDir ? "rgba(var(--neon-purple-rgb),0.4)" : "rgba(var(--neon-purple-rgb),0.2)";

  return (
    <div className="space-y-5">
      {/* Card header */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <HardDrive className="w-5 h-5 shrink-0" style={{ color: "var(--neon-purple)", filter: "drop-shadow(0 0 6px rgba(var(--neon-purple-rgb),0.8))" }} />
          <h2 className="text-xl font-bold text-glow-purple" style={{ color: "var(--neon-purple)" }}>
            How would you like to set up?
          </h2>
        </div>
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          Start fresh with a new install, or import an existing LokiASAM setup.
        </p>
      </div>

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
              background: importMode === key ? "rgba(var(--neon-purple-rgb),0.12)" : "var(--surface)",
              border: `1px solid ${importMode === key ? "rgba(var(--neon-purple-rgb),0.5)" : "rgba(var(--neon-purple-rgb),0.15)"}`,
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
              This is where your ASA server files will be installed. Choose a drive with at least 40 GB of free space.
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
                style={{ background: "var(--surface)", borderColor, color: "var(--text-primary)" }}
              />
              <Button
                onClick={pickDir}
                variant="outline"
                className="gap-2 shrink-0"
                style={{ borderColor: "rgba(var(--neon-purple-rgb),0.4)", color: "var(--neon-purple)", background: "rgba(var(--neon-purple-rgb),0.05)" }}
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

          {/* ── LokiASAM already installed here ── */}
          {dirResult?.hasLokiasam && (
            <div className="rounded-lg p-4 space-y-3" style={{ background: "rgba(255,136,0,0.08)", border: "1px solid rgba(255,136,0,0.35)" }}>
              <div className="flex items-start gap-2">
                <TriangleAlert className="w-4 h-4 shrink-0 mt-0.5" style={{ color: "#ffaa00" }} />
                <div className="space-y-1">
                  <p className="text-sm font-semibold" style={{ color: "#ffaa00" }}>LokiASAM is already installed here</p>
                  <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                    Continuing will overwrite your database — all server configurations, schedules, and settings will be permanently lost.
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={() => { setImportMode(true); setImportDir(baseDir); setImportError(""); }}
                  className="gap-1.5 h-7 text-xs"
                  style={{ background: "rgba(var(--neon-purple-rgb),0.12)", border: "1px solid rgba(var(--neon-purple-rgb),0.4)", color: "var(--neon-purple)" }}
                >
                  <MonitorDown className="w-3 h-3" /> Switch to Import
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setWipeOpen(true)}
                  className="gap-1.5 h-7 text-xs"
                  style={{ color: "#ff3c3c", border: "1px solid rgba(255,60,60,0.3)" }}
                >
                  <Trash2 className="w-3 h-3" /> Delete LokiASAM Data
                </Button>
              </div>
            </div>
          )}

          {/* ── Directory has other content (not LokiASAM) ── */}
          {dirResult?.writable && !dirResult.hasLokiasam && !dirResult.isNew && !dirResult.isEmpty && (
            <div className="rounded-lg p-3 flex items-start gap-2" style={{ background: "rgba(255,136,0,0.06)", border: "1px solid rgba(255,136,0,0.25)" }}>
              <TriangleAlert className="w-4 h-4 shrink-0 mt-0.5" style={{ color: "#ffaa00" }} />
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                This directory is not empty. Server files will be installed alongside existing content.
              </p>
            </div>
          )}
        </>
      )}

      {/* Wipe dialog */}
      <WipeLokiAsamDialog
        open={wipeOpen}
        path={baseDir}
        onClose={() => setWipeOpen(false)}
        onWiped={() => validateDir(baseDir)}
      />

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
                  background: "var(--surface)",
                  borderColor: importValid ? "rgba(0,255,136,0.5)" : importDir ? "rgba(var(--neon-purple-rgb),0.4)" : "rgba(var(--neon-purple-rgb),0.2)",
                  color: "var(--text-primary)",
                }}
              />
              <Button
                onClick={pickImportDir}
                variant="outline"
                className="gap-2 shrink-0"
                style={{ borderColor: "rgba(var(--neon-purple-rgb),0.4)", color: "var(--neon-purple)", background: "rgba(var(--neon-purple-rgb),0.05)" }}
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
                background: importValid ? "rgba(0,255,136,0.08)" : "rgba(var(--neon-purple-rgb),0.08)",
                border: `1px solid ${importValid ? "rgba(0,255,136,0.4)" : "rgba(var(--neon-purple-rgb),0.3)"}`,
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
  const { dirResult, checking, validateDir, validateDirDebounced } = useDirValidation(setBackupDirWritable);

  const syncValidateOnMount = useCallback(() => {
    if (backupDir) validateDir(backupDir);
  }, [backupDir, validateDir]);
  useOnMount(syncValidateOnMount);

  const handleChange = (value: string) => {
    setBackupDir(value);
    validateDirDebounced(value);
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
    : backupDir ? "rgba(var(--neon-purple-rgb),0.4)" : "rgba(var(--neon-purple-rgb),0.2)";

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <FolderOpen className="w-5 h-5 shrink-0" style={{ color: "var(--neon-purple)", filter: "drop-shadow(0 0 6px rgba(var(--neon-purple-rgb),0.8))" }} />
          <h2 className="text-xl font-bold text-glow-purple" style={{ color: "var(--neon-purple)" }}>
            Where would you like to save backups?
          </h2>
        </div>
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          This is where Server, INI and other backup 7z archives will be stored.
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
            style={{ background: "var(--surface)", borderColor, color: "var(--text-primary)" }}
          />
          <Button
            onClick={pickDir}
            variant="outline"
            className="gap-2 shrink-0"
            style={{ borderColor: "rgba(var(--neon-purple-rgb),0.4)", color: "var(--neon-purple)", background: "rgba(var(--neon-purple-rgb),0.05)" }}
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
          Backups are 7z archives and can be large (5–30 GB per server).
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
    ? baseDir.replace(/\/$/, "").replace(/\\$/, "") + "/lokiasam/steamcmd"
    : "/your/base/dir/lokiasam/steamcmd";

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
        setSteamcmdValidated(false);
      }
    } catch (err) {
      const msg = String(err);
      if (msg === "Aborted") {
        setCanceled(true);
        setSteamcmdValidated(false);
        // Clean up any partial steamcmd files
        tauriCmd.deleteDirectory(autoSteamcmdTarget).catch(() => {});
      } else {
        setError(msg);
        setSteamcmdValidated(false);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleManualValidate = async () => {
    if (!steamcmdPath) { setError("Enter the path to your SteamCMD executable."); return; }
    setError("");
    setLoading(true, "Validating SteamCMD...");
    setOutputChannel("validate");
    try {
      const ok = await tauriCmd.validateSteamcmd(steamcmdPath);
      if (ok) {
        setSteamcmdValidated(true);
      } else {
        setError("SteamCMD validation failed. Make sure the path is correct.");
        setSteamcmdValidated(false);
      }
    } catch (err) {
      setError(String(err));
      setSteamcmdValidated(false);
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
        <div className="flex items-center gap-2 mb-1">
          <Terminal className="w-5 h-5 shrink-0" style={{ color: "var(--neon-purple)", filter: "drop-shadow(0 0 6px rgba(var(--neon-purple-rgb),0.8))" }} />
          <h2 className="text-xl font-bold text-glow-purple" style={{ color: "var(--neon-purple)" }}>
            SteamCMD Setup
          </h2>
        </div>
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          SteamCMD is required to download and update ASA server files from Steam.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {[
          { mode: "auto" as const, label: "Auto-Download", desc: `Download into ${autoSteamcmdTarget}` },
          { mode: "manual" as const, label: "I have SteamCMD", desc: "Point to an existing install" },
        ].map(({ mode, label, desc }) => {
          // Lock tabs only in auto mode (downloading or validated). Manual mode is always switchable.
          const isTabLocked = (isLoading || steamcmdValidated) && steamcmdMode === "auto";
          return (
            <button
              key={mode}
              onClick={() => {
                if (!isTabLocked) {
                  setSteamcmdMode(mode);
                  setSteamcmdValidated(false);
                  setError("");
                  setOutputChannel(null);
                }
              }}
              disabled={isTabLocked}
              className="rounded-lg p-4 text-left transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                background: steamcmdMode === mode ? "rgba(var(--neon-purple-rgb),0.1)" : "var(--surface)",
                border: `1px solid ${steamcmdMode === mode ? "rgba(var(--neon-purple-rgb),0.5)" : "rgba(var(--neon-purple-rgb),0.15)"}`,
                boxShadow: steamcmdMode === mode ? "0 0 16px rgba(var(--neon-purple-rgb),0.15)" : "none",
              }}
            >
              <p className="text-sm font-semibold" style={{ color: steamcmdMode === mode ? "var(--neon-purple)" : "var(--text-muted)" }}>
                {label}
              </p>
              <p className="text-xs mt-1 font-mono" style={{ color: "var(--text-muted)" }}>{desc}</p>
            </button>
          );
        })}
      </div>

      {steamcmdMode === "auto" && (
        <div className="space-y-2">
          <Button
            onClick={handleAutoDownload}
            disabled={isLoading || !baseDir || steamcmdValidated}
            className="w-full gap-2"
            style={{
              background: steamcmdValidated ? "rgba(0,255,136,0.1)" : "rgba(var(--neon-purple-rgb),0.15)",
              border: `1px solid ${steamcmdValidated ? "rgba(0,255,136,0.4)" : "rgba(var(--neon-purple-rgb),0.4)"}`,
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
              size="sm" variant="outline" className="w-full gap-1.5 bg-[rgba(255,0,85,0.08)]! hover:bg-[rgba(255,0,85,0.2)]!"
              style={{ color: "var(--neon-red)", borderColor: "rgba(255,0,85,0.3)" }}>
              <StopCircle className="w-3 h-3" /> Cancel Install
            </Button>
          )}
        </div>
      )}

      {steamcmdMode === "manual" && (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs" style={{ color: "var(--text-primary)" }}>
              Path to SteamCMD executable
            </Label>
            <p className="text-xs" style={{ color: "var(--text-subtle)" }}>
              Enter the full path to your existing <span className="font-mono">steamcmd.sh</span> (Linux) or <span className="font-mono">steamcmd.exe</span> (Windows).
            </p>
          </div>
          <div className="flex gap-2">
            <Input
              value={steamcmdPath}
              onChange={(e) => { setSteamcmdPath(e.target.value); setSteamcmdValidated(false); }}
              placeholder="/path/to/steamcmd.sh"
              className="flex-1 font-mono text-sm"
              style={{
                background: "var(--surface)",
                borderColor: steamcmdValidated ? "rgba(0,255,136,0.4)" : "rgba(var(--neon-purple-rgb),0.2)",
                color: "var(--text-primary)",
              }}
            />
            <Button
              onClick={pickExe}
              variant="outline"
              className="gap-2 shrink-0"
              style={{ borderColor: "rgba(var(--neon-purple-rgb),0.4)", color: "var(--neon-purple)", background: "rgba(var(--neon-purple-rgb),0.05)" }}
            >
              <FolderOpen className="w-4 h-4" /> Browse
            </Button>
          </div>
          <Button
            onClick={handleManualValidate}
            disabled={isLoading || !steamcmdPath || steamcmdValidated}
            className="w-full gap-2"
            style={{
              background: steamcmdValidated ? "rgba(0,255,136,0.1)" : "rgba(var(--neon-purple-rgb),0.15)",
              border: `1px solid ${steamcmdValidated ? "rgba(0,255,136,0.4)" : "rgba(var(--neon-purple-rgb),0.4)"}`,
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
  const [manuallyAddedPaths, setManuallyAddedPaths] = useState<Set<string>>(new Set());
  const [showManagedConfirm, setShowManagedConfirm] = useState(false);
  const detectedListRef = useRef<HTMLDivElement>(null);

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      const results = await tauriCmd.scanForProton(baseDir);
      // Preserve manually added paths during rescan
      const preserved = results.filter(e => !manuallyAddedPaths.has(e.path));
      const manual = Array.from(manuallyAddedPaths)
        .map(path => found.find(e => e.path === path))
        .filter((e): e is ProtonEntry => e !== undefined);
      setFound([...preserved, ...manual]);
    } catch { /* ignore */ } finally {
      setScanning(false);
    }
  }, [baseDir, manuallyAddedPaths, found]);

  // Latest-scan ref so the mode-change trigger below doesn't need `scan`
  // itself as a dependency (its identity churns with `found`/`manuallyAddedPaths`).
  const scanRef = useRef(scan);
  useEffect(() => {
    scanRef.current = scan;
  });

  const syncScanOnModeChange = useCallback(() => {
    if (protonMode === "existing") scanRef.current();
  }, [protonMode]);
  useOnMount(syncScanOnModeChange);

  const handleSelectDetected = async (entry: ProtonEntry) => {
    if (validating) return;
    setError("");
    setProtonPath("");
    setValidating(entry.path);
    try {
      const ok = await tauriCmd.validateProtonPath(entry.path);
      if (ok) {
        setProtonPath(entry.path);
        setProtonVersion(entry.version);
        setProtonValidated(true);
        // Auto-scroll to show the selected item
        setTimeout(() => {
          const selected = detectedListRef.current?.querySelector('[data-selected="true"]');
          selected?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }, 50);
      } else {
        setError(`${entry.version} does not appear to be a valid Proton-GE installation.`);
        setProtonValidated(false);
      }
    } catch (e) {
      setError(String(e));
      setProtonValidated(false);
    } finally {
      setValidating(null);
    }
  };

  const handleDownload = async () => {
    const targetDir = baseDir.replace(/[/\\]$/, "") + "/lokiasam/proton";
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
        setProtonValidated(false);
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
    setProtonPath("");
    const path = manualPath.trim();
    const versionName = path.split("/").pop() || path;
    try {
      const ok = await tauriCmd.validateProtonPath(path);
      if (ok) {
        const newEntry: ProtonEntry = { path, version: versionName };
        setFound(prev => [...prev.filter(e => e.path !== path), newEntry]);
        setManuallyAddedPaths(prev => new Set([...prev, path]));
        setProtonPath(path);
        setProtonVersion(versionName);
        setProtonValidated(true);
        // Auto-scroll to the newly added entry
        setTimeout(() => {
          detectedListRef.current?.scrollTo({ top: detectedListRef.current.scrollHeight, behavior: "smooth" });
        }, 100);
      } else {
        setError("Validation failed — check the path contains a `proton` script and `files/bin/wine64`.");
        setProtonValidated(false);
      }
    } catch (e) {
      setError(String(e));
      setProtonValidated(false);
    }
  };

  const pickDir = async () => {
    const picked = await open({ directory: true, multiple: false, title: "Select Proton-GE Directory" });
    if (typeof picked === "string" && picked) setManualPath(picked);
  };

  const managedTarget = baseDir
    ? baseDir.replace(/\/$/, "").replace(/\\$/, "") + "/lokiasam/proton"
    : "/your/base/dir/lokiasam/proton";

  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Cpu className="w-5 h-5 shrink-0" style={{ color: "var(--neon-purple)", filter: "drop-shadow(0 0 6px rgba(var(--neon-purple-rgb),0.8))" }} />
          <h2 className="text-xl font-bold text-glow-purple" style={{ color: "var(--neon-purple)" }}>
            Proton-GE Setup
          </h2>
        </div>
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          ASA only ships a Windows binary. Proton-GE allows us to run the Windows binary on Linux.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {([
          { mode: "managed" as const, label: "Managed by LokiASAM", desc: `Download & update automatically into ${managedTarget}` },
          { mode: "existing" as const, label: "Use existing installation", desc: "Point to a Proton-GE you already have" },
        ]).map(({ mode, label, desc }) => {
          // Only lock tabs in managed mode when downloading/validated. Existing mode is always switchable.
          const isTabLocked = (isLoading || protonValidated) && protonMode === "managed";
          return (
            <button
              key={mode}
              onClick={() => {
                if (!isTabLocked) {
                  if (mode === "managed" && protonMode === "existing") {
                    // Warn before handing control to LokiASAM
                    setShowManagedConfirm(true);
                  } else {
                    setProtonMode(mode);
                    setProtonPath("");
                    setProtonValidated(false);
                    setError("");
                    setShowDownload(false);
                  }
                }
              }}
              disabled={isTabLocked}
              className="rounded-lg p-4 text-left transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                background: protonMode === mode ? "rgba(var(--neon-purple-rgb),0.1)" : "var(--surface)",
                border: `1px solid ${protonMode === mode ? "rgba(var(--neon-purple-rgb),0.5)" : "rgba(var(--neon-purple-rgb),0.15)"}`,
                boxShadow: protonMode === mode ? "0 0 16px rgba(var(--neon-purple-rgb),0.15)" : "none",
              }}
            >
              <p className="text-sm font-semibold" style={{ color: protonMode === mode ? "var(--neon-purple)" : "var(--text-muted)" }}>
                {label}
              </p>
              <p className="text-xs mt-1 font-mono" style={{ color: "var(--text-muted)" }}>{desc}</p>
            </button>
          );
        })}
      </div>

      {protonMode === "managed" && (
        <div className="space-y-2">
          <Button
            onClick={handleDownload}
            disabled={isLoading || !baseDir || protonValidated}
            className="w-full gap-2"
            style={{
              background: protonValidated ? "rgba(0,255,136,0.1)" : "rgba(var(--neon-purple-rgb),0.15)",
              border: `1px solid ${protonValidated ? "rgba(0,255,136,0.4)" : "rgba(var(--neon-purple-rgb),0.4)"}`,
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
              size="sm" variant="outline" className="w-full gap-1.5 bg-[rgba(255,0,85,0.08)]! hover:bg-[rgba(255,0,85,0.2)]!"
              style={{ color: "var(--neon-red)", borderColor: "rgba(255,0,85,0.3)" }}>
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
              <div ref={detectedListRef} className="space-y-1.5 max-h-96 overflow-y-auto">
                {found.map((entry) => {
                  const isValidating = validating === entry.path;
                  const isSelected = protonPath === entry.path;
                  return (
                    <button
                      key={entry.path}
                      data-selected={isSelected}
                      onClick={() => handleSelectDetected(entry)}
                      disabled={!!validating}
                      className="w-full text-left rounded-lg px-3 py-2 text-xs transition-all disabled:opacity-60"
                      style={{
                        background: isSelected ? "rgba(0,255,136,0.07)" : isValidating ? "rgba(var(--neon-purple-rgb),0.1)" : "var(--surface)",
                        border: `1px solid ${isSelected ? "rgba(0,255,136,0.4)" : isValidating ? "rgba(var(--neon-purple-rgb),0.4)" : "rgba(var(--neon-purple-rgb),0.15)"}`,
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
                style={{ background: "var(--surface)", borderColor: "rgba(var(--neon-purple-rgb),0.2)", color: "var(--text-primary)" }}
              />
              <Button
                onClick={pickDir}
                variant="outline"
                className="shrink-0"
                style={{ borderColor: "rgba(var(--neon-purple-rgb),0.4)", color: "var(--neon-purple)", background: "rgba(var(--neon-purple-rgb),0.05)" }}
              >
                <FolderOpen className="w-4 h-4" />
              </Button>
            </div>
            <Button
              onClick={handleManualValidate}
              disabled={!manualPath.trim()}
              size="sm"
              className="gap-2"
              style={{ background: "rgba(var(--neon-purple-rgb),0.08)", border: "1px solid rgba(var(--neon-purple-rgb),0.3)", color: "var(--neon-purple)" }}
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

      {/* Managed-mode risk confirmation */}
      <Dialog open={showManagedConfirm} onOpenChange={(v) => { if (!v) setShowManagedConfirm(false); }}>
        <DialogContent showCloseButton={false} className="max-w-md"
          style={{ background: "var(--popover)", border: "1px solid rgba(255,136,0,0.35)" }}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2" style={{ color: "var(--neon-orange)" }}>
              <AlertCircle className="w-5 h-5" /> Switch to Managed Mode?
            </DialogTitle>
            <DialogDescription className="space-y-2 pt-1">
              <span className="block">
                LokiASAM will take full control of downloading and updating Proton-GE into its own managed directory.
              </span>
              <span className="block font-medium" style={{ color: "var(--text-primary)" }}>
                If your current Proton-GE installation is managed by Steam, Lutris, or another tool, LokiASAM may overwrite or conflict with it.
              </span>
              <span className="block">
                Only switch to managed if this is a standalone Proton-GE install you want LokiASAM to fully control.
              </span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowManagedConfirm(false)}
              className="hover:bg-(--surface-elevated)"
              style={{ borderColor: "rgba(var(--neon-purple-rgb),0.3)", color: "var(--neon-purple)" }}>
              Keep Unmanaged
            </Button>
            <Button variant="outline"
              className="gap-2 bg-[rgba(255,136,0,0.12)]! hover:bg-[rgba(255,136,0,0.25)]!"
              style={{ borderColor: "rgba(255,136,0,0.4)", color: "var(--neon-orange)" }}
              onClick={() => {
                setShowManagedConfirm(false);
                setProtonMode("managed");
                setProtonPath("");
                setProtonValidated(false);
                setError("");
                setShowDownload(false);
              }}>
              Switch to Managed
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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

// ---------------------------------------------------------------------------
// Certificate step
// ---------------------------------------------------------------------------

type CertPhase = "checking" | "idle" | "downloading" | "installing" | "done" | "error";

function CertStep() {
  const {
    baseDir,
    protonPath,
    setCertInstalled,
    certSkipped,
    setLoading,
  } = useSetupStore();

  const [phase, setPhase] = useState<CertPhase>("checking");
  const [error, setError]  = useState("");

  // On mount, check whether the cert is already installed so we can show the
  // "already installed" state immediately rather than prompting the user.
  const checkCertInstalled = useCallback(async () => {
    try {
      const sep = baseDir.includes("\\") ? "\\" : "/";
      const prefix = IS_LINUX
        ? baseDir.replace(/[/\\]$/, "") + sep + "lokiasam" + sep + "proton" + sep + "prefix"
        : undefined;
      const proton = IS_LINUX && protonPath ? protonPath : undefined;
      const installed = await tauriCmd.checkAmazonRootCaInstalled(proton, prefix);
      if (installed) {
        setCertInstalled(true);
        setPhase("done");
      } else {
        setPhase("idle");
      }
    } catch {
      setPhase("idle");
    }
  }, [baseDir, protonPath, setCertInstalled]);
  useOnMount(checkCertInstalled);

  const handleInstall = async () => {
    setError("");
    // Block Back/Next like the SteamCMD/Proton-GE steps do — otherwise the
    // user can navigate away mid-install, the step unmounts, and its local
    // phase/error state (including a failure) is silently discarded.
    setLoading(true, "Installing certificate…");
    try {
      const tmp = await tempDir();
      setPhase("downloading");
      const certPath = await tauriCmd.downloadAmazonRootCa(tmp);

      setPhase("installing");
      const sep = baseDir.includes("\\") ? "\\" : "/";
      const prefix = IS_LINUX
        ? baseDir.replace(/[/\\]$/, "") + sep + "lokiasam" + sep + "proton" + sep + "prefix"
        : undefined;
      const proton = IS_LINUX && protonPath ? protonPath : undefined;
      await tauriCmd.installAmazonRootCa(certPath, proton, prefix);

      setCertInstalled(true);
      setPhase("done");
    } catch (e) {
      setError(String(e));
      setPhase("error");
    } finally {
      setLoading(false);
    }
  };

  const phaseLabel: Record<CertPhase, string> = {
    checking:    "Checking installation status…",
    idle:        "",
    downloading: "Downloading Amazon Root CA 1…",
    installing:  IS_LINUX
      ? "Installing certificate into Wine prefix… (may take up to 30 s on first run)"
      : "Installing certificate…",
    done:        "Certificate installed successfully.",
    error:       "",
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <ShieldCheck className="w-5 h-5 shrink-0" style={{ color: "var(--neon-purple)", filter: "drop-shadow(0 0 6px rgba(var(--neon-purple-rgb),0.8))" }} />
          <h2 className="text-xl font-bold text-glow-purple" style={{ color: "var(--neon-purple)" }}>
            Mod API Certificate
          </h2>
        </div>
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          ARK SA uses the CurseForge API (secured by Amazon TLS) to load mod
          metadata at startup. Installing the Amazon Root CA certificate ensures
          that connection is trusted, preventing intermittent
          &quot;serverUnreachable&quot; errors when starting servers with mods.
        </p>
      </div>

      {/* Status / progress */}
      <div
        className="rounded-lg p-4 flex flex-col gap-3"
        style={{
          background: "rgba(var(--neon-purple-rgb),0.04)",
          border: "1px solid rgba(var(--neon-purple-rgb),0.15)",
        }}
      >
        {phase === "checking" && (
          <div className="flex items-center gap-2 text-sm" style={{ color: "var(--text-muted)" }}>
            <Loader2 className="w-4 h-4 animate-spin" />
            Checking installation status…
          </div>
        )}

        {(phase === "downloading" || phase === "installing") && (
          <div className="flex items-center gap-2 text-sm" style={{ color: "var(--text-muted)" }}>
            <Loader2 className="w-4 h-4 animate-spin" />
            {phaseLabel[phase]}
          </div>
        )}

        {phase === "done" && (
          <div className="flex items-center gap-2 text-sm" style={{ color: "var(--neon-purple)" }}>
            <ShieldCheck className="w-4 h-4" />
            Amazon Root CA 1 is installed. You&apos;re all set.
          </div>
        )}

        {phase === "idle" && (
          <div className="flex items-center gap-2 text-sm" style={{ color: "var(--text-muted)" }}>
            <ShieldCheck className="w-4 h-4" />
            Certificate not yet installed.
          </div>
        )}

        {phase === "error" && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-sm" style={{ color: "var(--neon-red, #f87171)" }}>
              <AlertCircle className="w-4 h-4 shrink-0" />
              Installation failed.
            </div>
            <p className="text-xs ml-6 break-all" style={{ color: "var(--text-muted)" }}>{error}</p>
          </div>
        )}

        {certSkipped && phase !== "done" && (
          <div className="flex items-center gap-2 text-xs" style={{ color: "var(--text-subtle)" }}>
            <AlertCircle className="w-3.5 h-3.5" />
            Skipped — servers with mods may encounter intermittent startup errors.
            You can install the certificate later via Settings → General.
          </div>
        )}
      </div>

      {/* Action buttons */}
      {phase !== "done" && (
        <div className="flex gap-3">
          <Button
            onClick={handleInstall}
            disabled={phase === "checking" || phase === "downloading" || phase === "installing"}
            className="flex-1 gap-2"
            style={{
              background: "rgba(var(--neon-purple-rgb),0.15)",
              border: "1px solid rgba(var(--neon-purple-rgb),0.4)",
              color: "var(--neon-purple)",
            }}
          >
            {(phase === "downloading" || phase === "installing") ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <ShieldCheck className="w-4 h-4" />
            )}
            {phase === "error" ? "Retry Installation" : "Install Certificate"}
          </Button>

        </div>
      )}
    </div>
  );
}

function NotificationsStep({ onMatrixChange }: { onMatrixChange: (events: Record<string, string[]>) => void }) {
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
  const [showSmtpPw, setShowSmtpPw] = useState(false);

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
        <div className="flex items-center gap-2 mb-1">
          <Bell className="w-5 h-5 shrink-0" style={{ color: "var(--neon-purple)", filter: "drop-shadow(0 0 6px rgba(var(--neon-purple-rgb),0.8))" }} />
          <h2 className="text-xl font-bold text-glow-purple" style={{ color: "var(--neon-purple)" }}>
            What notifications would you like?
          </h2>
        </div>
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          All channels are optional — you can change these at any time in Settings.
        </p>
      </div>

      {/* Discord webhook */}
      <div
        className="rounded-lg p-4 space-y-3"
        style={{ background: "var(--surface)", border: "1px solid rgba(var(--neon-purple-rgb),0.1)" }}
      >
        <div className="flex items-center justify-between">
          <Label htmlFor="discord-webhook" style={{ color: "var(--text-primary)" }}>
            Discord Webhook
            <span className="ml-2 text-xs font-normal" style={{ color: "var(--text-muted)" }}>(optional)</span>
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
            background: "var(--surface)",
            borderColor: discordWebhook ? "rgba(var(--neon-purple-rgb),0.4)" : "rgba(var(--neon-purple-rgb),0.2)",
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
        style={{ background: "var(--surface)", border: "1px solid rgba(var(--neon-purple-rgb),0.1)" }}
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
              style={{ background: "var(--surface)", borderColor: "rgba(var(--neon-purple-rgb),0.2)", color: "var(--text-primary)" }}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs" style={{ color: "var(--text-muted)" }}>Port</Label>
            <Input value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)}
              placeholder="587" className="font-mono text-xs"
              style={{ background: "var(--surface)", borderColor: "rgba(var(--neon-purple-rgb),0.2)", color: "var(--text-primary)" }}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className="text-xs" style={{ color: "var(--text-muted)" }}>Username</Label>
            <Input value={smtpUsername} onChange={(e) => setSmtpUsername(e.target.value)}
              placeholder="user@example.com" className="font-mono text-xs"
              style={{ background: "var(--surface)", borderColor: "rgba(var(--neon-purple-rgb),0.2)", color: "var(--text-primary)" }}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs" style={{ color: "var(--text-muted)" }}>Password</Label>
            <div className="relative">
              <Input type={showSmtpPw ? "text" : "password"} value={smtpPassword} onChange={(e) => setSmtpPassword(e.target.value)}
                placeholder="••••••••" className="font-mono text-xs pr-8"
                style={{ background: "var(--surface)", borderColor: "rgba(var(--neon-purple-rgb),0.2)", color: "var(--text-primary)" }}
              />
              <button type="button" tabIndex={-1} onClick={() => setShowSmtpPw(v => !v)}
                className="absolute inset-y-0 right-0 flex items-center pr-2.5 opacity-50 hover:opacity-90 transition-opacity"
                style={{ color: "var(--text-primary)" }}>
                {showSmtpPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className="text-xs" style={{ color: "var(--text-muted)" }}>From Address</Label>
            <Input value={smtpFrom} onChange={(e) => setSmtpFrom(e.target.value)}
              placeholder="noreply@example.com" className="font-mono text-xs"
              style={{ background: "var(--surface)", borderColor: "rgba(var(--neon-purple-rgb),0.2)", color: "var(--text-primary)" }}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs" style={{ color: "var(--text-muted)" }}>To Address</Label>
            <Input value={smtpTo} onChange={(e) => setSmtpTo(e.target.value)}
              placeholder="admin@example.com" className="font-mono text-xs"
              style={{ background: "var(--surface)", borderColor: "rgba(var(--neon-purple-rgb),0.2)", color: "var(--text-primary)" }}
            />
          </div>
        </div>
        <ToggleRow label="Use TLS / STARTTLS" value={smtpUseTls} onChange={setSmtpUseTls} />
      </div>

      {/* Notification event matrix */}
      <div
        className="rounded-lg p-4 space-y-3"
        style={{ background: "var(--surface)", border: "1px solid rgba(var(--neon-purple-rgb),0.1)" }}
      >
        <div>
          <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            Notification Events
            <span className="ml-2 text-xs font-normal" style={{ color: "var(--text-muted)" }}>(optional)</span>
          </p>
          <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
            Choose which events trigger each channel. Configure credentials above to unlock Discord and SMTP columns.
          </p>
        </div>
        <NotificationMatrix onChange={onMatrixChange} />
      </div>
    </div>
  );
}

function TrayStep() {
  const { closeToTray, setCloseToTray } = useSetupStore();
  const { enabled: autostartEnabled, loading: autostartLoading, toggle: toggleAutostart } = useAutostart();

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Layers className="w-5 h-5 shrink-0" style={{ color: "var(--neon-purple)", filter: "drop-shadow(0 0 6px rgba(var(--neon-purple-rgb),0.8))" }} />
          <h2 className="text-xl font-bold text-glow-purple" style={{ color: "var(--neon-purple)" }}>
            System Tray Behavior
          </h2>
        </div>
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
              background: closeToTray === value ? "rgba(var(--neon-purple-rgb),0.1)" : "var(--surface)",
              border: `1px solid ${closeToTray === value ? "rgba(var(--neon-purple-rgb),0.5)" : "rgba(var(--neon-purple-rgb),0.15)"}`,
              boxShadow: closeToTray === value ? "0 0 16px rgba(var(--neon-purple-rgb),0.12)" : "none",
            }}
          >
            <div className="flex items-center gap-2 mb-1">
              <div
                className="w-3.5 h-3.5 rounded-full border-2 shrink-0 flex items-center justify-center"
                style={{ borderColor: closeToTray === value ? "var(--neon-purple)" : "rgba(var(--neon-purple-rgb),0.3)" }}
              >
                {closeToTray === value && (
                  <div className="w-2 h-2 rounded-full" style={{ background: "var(--neon-purple)" }} />
                )}
              </div>
              <p className="text-sm font-semibold" style={{ color: closeToTray === value ? "var(--neon-purple)" : "var(--text-primary)" }}>
                {label}
                {recommended && (
                  <span className="ml-2 text-xs font-normal px-1.5 py-0.5 rounded" style={{ background: "rgba(var(--neon-purple-rgb),0.15)", color: "var(--neon-purple)" }}>
                    Recommended
                  </span>
                )}
              </p>
            </div>
            <p className="text-xs pl-5" style={{ color: "var(--text-muted)" }}>{desc}</p>
          </button>
        ))}
      </div>

      {/* Auto-start with OS */}
      <div
        className="flex items-center justify-between gap-4 rounded-lg px-4 py-3"
        style={{ background: "rgba(var(--neon-purple-rgb),0.05)", border: "1px solid rgba(var(--neon-purple-rgb),0.15)" }}
      >
        <div>
          <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Launch at login</p>
          <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
            Start LokiASAM automatically when your OS boots. Pairs well with &ldquo;Minimize to tray&rdquo; above.
          </p>
        </div>
        <button
          type="button"
          disabled={autostartLoading}
          onClick={() => toggleAutostart(!autostartEnabled)}
          className="shrink-0"
          aria-label={autostartEnabled ? "Disable launch at login" : "Enable launch at login"}
        >
          {autostartEnabled
            ? <ToggleRight className="w-8 h-8" style={{ color: "var(--neon-purple)" }} />
            : <ToggleLeft  className="w-8 h-8" style={{ color: "var(--text-subtle)" }} />}
        </button>
      </div>

      <div className="space-y-2">
        <div
          className="rounded-lg p-3"
          style={{ background: "rgba(var(--neon-purple-rgb),0.05)", border: "1px solid rgba(var(--neon-purple-rgb),0.12)" }}
        >
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            <span className="font-semibold" style={{ color: "var(--neon-purple)" }}>Note: </span>
            You can change this at any time in Settings. The first time you minimize to tray, you&apos;ll get a desktop notification confirming the app is still running.
          </p>
        </div>
        <div
          className="rounded-lg p-3"
          style={{ background: "rgba(255,165,0,0.05)", border: "1px solid rgba(255,165,0,0.2)" }}
        >
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            <span className="font-semibold" style={{ color: "#ffa500" }}>Desktop notifications: </span>
            OS desktop notifications (the pop-up alerts from your system) may only appear when LokiASAM is minimized to the system tray. This is dependent on your desktop environment and its notification settings, not LokiASAM itself.
          </p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AutoUpdateStep — configure update check preferences before completing setup
// ---------------------------------------------------------------------------

function AutoUpdateStep() {
  const {
    asaAutoCheckHours, setAsaAutoCheckHours,
    appUpdateCheckMode, setAppUpdateCheckMode,
    protonCheckMode, setProtonCheckMode,
    protonMode, setProtonMode,
    setStep,
  } = useSetupStore();

  const [showManagedConfirm, setShowManagedConfirm] = useState(false);

  // Keep proton check mode in sync with the managed/unmanaged choice
  useEffect(() => {
    if (!IS_LINUX) return;
    if (protonMode === "existing") {
      setProtonCheckMode("disabled");
    } else if (protonMode === "managed" && protonCheckMode === "disabled") {
      setProtonCheckMode("startup");
    }
  }, [protonMode, protonCheckMode, setProtonCheckMode]);

  const asaIntervals = [
    { value: "disabled",       label: "Disabled" },
    { value: "startup",        label: "On Startup" },
    { value: "startup_hourly", label: "On Startup + Hourly" },
  ];

  const appModes = [
    { value: "off",      label: "Disabled" },
    { value: "startup",  label: "On Startup" },
    { value: "periodic", label: "On Startup + Hourly" },
  ];

  const protonModes = [
    { value: "disabled",       label: "Disabled" },
    { value: "startup",        label: "On Startup" },
    { value: "startup_hourly", label: "On Startup + Hourly" },
  ];

  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <RefreshCw className="w-5 h-5 shrink-0" style={{ color: "var(--neon-purple)", filter: "drop-shadow(0 0 6px rgba(var(--neon-purple-rgb),0.8))" }} />
          <h2 className="text-xl font-bold text-glow-purple" style={{ color: "var(--neon-purple)" }}>
            Auto-Update Settings
          </h2>
        </div>
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          Auto-updates are one of LokiASAM&apos;s core features. Set how often each component checks for new versions — adjustable at any time in Settings.
        </p>
      </div>

      {/* ASA Server Updates */}
      <div className="rounded-xl p-4 space-y-3"
        style={{ background: "var(--surface)", border: "1px solid rgba(var(--neon-purple-rgb),0.12)" }}>
        <div>
          <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>ASA Server Updates</p>
          <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
            Checks Steam for new ARK server builds and flags any servers that need updating. Updates are never applied automatically — you stay in control.
          </p>
        </div>
        <div className="flex gap-2">
          {asaIntervals.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => setAsaAutoCheckHours(value)}
              className="flex-1 py-1.5 rounded-lg text-xs font-medium transition-all"
              style={{
                background: asaAutoCheckHours === value ? "rgba(var(--neon-purple-rgb),0.15)" : "var(--surface-elevated)",
                border: `1px solid ${asaAutoCheckHours === value ? "rgba(var(--neon-purple-rgb),0.5)" : "rgba(var(--neon-purple-rgb),0.15)"}`,
                color: asaAutoCheckHours === value ? "var(--neon-purple)" : "var(--text-muted)",
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="text-[11px]" style={{ color: "var(--text-subtle)" }}>
          When an update is detected, affected servers are flagged on the Dashboard. Apply updates per-server or all at once.
        </p>
      </div>

      {/* LokiASAM App Updates */}
      <div className="rounded-xl p-4 space-y-3"
        style={{ background: "var(--surface)", border: "1px solid rgba(var(--neon-purple-rgb),0.12)" }}>
        <div>
          <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>LokiASAM App Updates</p>
          <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
            Check for new versions of LokiASAM itself. Updates are downloaded in the background — you choose when to install.
          </p>
        </div>
        <div className="flex gap-2">
          {appModes.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => setAppUpdateCheckMode(value)}
              className="flex-1 py-1.5 rounded-lg text-xs font-medium transition-all"
              style={{
                background: appUpdateCheckMode === value ? "rgba(var(--neon-purple-rgb),0.15)" : "var(--surface-elevated)",
                border: `1px solid ${appUpdateCheckMode === value ? "rgba(var(--neon-purple-rgb),0.5)" : "rgba(var(--neon-purple-rgb),0.15)"}`,
                color: appUpdateCheckMode === value ? "var(--neon-purple)" : "var(--text-muted)",
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Proton-GE (Linux only) */}
      {IS_LINUX && (
        <div className="rounded-xl p-4 space-y-3"
          style={{ background: "var(--surface)", border: "1px solid rgba(var(--neon-purple-rgb),0.12)" }}>
          <div>
            <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Proton-GE Updates</p>
            <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
              Check GitHub for new GE-Proton releases. A notification appears when a new version is available.
            </p>
          </div>
          {protonMode === "existing" ? (
            <div className="space-y-3">
              <div className="flex items-start gap-2 rounded-lg px-3 py-2.5"
                style={{ background: "rgba(255,136,0,0.07)", border: "1px solid rgba(255,136,0,0.2)" }}>
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: "var(--neon-orange)" }} />
                <p className="text-xs" style={{ color: "var(--neon-orange)" }}>
                  Proton-GE is in unmanaged mode — LokiASAM will not check for or update it.
                </p>
              </div>
              <Button
                variant="outline"
                onClick={() => setShowManagedConfirm(true)}
                className="gap-2 bg-[rgba(255,0,85,0.08)]! hover:bg-[rgba(255,0,85,0.2)]!"
                style={{ borderColor: "rgba(255,0,85,0.3)", color: "var(--neon-red)" }}
              >
                <TriangleAlert className="w-4 h-4" />
                Allow LokiASAM to Manage This Proton Install
              </Button>

              <Dialog open={showManagedConfirm} onOpenChange={(v) => { if (!v) setShowManagedConfirm(false); }}>
                <DialogContent showCloseButton={false} className="max-w-lg"
                  style={{ background: "var(--popover)", border: "1px solid rgba(255,136,0,0.35)" }}>
                  <DialogHeader>
                    <DialogTitle className="flex items-center gap-2" style={{ color: "var(--neon-orange)" }}>
                      <AlertCircle className="w-5 h-5" /> Allow LokiASAM to Manage Proton-GE?
                    </DialogTitle>
                    <DialogDescription className="space-y-2 pt-1">
                      <span className="block">
                        Switching to managed mode gives LokiASAM full control over your Proton-GE installation — it may download new versions and replace the current one.
                      </span>
                      <span className="block font-medium" style={{ color: "var(--neon-red)" }}>
                        If this Proton-GE was installed by Steam, Lutris, or another tool, LokiASAM may overwrite it and break other applications that depend on it.
                      </span>
                      <span className="block">
                        For the safest experience, go back and let LokiASAM download and install its own dedicated copy of Proton-GE instead.
                      </span>
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter className="flex-col gap-2 sm:flex-col">
                    <Button variant="outline"
                      onClick={() => { setShowManagedConfirm(false); setStep(5); }}
                      className="w-full gap-1.5 hover:bg-(--surface-elevated)"
                      style={{ borderColor: "rgba(var(--neon-purple-rgb),0.3)", color: "var(--neon-purple)" }}>
                      Go Back to Proton-GE Setup
                    </Button>
                    <Button variant="outline"
                      className="w-full gap-1.5 bg-[rgba(255,0,85,0.08)]! hover:bg-[rgba(255,0,85,0.2)]!"
                      style={{ borderColor: "rgba(255,0,85,0.3)", color: "var(--neon-red)" }}
                      onClick={() => { setProtonMode("managed"); setShowManagedConfirm(false); }}>
                      Allow Management
                    </Button>
                    <Button variant="outline" onClick={() => setShowManagedConfirm(false)}
                      className="w-full hover:bg-(--surface-elevated)"
                      style={{ borderColor: "rgba(var(--neon-purple-rgb),0.3)", color: "var(--neon-purple)" }}>
                      Cancel
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          ) : (
            <div className="flex gap-2">
              {protonModes.map(({ value, label }) => (
                <button
                  key={value}
                  onClick={() => setProtonCheckMode(value)}
                  className="flex-1 py-1.5 rounded-lg text-xs font-medium transition-all"
                  style={{
                    background: protonCheckMode === value ? "rgba(var(--neon-purple-rgb),0.15)" : "var(--surface-elevated)",
                    border: `1px solid ${protonCheckMode === value ? "rgba(var(--neon-purple-rgb),0.5)" : "rgba(var(--neon-purple-rgb),0.15)"}`,
                    color: protonCheckMode === value ? "var(--neon-purple)" : "var(--text-muted)",
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="rounded-lg p-3"
        style={{ background: "rgba(var(--neon-purple-rgb),0.05)", border: "1px solid rgba(var(--neon-purple-rgb),0.12)" }}>
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          <span className="font-semibold" style={{ color: "var(--neon-purple)" }}>Per-server automation: </span>
          Each server also has an Automation tab where you can choose whether updates apply immediately when detected or at a specific time of day.
        </p>
      </div>
    </div>
  );
}

function AppImageIntegrationPanel() {
  const [status, setStatus]   = useState<{ isAppimage: boolean; isInstalled: boolean } | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    tauriCmd.checkAppimageIntegration().then(setStatus).catch(() => {});
  }, []);

  if (!status?.isAppimage) return null;

  const handleInstall = async () => {
    setWorking(true);
    try {
      await tauriCmd.installAppimageIntegration();
      setStatus({ ...status, isInstalled: true });
      toast.success("LokiASAM added to your application menu.");
    } catch (e) {
      toast.error("Failed to install", { description: String(e) });
    } finally {
      setWorking(false);
    }
  };

  const handleUninstall = async () => {
    setWorking(true);
    try {
      await tauriCmd.uninstallAppimageIntegration();
      setStatus({ ...status, isInstalled: false });
      toast.success("Removed from application menu.");
    } catch (e) {
      toast.error("Failed to uninstall", { description: String(e) });
    } finally {
      setWorking(false);
    }
  };

  return (
    <div
      className="w-full rounded-xl p-4 text-left space-y-3"
      style={{ background: "rgba(var(--neon-purple-rgb),0.06)", border: "1px solid rgba(var(--neon-purple-rgb),0.2)" }}
    >
      <div className="flex items-start gap-3">
        <Layers className="w-4 h-4 shrink-0 mt-0.5" style={{ color: "var(--neon-purple)" }} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            Install to Application Menu
          </p>
          <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
            Adds LokiASAM to your desktop launcher so you can find and pin it without navigating
            to the AppImage file. Writes a <code>.desktop</code> file and icon to{" "}
            <code>~/.local/share/</code>. You can remove this at any time from Settings.
          </p>
        </div>
      </div>

      {status.isInstalled ? (
        <div className="flex items-center justify-between">
          <span className="text-xs flex items-center gap-1.5" style={{ color: "var(--neon-green)" }}>
            <CheckCircle2 className="w-3.5 h-3.5" /> Installed in application menu
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={handleUninstall}
            disabled={working}
            className="text-xs h-7"
            style={{ color: "var(--neon-red)", borderColor: "rgba(255,0,85,0.3)" }}
          >
            {working ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
            Remove
          </Button>
        </div>
      ) : (
        <Button
          size="sm"
          onClick={handleInstall}
          disabled={working}
          className="gap-2"
          style={{ background: "rgba(var(--neon-purple-rgb),0.15)", border: "1px solid rgba(var(--neon-purple-rgb),0.4)", color: "var(--neon-purple)" }}
        >
          {working
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
            : <Download className="w-3.5 h-3.5" />}
          Install to Application Menu
        </Button>
      )}
    </div>
  );
}

function CompleteStep({ onComplete }: { onComplete: () => void }) {
  const { baseDir, backupDir, steamcmdPath, protonPath } = useSetupStore();
  const setPendingTour = useAppStore((s) => s.setPendingTour);

  const summaryRows = [
    { label: "Servers Directory", value: baseDir },
    { label: "Backup Directory",  value: backupDir },
    { label: "SteamCMD",          value: steamcmdPath },
    ...(IS_LINUX ? [{ label: "Proton-GE", value: protonPath }] : []),
  ];

  return (
    <div className="flex flex-col items-center text-center gap-5 pt-6">
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
            style={{ background: "var(--surface)", border: "1px solid rgba(var(--neon-purple-rgb),0.15)" }}
          >
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>{label}</span>
            <span className="text-xs font-mono truncate max-w-xs" style={{ color: "var(--text-primary)" }}>{value || "—"}</span>
          </div>
        ))}
      </div>

      {/* What's next */}
      <div className="w-full rounded-xl p-4 text-left space-y-2"
        style={{ background: "rgba(var(--neon-purple-rgb),0.05)", border: "1px solid rgba(var(--neon-purple-rgb),0.15)" }}>
        <p className="text-xs font-semibold" style={{ color: "var(--neon-purple)" }}>What&apos;s next?</p>
        <ul className="space-y-1.5">
          {[
            "Click + New Server in the sidebar to add your first server",
            "Open a server's Automation tab to schedule backups and restarts",
            "Visit Settings → Updates any time to adjust auto-update intervals",
          ].map((tip, i) => (
            <li
              key={i}
              className="text-xs"
              style={{ color: "var(--text-muted)", paddingLeft: "14px", textIndent: "-14px" }}
            >
              <span className="inline-block rounded-full"
                style={{ width: "6px", height: "6px", marginRight: "8px", verticalAlign: "0.1em", background: "var(--neon-purple)" }} />
              {tip}
            </li>
          ))}
        </ul>
      </div>

      {/* AppImage-only: offer application menu integration */}
      <AppImageIntegrationPanel />

      {/* Action buttons */}
      <div className="flex gap-3 w-full">
        <Button
          onClick={() => { setPendingTour(true); onComplete(); }}
          variant="outline"
          className="flex-1 gap-2"
          style={{
            border: "1px solid rgba(var(--neon-purple-rgb),0.3)",
            color: "var(--text-muted)",
            background: "rgba(var(--neon-purple-rgb),0.04)",
          }}
        >
          <BookOpen className="w-4 h-4" />
          Quick Start Guide
        </Button>
        <Button
          onClick={onComplete}
          className="flex-1 gap-2"
          style={{
            background: "rgba(var(--neon-purple-rgb),0.2)",
            border: "1px solid rgba(var(--neon-purple-rgb),0.5)",
            color: "var(--neon-purple)",
            boxShadow: "0 0 20px rgba(var(--neon-purple-rgb),0.2)",
          }}
        >
          Go to Dashboard
          <ArrowRight className="w-4 h-4" />
        </Button>
      </div>

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
    themePreset, themeAccent,
    protonPath, protonValidated, protonMode,
    certInstalled, setCertSkipped,
    setBaseDir, setBackupDir, setSteamcmdPath, setSteamcmdValidated,
    setProtonPath, setProtonValidated,
    discordWebhook,
    smtpHost, smtpPort, smtpUsername, smtpPassword, smtpUseTls, smtpFrom, smtpTo,
    closeToTray,
    asaAutoCheckHours, appUpdateCheckMode, protonCheckMode,
    isLoading,
    importMode, importValid, importDir,
  } = useSetupStore();
  const [direction, setDirection] = useState(1);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [appVersion, setAppVersion] = useState("...");
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  // Stores the wizard's notification matrix state as the user toggles checkboxes.
  // Kept in a ref (not state) so navigating away from the notifications step
  // doesn't lose the values when the step component unmounts and clears its ref.
  const matrixEventsRef = useRef<Record<string, string[]> | null>(null);

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
    if (step === 2 && importMode) return importValid; // import tab needs a valid DB (step shifted +1)
    switch (step) {
      case 0: return true;  // Welcome
      case 1: return true;  // Theme — always ok
      case 2: return baseDirWritable;
      case 3: return backupDirWritable;
      case 4: return steamcmdValidated;
      // step 5: Proton-GE (Linux) | Cert (Windows) — cert always advances (Next becomes Skip)
      case 5: return IS_LINUX ? protonValidated : true;
      // step 6: Cert (Linux) | Notifications (Windows) — cert always advances
      case 6: return true;
      case 7: return true;  // notifications (Linux) / tray (Windows)
      case 8: return true;  // tray (Linux) / updates (Windows)
      case 9: return true;  // updates (Linux)
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
      const normalizedImportDir = importDir.replace(/[/\\]$/, "");
      const dbPath = normalizedImportDir + sep + "lokiasam" + sep + "lokiasam.db";
      const { initDb: _init, getAppSetting: getSetting } = await import("@/lib/db");
      await _init(dbPath);

      // Get the old base_dir before remapping paths
      const oldBaseDir = await getSetting("base_dir");

      // Remap all paths in the database if they differ from the import location
      if (oldBaseDir && oldBaseDir.trim() !== normalizedImportDir) {
        console.log(`Remapping paths: ${oldBaseDir} → ${normalizedImportDir}`);
        try {
          await tauriCmd.remapImportPaths(dbPath, oldBaseDir, normalizedImportDir);
          console.log("Path remapping completed successfully");
        } catch (remapErr) {
          console.error("Path remapping failed:", remapErr);
          throw new Error(`Failed to remap import paths: ${remapErr}`);
        }
      } else {
        console.log("Import directory matches stored base_dir, no remapping needed");
      }

      // Update tool paths if they were detected/installed during import
      const newSteamcmdPath = steamcmdPath;
      const newProtonPath = IS_LINUX ? protonPath : undefined;
      if (newSteamcmdPath) {
        console.log(`Updating steamcmd_path to ${newSteamcmdPath}`);
        await setAppSetting("steamcmd_path", newSteamcmdPath);
      }
      if (IS_LINUX && newProtonPath) {
        console.log(`Updating proton_path to ${newProtonPath}`);
        await setAppSetting("proton_path", newProtonPath);
        const prefix = normalizedImportDir + sep + "lokiasam" + sep + "proton" + sep + "prefix";
        await setAppSetting("proton_prefix_path", prefix);
      }

      await setAppSetting("setup_complete", "true");

      // Read updated paths from the remapped DB so the Complete step shows correct info
      const [updatedBase, updatedBackup, updatedScmd, updatedProton] = await Promise.all([
        getSetting("base_dir"),
        getSetting("backup_dir"),
        getSetting("steamcmd_path"),
        getSetting("proton_path"),
      ]);
      console.log(`Final paths - base: ${updatedBase}, backup: ${updatedBackup}`);
      if (updatedBase)   setBaseDir(updatedBase);
      if (updatedBackup) setBackupDir(updatedBackup);
      if (updatedScmd)   { setSteamcmdPath(updatedScmd);   setSteamcmdValidated(true); }
      if (updatedProton) { setProtonPath(updatedProton);   setProtonValidated(true); }

      setDirection(1);
      setStep(TOTAL_STEPS - 1);
    } catch (err) {
      setSaveError(`Import failed: ${err}`);
    } finally {
      setSaving(false);
    }
  };

  const handleNext = async () => {
    // Handle import mode on step 2 — skip to Complete after saving
    if (step === 2 && importMode && importValid) {
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
          await setAppSetting("proton_ge_managed", String(protonMode === "managed"));
          const prefix = baseDir.replace(/[/\\]$/, "") + sep + "lokiasam" + sep + "proton" + sep + "prefix";
          await setAppSetting("proton_prefix_path", prefix);
        }
        // Save Discord webhook as a notification_configs entry if provided
        if (discordWebhook) {
          await saveNotificationConfig({
            id: crypto.randomUUID(), serverId: null, channel: "discord",
            enabled: true,
            configJson: JSON.stringify({ webhookUrl: discordWebhook }),
            eventsJson: JSON.stringify(Object.values(NOTIFICATION_EVENTS)),
          });
        }

        // Save SMTP config as a notification_configs entry if host is set
        if (smtpHost) {
          await saveNotificationConfig({
            id: crypto.randomUUID(), serverId: null, channel: "email",
            enabled: true,
            configJson: JSON.stringify({
              host: smtpHost, port: smtpPort,
              username: smtpUsername, password: smtpPassword,
              fromAddress: smtpFrom, toAddress: smtpTo,
              useTls: smtpUseTls,
            }),
            eventsJson: JSON.stringify(Object.values(NOTIFICATION_EVENTS)),
          });
        }

        // Save notification matrix channel event preferences.
        // matrixEventsRef is populated by the onChange callback in NotificationsStep;
        // if the user never touched the matrix it stays null and we skip
        // (channels will fall back to their default all-events-on behaviour).
        if (matrixEventsRef.current) {
          for (const [channel, events] of Object.entries(matrixEventsRef.current)) {
            await saveGlobalChannelEvents(channel, events);
          }
        }

        // Tray preference
        await setAppSetting("close_to_tray", String(closeToTray));

        // Auto-update preferences
        await setAppSetting("asa_auto_check_hours",  asaAutoCheckHours);
        await setAppSetting("app_update_check_mode", appUpdateCheckMode);
        if (IS_LINUX) await setAppSetting("proton_ge_check_mode", protonCheckMode);

        // Theme
        await setAppSetting("theme_preset", themePreset);
        await setAppSetting("theme_accent", themeAccent);

        await setAppSetting("setup_complete", "true");
        setDirection(1);
        nextStep();
      } catch (err) {
        setSaveError(`Failed to save settings: ${err}`);
      } finally {
        setSaving(false);
      }
    } else {
      // Leaving the cert step without installing — mark as skipped
      const certStepIdx = IS_LINUX ? 6 : 5;
      if (step === certStepIdx && !certInstalled) {
        setCertSkipped(true);
      }
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
        <ThemeStep key="theme" />,
        <BaseDirStep key="basedir" />,
        <BackupDirStep key="backupdir" />,
        <SteamCmdStep key="steamcmd" />,
        <ProtonGEStep key="proton" />,
        <CertStep key="cert" />,
        <NotificationsStep key="notifications" onMatrixChange={(e) => { matrixEventsRef.current = e; }} />,
        <TrayStep key="tray" />,
        <AutoUpdateStep key="autoupdate" />,
        <CompleteStep key="complete" onComplete={handleComplete} />,
      ]
    : [
        <WelcomeStep key="welcome" />,
        <ThemeStep key="theme" />,
        <BaseDirStep key="basedir" />,
        <BackupDirStep key="backupdir" />,
        <SteamCmdStep key="steamcmd" />,
        <CertStep key="cert" />,
        <NotificationsStep key="notifications" onMatrixChange={(e) => { matrixEventsRef.current = e; }} />,
        <TrayStep key="tray" />,
        <AutoUpdateStep key="autoupdate" />,
        <CompleteStep key="complete" onComplete={handleComplete} />,
      ];

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col overflow-y-auto"
      style={{ background: "var(--background)" }}
    >
      {/* Background texture */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage: "radial-gradient(ellipse 80% 50% at 50% -20%, rgba(var(--neon-purple-rgb),0.08) 0%, transparent 60%)",
        }}
      />

      {/* Progress bar at top */}
      <div className="relative z-10 w-full h-1" style={{ background: "rgba(var(--neon-purple-rgb),0.1)" }}>
        <div
          className="h-full transition-all duration-500"
          style={{
            width: `${((step + 1) / TOTAL_STEPS) * 100}%`,
            background: "var(--neon-purple)",
            boxShadow: "0 0 8px rgba(var(--neon-purple-rgb),0.6)",
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
              background: i === step ? "rgba(var(--neon-purple-rgb),0.15)" : "transparent",
              border: `1px solid ${i <= step ? "rgba(var(--neon-purple-rgb),0.4)" : "rgba(var(--neon-purple-rgb),0.1)"}`,
              color: i === step ? "var(--neon-purple)" : i < step ? "rgba(var(--neon-purple-rgb),0.6)" : "var(--text-subtle)",
            }}
          >
            <s.icon className="w-3 h-3" />
            <span className="hidden sm:inline">{s.label}</span>
          </div>
        ))}
      </div>

      {/* Main content card */}
      <div className="relative z-10 flex-1 flex items-stretch justify-center px-6 pb-6 pt-10">
        <div
          className="w-full max-w-2xl flex flex-col min-h-0"
          style={{
            background: "var(--glass-bg)",
            border: "1px solid rgba(var(--neon-purple-rgb),0.2)",
            borderRadius: "1rem",
            backdropFilter: "blur(12px)",
            boxShadow: "0 0 60px rgba(var(--neon-purple-rgb),0.1)",
          }}
        >
          <div className="p-8 flex-1 flex flex-col min-h-0 overflow-hidden">
            <div ref={scrollAreaRef} className="flex-1 min-h-0 overflow-y-auto -ml-8 pl-8 pr-2">
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
              <div className="flex items-center justify-between mt-6 pt-4 border-t" style={{ borderColor: "rgba(var(--neon-purple-rgb),0.1)" }}>
                {/* Back button — hidden on page 0 */}
                {step === 0 ? (
                  <div />
                ) : (
                  <Button
                    variant="outline"
                    onClick={handlePrev}
                    disabled={isLoading}
                    className="gap-2 hover:bg-(--surface-elevated)"
                    style={{ color: "var(--neon-purple)", borderColor: "rgba(var(--neon-purple-rgb),0.25)" }}
                  >
                    <ArrowLeft className="w-4 h-4" /> Back
                  </Button>
                )}

                <span className="text-xs" style={{ color: "var(--text-subtle)" }}>
                  {step + 1} / {TOTAL_STEPS}
                </span>

                {/* Hide the default Next button when import mode is showing its own button */}
                {!(step === 2 && importMode && importValid) && (
                  <Button
                    variant="outline"
                    onClick={handleNext}
                    disabled={!canAdvance() || isLoading || saving}
                    className="gap-2 bg-[rgba(var(--neon-purple-rgb),0.15)]! hover:bg-[rgba(var(--neon-purple-rgb),0.28)]!"
                    style={{ borderColor: "rgba(var(--neon-purple-rgb),0.4)", color: "var(--neon-purple)" }}
                  >
                    {saving ? (
                      <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</>
                    ) : step === TOTAL_STEPS - 2 ? (
                      <>Finish <CheckCircle2 className="w-4 h-4" /></>
                    ) : (IS_LINUX ? step === 6 : step === 5) && !certInstalled ? (
                      <>Skip <ArrowRight className="w-4 h-4" /></>
                    ) : (
                      <>Next <ArrowRight className="w-4 h-4" /></>
                    )}
                  </Button>
                )}

                {/* Import mode: show an Import button in place of Next */}
                {step === 2 && importMode && importValid && (
                  <Button
                    variant="outline"
                    onClick={handleNext}
                    disabled={saving}
                    className="gap-2 bg-[rgba(0,255,136,0.12)]! hover:bg-[rgba(0,255,136,0.22)]!"
                    style={{ borderColor: "rgba(0,255,136,0.4)", color: "var(--neon-green)" }}
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
