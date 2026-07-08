"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams } from "next/navigation";
import {
  Folder, Terminal, Info, Archive, Copy,
  FolderOpen, CheckCircle2, AlertCircle, Loader2,
  Save, RefreshCw, ArrowUp, Bell, MessageSquare, Mail, Monitor, Send, Download,
  Server, Palette, Link, StopCircle, ToggleLeft, ToggleRight, Layers, Power, ShieldCheck, Settings, TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { CommandOutputPanel, hasOutputBuffer } from "@/components/shared/CommandOutputPanel";
import { NotificationMatrix } from "@/components/shared/NotificationMatrix";
import {
  getAppSetting, setAppSetting,
  saveNotificationConfig, getNotificationConfigs,
  getServers, formatServerVersion,
  type NotificationConfigRow,
} from "@/lib/db";
import { useBuildVersionCache } from "@/hooks/useBuildVersionCache";
import { useAutostart } from "@/hooks/useAutostart";
import { runAsaCacheUpdate, runPerServerUpdateCheck, applyUpdateToServer } from "@/lib/update-utils";
import { check } from "@tauri-apps/plugin-updater";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { tempDir } from "@tauri-apps/api/path";
import { tauriCmd, type DirCheckResult, type ProtonUpdateInfo, type MigrateProgress, type PortDef, type FirewallStatus } from "@/lib/tauri-commands";
import { getServerFirewallPorts } from "@/lib/firewall-utils";
import { listen } from "@tauri-apps/api/event";
import {
  applyTheme, applyThemeAccent, applyThemePreset,
  ACCENT_OPTIONS, THEME_PRESETS,
  type ThemeAccent, type ThemePreset,
} from "@/lib/theme";
import { open } from "@tauri-apps/plugin-dialog";
import { dispatchNotification } from "@/lib/notifications";
import { NOTIFICATION_EVENTS } from "@/data/game-data";
import { useAppStore } from "@/store/useAppStore";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const IS_LINUX =
  typeof navigator !== "undefined" && !navigator.userAgent.includes("Windows");

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const gb = bytes / 1_073_741_824;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / 1_048_576).toFixed(0)} MB`;
}

// ---------------------------------------------------------------------------
// Section wrapper
// ---------------------------------------------------------------------------

function Section({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="glass-card rounded-xl overflow-hidden" style={{ border: "1px solid var(--border)" }}>
      <div className="px-6 py-4 flex items-center gap-3 border-b" style={{ borderColor: "var(--border)" }}>
        <Icon className="w-4 h-4 shrink-0" style={{ color: "var(--neon-purple)" }} />
        <div>
          <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{title}</h2>
          <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>{description}</p>
        </div>
      </div>
      <div className="p-6 space-y-6">{children}</div>
    </div>
  );
}

function BackupSettingsSection() {
  const [dismissed, setDismissed] = useState<boolean | null>(null);

  useEffect(() => {
    getAppSetting("full_backup_warning_dismissed").then(
      (v) => setDismissed(v === "true")
    ).catch(() => setDismissed(false));
  }, []);

  const toggle = async () => {
    const next = !dismissed;
    setDismissed(next);
    try {
      await setAppSetting("full_backup_warning_dismissed", String(next));
    } catch (e) {
      toast.error(`Failed to save backup setting: ${e}`);
      setDismissed(!next);
    }
  };

  return (
    <Section icon={Archive} title="Backups" description="Options for the backup system.">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
            Hide full backup warning
          </p>
          <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
            When enabled, the size warning dialog is skipped when triggering a full backup.
          </p>
        </div>
        {dismissed === null ? (
          <div className="w-8 h-5 rounded-full animate-pulse" style={{ background: "rgba(255,255,255,0.08)" }} />
        ) : (
          <button onClick={toggle} className="cursor-pointer shrink-0">
            {dismissed
              ? <ToggleRight className="w-8 h-8" style={{ color: "var(--neon-purple)" }} />
              : <ToggleLeft  className="w-8 h-8" style={{ color: "var(--text-muted)" }} />
            }
          </button>
        )}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Icon-based toggle (matches the wizard's ToggleRow style)
// ---------------------------------------------------------------------------

function SettingsToggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className="shrink-0 flex items-center disabled:opacity-50"
      aria-label={checked ? "Disable" : "Enable"}
    >
      {checked ? (
        <ToggleRight className="w-8 h-8" style={{ color: "var(--neon-purple)" }} />
      ) : (
        <ToggleLeft className="w-8 h-8" style={{ color: "var(--text-subtle)" }} />
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Base directory with migration tool
// ---------------------------------------------------------------------------

function BaseDirMigrationSection() {
  const [currentDir, setCurrentDir]       = useState("");
  const [newDir, setNewDir]               = useState("");
  const [createBackup, setCreateBackup]   = useState(true);
  const [migrating, setMigrating]         = useState(false);
  const [migrationDone, setMigrationDone] = useState(false);
  const [progress, setProgress]           = useState<MigrateProgress | null>(null);
  const [showMigrate, setShowMigrate]     = useState(false);

  useEffect(() => {
    getAppSetting("base_dir").then((v) => setCurrentDir(v ?? ""));
  }, []);

  const handleBrowse = async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: "Select New Base Directory" });
      if (typeof selected === "string" && selected) setNewDir(selected);
    } catch {/* outside Tauri */}
  };

  const handleMigrate = async () => {
    if (!newDir.trim()) { toast.error("Please enter a destination directory."); return; }
    setMigrating(true); setProgress(null); setMigrationDone(false);

    const unlisten = await listen<MigrateProgress>("base-dir://migrate-progress", (e) => {
      setProgress(e.payload);
    });

    try {
      const newDbPath = await tauriCmd.moveBaseDir(currentDir, newDir.trim(), createBackup);

      // Reconnect DB at new location and fix install_path values.
      const { initDb } = await import("@/lib/db");
      await initDb(newDbPath);
      const { default: Database } = await import("@tauri-apps/plugin-sql");
      const db = await Database.load(`sqlite:${newDbPath}`);
      const sep = currentDir.includes("\\") ? "\\" : "/";
      const oldPrefix = currentDir.replace(/[/\\]$/, "") + sep;
      const newPrefix = newDir.trim().replace(/[/\\]$/, "") + sep;
      await db.execute(
        "UPDATE servers SET install_path = REPLACE(install_path, ?, ?) WHERE install_path LIKE ?",
        [oldPrefix, newPrefix, `${oldPrefix}%`]
      );
      await db.execute(
        "UPDATE app_settings SET value = REPLACE(value, ?, ?) WHERE key IN ('base_dir','backup_dir') AND value LIKE ?",
        [oldPrefix, newPrefix, `${oldPrefix}%`]
      );
      await db.execute(
        "UPDATE app_settings SET value = ? WHERE key = 'base_dir'",
        [newDir.trim()]
      );

      setCurrentDir(newDir.trim());
      setMigrationDone(true);
      toast.success("Migration complete! Reload the app to finish.", { duration: 8000 });
    } catch (e) {
      toast.error(`Migration failed: ${e}`);
    } finally {
      unlisten();
      setMigrating(false);
    }
  };

  return (
    <div className="space-y-3">
      {/* Current path display */}
      <div className="space-y-2">
        <Label style={{ color: "var(--text-primary)" }}>Base Directory</Label>
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          Root folder for all server installs. To relocate, enter a new path and click Verify & Move.
        </p>
        <Input value={currentDir} readOnly className="font-mono text-sm"
          style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--text-muted)", cursor: "default" }}
        />
      </div>

      {/* Toggle migration UI */}
      {!migrationDone && (
        <button
          onClick={() => setShowMigrate((s) => !s)}
          className="text-xs flex items-center gap-1"
          style={{ color: "var(--neon-purple)", background: "none", border: "none", cursor: "pointer" }}>
          {showMigrate ? "▾" : "▸"} Move to a different location…
        </button>
      )}

      {migrationDone && (
        <div className="rounded-lg p-3 flex items-center gap-2"
          style={{ background: "rgba(0,255,136,0.08)", border: "1px solid rgba(0,255,136,0.3)" }}>
          <CheckCircle2 className="w-4 h-4" style={{ color: "var(--neon-green)" }} />
          <p className="text-xs" style={{ color: "var(--neon-green)" }}>Migration complete. Please reload the app.</p>
          <Button onClick={() => window.location.reload()} size="sm" className="ml-auto gap-1 h-7 text-xs"
            style={{ background: "rgba(0,255,136,0.15)", border: "1px solid rgba(0,255,136,0.4)", color: "var(--neon-green)" }}>
            <RefreshCw className="w-3 h-3" /> Reload Now
          </Button>
        </div>
      )}

      {showMigrate && !migrationDone && (
        <div className="rounded-xl p-4 space-y-4" style={{ background: "var(--surface-elevated)", border: "1px solid var(--border)" }}>
          <div className="space-y-2">
            <Label className="text-xs" style={{ color: "var(--text-muted)" }}>New Location</Label>
            <div className="flex gap-2">
              <Input value={newDir} onChange={(e) => setNewDir(e.target.value)}
                placeholder="/path/to/new/location" className="flex-1 font-mono text-sm"
                style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--text-primary)" }}
              />
              <Button onClick={handleBrowse} variant="outline" size="icon" className="shrink-0"
                style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}>
                <FolderOpen className="w-4 h-4" />
              </Button>
            </div>
          </div>

          <div className="flex items-center justify-between py-1">
            <div>
              <p className="text-sm" style={{ color: "var(--foreground)" }}>Create backup before moving</p>
              <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>Backs up the lokiasam config/DB folder inside the current base dir.</p>
            </div>
            <button
              type="button"
              onClick={() => setCreateBackup((v) => !v)}
              className="shrink-0 flex items-center"
              aria-label={createBackup ? "Disable backup" : "Enable backup"}
            >
              {createBackup
                ? <ToggleRight className="w-8 h-8" style={{ color: "var(--neon-purple)" }} />
                : <ToggleLeft className="w-8 h-8" style={{ color: "var(--text-subtle)" }} />}
            </button>
          </div>

          <div className="rounded-lg p-3" style={{ background: "rgba(255,136,0,0.06)", border: "1px solid rgba(255,136,0,0.2)" }}>
            <p className="text-xs" style={{ color: "var(--neon-orange)" }}>
              All running servers must be stopped before migrating. The app will need to reload when complete.
            </p>
          </div>

          {/* Progress */}
          {migrating && progress && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs" style={{ color: "var(--text-muted)" }}>
                <span>{progress.message}</span>
                <span>{progress.percent}%</span>
              </div>
              <div className="rounded-full overflow-hidden h-1.5" style={{ background: "var(--surface)" }}>
                <div className="h-full transition-all duration-300 rounded-full"
                  style={{ width: `${progress.percent}%`, background: "var(--neon-purple)" }} />
              </div>
            </div>
          )}

          <Button onClick={handleMigrate} disabled={migrating || !newDir.trim()} size="sm" className="gap-1.5 w-full"
            style={{ background: "rgba(var(--neon-purple-rgb),0.15)", border: "1px solid rgba(var(--neon-purple-rgb),0.4)", color: "var(--neon-purple)" }}>
            {migrating ? <Loader2 className="w-3 h-3 animate-spin" /> : <FolderOpen className="w-3 h-3" />}
            {migrating ? "Migrating…" : "Verify & Move"}
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Path field with Browse + dir check + Save
// ---------------------------------------------------------------------------

interface PathFieldProps {
  label: string;
  settingKey: string;
  placeholder: string;
  hint?: string;
  pickDirectory?: boolean;
  validateDir?: boolean;
}

function PathField({
  label, settingKey, placeholder, hint,
  pickDirectory = true, validateDir = false,
}: PathFieldProps) {
  const [value, setValue] = useState("");
  const [original, setOriginal] = useState("");
  const [dirResult, setDirResult] = useState<DirCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getAppSetting(settingKey).then((v) => { const val = v ?? ""; setValue(val); setOriginal(val); });
  }, [settingKey]);

  const checkDir = useCallback(async (path: string) => {
    if (!path.trim() || !validateDir) return;
    setChecking(true); setDirResult(null);
    try { setDirResult(await tauriCmd.checkDir(path)); }
    catch { setDirResult({ writable: false, freeBytes: 0, error: "Could not check directory.", isNew: false, hasLokiasam: false, isEmpty: false }); }
    finally { setChecking(false); }
  }, [validateDir]);

  const handleBrowse = async () => {
    try {
      const selected = await open({ directory: pickDirectory, multiple: false, title: `Select ${label}` });
      if (typeof selected === "string" && selected) { setValue(selected); if (validateDir) checkDir(selected); }
    } catch {/* outside Tauri */}
  };

  const handleSave = async () => {
    setSaving(true);
    try { await setAppSetting(settingKey, value.trim()); setOriginal(value.trim()); toast.success(`${label} saved.`); }
    catch { toast.error(`Failed to save ${label}.`); }
    finally { setSaving(false); }
  };

  const dirty = value !== original;

  return (
    <div className="space-y-2">
      <Label style={{ color: "var(--text-primary)" }}>{label}</Label>
      {hint && <p className="text-xs" style={{ color: "var(--text-muted)" }}>{hint}</p>}
      <div className="flex gap-2">
        <Input value={value} onChange={(e) => { setValue(e.target.value); setDirResult(null); }}
          onBlur={() => validateDir && checkDir(value)}
          placeholder={placeholder} className="flex-1 font-mono text-sm"
          style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--text-primary)" }}
        />
        <Button onClick={handleBrowse} variant="outline" size="icon" className="shrink-0"
          style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}>
          <FolderOpen className="w-4 h-4" />
        </Button>
        <Button onClick={handleSave} disabled={saving || !dirty} size="sm" className="shrink-0 gap-1"
          style={{
            background: dirty ? "rgba(var(--neon-purple-rgb),0.15)" : "transparent",
            border: `1px solid ${dirty ? "var(--neon-purple)" : "var(--border)"}`,
            color: dirty ? "var(--neon-purple)" : "var(--text-muted)",
          }}
        >
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
          Save
        </Button>
      </div>
      {checking && <p className="text-xs flex items-center gap-1.5" style={{ color: "var(--text-muted)" }}><Loader2 className="w-3 h-3 animate-spin" /> Checking…</p>}
      {dirResult && (
        dirResult.writable
          ? <p className="text-xs flex items-center gap-1.5" style={{ color: "var(--neon-green)" }}><CheckCircle2 className="w-3 h-3" /> Writable{dirResult.freeBytes > 0 ? ` · ${formatBytes(dirResult.freeBytes)} free` : ""}</p>
          : <p className="text-xs flex items-center gap-1.5" style={{ color: "var(--neon-red)" }}><AlertCircle className="w-3 h-3" /> {dirResult.error ?? "Not writable"}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool path field — Verify & Save (validates before saving)
// ---------------------------------------------------------------------------

interface ToolPathFieldProps {
  label: string;
  settingKey: string;
  placeholder: string;
  hint?: string;
  pickDirectory?: boolean;
  validateFn: (path: string) => Promise<boolean>;
  validLabel?: string;
  invalidLabel?: string;
  /** When provided and validation fails, show a dialog offering to install
   *  rather than a toast. The callback receives the typed path as targetDir
   *  and should return the final installed path to save. */
  onInstallOffer?: (targetDir: string) => Promise<string>;
  installOfferTitle?: string;
  installOfferBody?: string;
}

function ToolPathField({
  label, settingKey, placeholder, hint,
  pickDirectory = false, validateFn,
  validLabel = "Valid", invalidLabel = "Validation failed — check the path.",
  onInstallOffer, installOfferTitle = "Not Found", installOfferBody,
}: ToolPathFieldProps) {
  const [value, setValue] = useState("");
  const [original, setOriginal] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [valid, setValid] = useState<boolean | null>(null);
  const [showInstallDialog, setShowInstallDialog] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  useEffect(() => {
    getAppSetting(settingKey).then((v) => { const val = v ?? ""; setValue(val); setOriginal(val); });
  }, [settingKey]);

  const handleBrowse = async () => {
    try {
      const selected = await open({ directory: pickDirectory, multiple: false, title: `Select ${label}` });
      if (typeof selected === "string" && selected) { setValue(selected); setValid(null); }
    } catch {/* outside Tauri */}
  };

  const handleVerifyAndSave = async () => {
    if (!value.trim()) { toast.error(`Enter a path for ${label}.`); return; }
    setVerifying(true); setValid(null);
    try {
      const ok = await validateFn(value.trim());
      setValid(ok);
      if (ok) {
        await setAppSetting(settingKey, value.trim());
        setOriginal(value.trim());
        toast.success(`${label} saved.`);
      } else if (onInstallOffer) {
        setInstallError(null);
        setShowInstallDialog(true);
      } else {
        toast.error(invalidLabel);
      }
    } catch (e) {
      if (onInstallOffer) {
        setInstallError(null);
        setShowInstallDialog(true);
      } else {
        setValid(false);
        toast.error(`Verification failed: ${e}`);
      }
    } finally {
      setVerifying(false);
    }
  };

  const handleInstall = async () => {
    if (!onInstallOffer) return;
    setInstalling(true);
    setInstallError(null);
    try {
      const newPath = await onInstallOffer(value.trim());
      await setAppSetting(settingKey, newPath);
      setValue(newPath);
      setOriginal(newPath);
      setValid(true);
      setShowInstallDialog(false);
      toast.success(`${label} installed successfully.`);
    } catch (e) {
      setInstallError(String(e));
    } finally {
      setInstalling(false);
    }
  };

  const dirty = value !== original;

  return (
    <div className="space-y-2">
      <Label style={{ color: "var(--text-primary)" }}>{label}</Label>
      {hint && <p className="text-xs" style={{ color: "var(--text-muted)" }}>{hint}</p>}
      <div className="flex gap-2">
        <Input value={value} onChange={(e) => { setValue(e.target.value); setValid(null); }}
          placeholder={placeholder} className="flex-1 font-mono text-sm"
          style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--text-primary)" }}
        />
        <Button onClick={handleBrowse} variant="outline" size="icon" className="shrink-0"
          style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}>
          <FolderOpen className="w-4 h-4" />
        </Button>
        <Button onClick={handleVerifyAndSave} disabled={verifying || !dirty} size="sm" className="shrink-0 gap-1"
          style={{
            background: dirty ? "rgba(var(--neon-purple-rgb),0.15)" : "transparent",
            border: `1px solid ${dirty ? "var(--neon-purple)" : "var(--border)"}`,
            color: dirty ? "var(--neon-purple)" : "var(--text-muted)",
          }}
        >
          {verifying ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
          Verify &amp; Save
        </Button>
      </div>
      {valid === true  && <p className="text-xs flex items-center gap-1.5" style={{ color: "var(--neon-green)" }}><CheckCircle2 className="w-3 h-3" /> {validLabel}</p>}
      {valid === false && !verifying && !onInstallOffer && <p className="text-xs flex items-center gap-1.5" style={{ color: "var(--neon-red)" }}><AlertCircle className="w-3 h-3" /> {invalidLabel}</p>}

      {onInstallOffer && (
        <Dialog open={showInstallDialog} onOpenChange={(v) => { if (!installing) setShowInstallDialog(v); }}>
          <DialogContent showCloseButton={false} className="max-w-md" style={{ background: "var(--popover)", border: "1px solid rgba(var(--neon-purple-rgb),0.35)" }}>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2" style={{ color: "var(--neon-orange)" }}>
                <AlertCircle className="w-5 h-5" /> {installOfferTitle}
              </DialogTitle>
              <DialogDescription className="space-y-2 pt-1">
                {installOfferBody && <span className="block">{installOfferBody}</span>}
                <span className="block font-mono text-xs break-all" style={{ color: "var(--text-muted)" }}>{value}</span>
              </DialogDescription>
            </DialogHeader>
            {installError && (
              <p className="text-xs px-1" style={{ color: "var(--neon-red)" }}>{installError}</p>
            )}
            <DialogFooter className="flex-col gap-2 sm:flex-col">
              <Button
                variant="outline"
                onClick={handleInstall}
                disabled={installing}
                className="w-full gap-2 hover:bg-(--surface-elevated)"
                style={{ borderColor: "rgba(var(--neon-purple-rgb),0.3)", color: "var(--neon-purple)" }}
              >
                {installing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                {installing ? "Installing…" : "Install Here"}
              </Button>
              <Button
                variant="outline"
                onClick={() => setShowInstallDialog(false)}
                disabled={installing}
                className="w-full hover:bg-(--surface-elevated)"
                style={{ borderColor: "rgba(var(--neon-purple-rgb),0.3)", color: "var(--text-muted)" }}
              >
                Cancel
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Themes section (replaces Appearance)
// ---------------------------------------------------------------------------

const PRESET_ORDER: ThemePreset[] = ["neon", "abyss", "toxic", "storm"];

function ThemesSection() {
  const [preset, setPresetState] = useState<ThemePreset>("neon");
  const [accent, setAccentState] = useState<ThemeAccent>("purple");

  useEffect(() => {
    Promise.all([getAppSetting("theme_preset"), getAppSetting("theme_accent")]).then(([p, a]) => {
      const pr = (p as ThemePreset) ?? "neon";
      const ac = (a as ThemeAccent) ?? "purple";
      setPresetState(pr);
      setAccentState(ac);
      // Re-apply on mount so navigating away and back restores the saved theme
      applyTheme(pr, ac);
    });
  }, []);

  const handlePreset = async (p: ThemePreset) => {
    const defaultAccent = THEME_PRESETS[p].defaultAccent;
    setPresetState(p);
    setAccentState(defaultAccent);
    applyTheme(p, defaultAccent);
    try {
      await setAppSetting("theme_preset", p);
      await setAppSetting("theme_accent", defaultAccent);
    } catch (err) {
      toast.error("Failed to save theme", { description: String(err) });
    }
  };

  const handleAccent = async (a: ThemeAccent) => {
    setAccentState(a);
    applyThemeAccent(a);
    try { await setAppSetting("theme_accent", a); } catch (err) { toast.error("Failed to save theme accent", { description: String(err) }); }
  };

  return (
    <div className="space-y-6">
      {/* Presets */}
      <div className="space-y-3">
        <Label style={{ color: "var(--text-primary)" }}>Theme Preset</Label>
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          Each preset changes the background palette. Selecting a preset resets the accent to its default — you can then override it below.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {PRESET_ORDER.map((p) => {
            const info = THEME_PRESETS[p];
            const isActive = preset === p;
            return (
              <button key={p} onClick={() => handlePreset(p)}
                className="rounded-lg p-3 text-left transition-all"
                style={{
                  background: isActive ? "rgba(var(--neon-purple-rgb),0.12)" : info.surface,
                  border: `1px solid ${isActive ? "var(--neon-purple)" : "var(--border)"}`,
                  boxShadow: isActive ? "0 0 12px rgba(var(--neon-purple-rgb),0.15)" : "none",
                }}
              >
                <div className="w-full h-8 rounded mb-2" style={{ background: info.background, border: "1px solid rgba(255,255,255,0.06)" }} />
                <p className="text-xs font-semibold" style={{ color: isActive ? "var(--neon-purple)" : "var(--text-primary)" }}>{info.label}</p>
              </button>
            );
          })}
        </div>
      </div>

      {/* Accent colors */}
      <div className="space-y-3">
        <Label style={{ color: "var(--text-primary)" }}>Accent Color</Label>
        <div className="flex flex-wrap gap-2">
          {ACCENT_OPTIONS.map(({ value: a, label }) => {
            // We need the hex for the swatch — import the private tokens indirectly
            // via applyThemeAccent's source, but here we just use the accent value
            // to look up from a local map.
            const hexMap: Record<ThemeAccent, string> = {
              purple: "#bf00ff", cyan: "#00ffff", green: "#00ff88",
              pink: "#ff0080", orange: "#ff8800", red: "#ff0055",
              blue: "#4080ff", teal: "#00ffc8", yellow: "#ffdc00",
            };
            const hex = hexMap[a];
            const isActive = accent === a;
            return (
              <button key={a} onClick={() => handleAccent(a)}
                className="flex flex-col items-center gap-1.5 rounded-lg px-3 py-2 transition-all"
                style={{
                  background: isActive ? `${hex}15` : "var(--surface)",
                  border: `1px solid ${isActive ? hex : "var(--border)"}`,
                  boxShadow: isActive ? `0 0 10px ${hex}33` : "none",
                }}
              >
                <span className="w-5 h-5 rounded-full" style={{ background: hex, boxShadow: isActive ? `0 0 8px ${hex}` : "none" }} />
                <span className="text-[10px] font-medium" style={{ color: isActive ? hex : "var(--text-muted)" }}>{label}</span>
              </button>
            );
          })}
        </div>
      </div>

    </div>
  );
}

// ---------------------------------------------------------------------------
// About section
// ---------------------------------------------------------------------------

function AboutRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-3 text-xs">
      <span className="shrink-0 w-36" style={{ color: "var(--text-muted)" }}>{label}:</span>
      <span className="font-mono break-all" style={{ color: "var(--text-primary)" }}>{value}</span>
    </div>
  );
}

function AboutSectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mt-1">
      <span className="text-xs font-semibold tracking-wide uppercase" style={{ color: "var(--neon-purple)" }}>
        {children}
      </span>
      <div className="flex-1 h-px" style={{ background: "var(--border)" }} />
    </div>
  );
}

function AboutSection() {
  const [appVersion, setAppVersion]   = useState("…");
  const [asaBuild, setAsaBuild]       = useState("—");
  const [protonVersion, setProtonVer] = useState("—");
  const [protonPath, setProtonPath]   = useState("—");
  const [configured, setConfigured] = useState({
    baseDir: "—", backupDir: "—", steamcmd: "—",
  });
  const [managed, setManaged] = useState({
    dbPath: "—", cachePath: "—", savesRoot: "—", clustersRoot: "—", logRoot: "—",
  });
  const [copied, setCopied] = useState(false);
  const versionCache = useBuildVersionCache();

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion("0.10.0"));
    (async () => {
      const [baseDir, backupDir, steamcmd, asaCached, protonRaw, logRoot] = await Promise.all([
        getAppSetting("base_dir"),
        getAppSetting("backup_dir"),
        getAppSetting("steamcmd_path"),
        getAppSetting("asa_cached_build_id"),
        IS_LINUX ? getAppSetting("proton_path") : Promise.resolve(null),
        tauriCmd.getLogStorageRoot().catch(() => ""),
      ]);

      setAsaBuild(asaCached || "—");

      if (protonRaw) {
        const ver = protonRaw.replace(/[/\\]$/, "").split(/[/\\]/).pop() ?? "";
        setProtonVer(ver || "—");
        setProtonPath(protonRaw);
      }

      const sep  = (baseDir ?? "").includes("\\") ? "\\" : "/";
      const base = (baseDir ?? "").replace(/[/\\]$/, "");
      setConfigured({
        baseDir:   baseDir   || "—",
        backupDir: backupDir || "—",
        steamcmd:  steamcmd  || "—",
      });
      setManaged({
        dbPath:       base ? `${base}${sep}lokiasam${sep}lokiasam.db`           : "—",
        cachePath:    base ? `${base}${sep}lokiasam${sep}cache${sep}asa-server` : "—",
        savesRoot:    base ? `${base}${sep}saves`                               : "—",
        clustersRoot: base ? `${base}${sep}clusters`                            : "—",
        logRoot:      logRoot || "—",
      });
    })();
  }, []);

  const bootstrapHint = IS_LINUX
    ? "~/.config/xyz.lokisoft.lokiasam/bootstrap.json"
    : "%APPDATA%\\xyz.lokisoft.lokiasam\\bootstrap.json";

  // Resolve the human-readable ASA version from the cache build ID
  const asaVersionDisplay = asaBuild !== "—"
    ? formatServerVersion(asaBuild, versionCache)
    : "—";

  const versionRows = [
    { label: "LokiASAM",         value: `v${appVersion}` },
    { label: "ASA Server Cache", value: asaVersionDisplay },
    ...(IS_LINUX ? [{ label: "Proton-GE", value: protonVersion }] : []),
  ];

  const configuredRows = [
    { label: "Base Directory",   value: configured.baseDir },
    { label: "Backup Directory", value: configured.backupDir },
    { label: "SteamCMD",         value: configured.steamcmd },
    ...(IS_LINUX ? [{ label: "Proton-GE", value: protonPath }] : []),
  ];

  const managedRows = [
    { label: "Database",     value: managed.dbPath },
    { label: "Server Cache", value: managed.cachePath },
    { label: "Saves",        value: managed.savesRoot },
    { label: "Clusters",     value: managed.clustersRoot },
    { label: "Log Storage",  value: managed.logRoot },
    { label: "Bootstrap",    value: bootstrapHint },
  ];

  const handleCopy = () => {
    const text = [
      "Versions:",
      ...versionRows.map((r) => `  ${r.label}: ${r.value}`),
      "",
      "Configured Directories:",
      ...configuredRows.map((r) => `  ${r.label}: ${r.value}`),
      "",
      "Managed Directories:",
      ...managedRows.map((r) => `  ${r.label}: ${r.value}`),
    ].join("\n");
    navigator.clipboard.writeText(text).catch(() => null);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="glass-card rounded-xl overflow-hidden" style={{ border: "1px solid var(--border)" }}>
      {/* Header */}
      <div className="px-6 py-4 flex items-center gap-3 border-b" style={{ borderColor: "var(--border)" }}>
        <Info className="w-4 h-4 shrink-0" style={{ color: "var(--neon-purple)" }} />
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>About</h2>
          <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>Application version and data paths.</p>
        </div>
        <button
          onClick={handleCopy}
          title="Copy to clipboard"
          className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-all cursor-pointer"
          style={{
            color:      copied ? "var(--neon-green)" : "var(--text-muted)",
            background: copied ? "rgba(0,255,136,0.08)" : "transparent",
            border:     `1px solid ${copied ? "rgba(0,255,136,0.3)" : "rgba(255,255,255,0.08)"}`,
          }}
        >
          {copied ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      {/* Content */}
      <div className="p-6 space-y-3">
        <AboutSectionLabel>Versions</AboutSectionLabel>
        <div className="space-y-2.5">
          {versionRows.map((r) => <AboutRow key={r.label} label={r.label} value={r.value} />)}
        </div>

        <AboutSectionLabel>Configured Directories</AboutSectionLabel>
        <div className="space-y-2.5">
          {configuredRows.map((r) => <AboutRow key={r.label} label={r.label} value={r.value} />)}
        </div>

        <AboutSectionLabel>Managed Directories</AboutSectionLabel>
        <div className="space-y-2.5">
          {managedRows.map((r) => <AboutRow key={r.label} label={r.label} value={r.value} />)}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ASA Server Updates section
// ---------------------------------------------------------------------------

const AUTO_CHECK_OPTIONS = [
  { value: "disabled",       label: "Disabled" },
  { value: "startup",        label: "On startup" },
  { value: "startup_hourly", label: "On startup + hourly" },
];

function ServerUpdatesSection({ onPreDownload }: { onPreDownload?: () => void }) {
  const asaCacheOpLabel = useAppStore((s) => s.asaCacheOpLabel);
  const [checking, setChecking]       = useState(false);
  const [cachedBuild, setCached]      = useState("");
  const [lastChecked, setLastChecked] = useState("");
  const [autoCheckHours, setAutoCheck] = useState("disabled");
  const [hasCacheInstalled, setHasCacheInstalled] = useState<boolean | null>(null);
  const [showApplyAll, setShowApplyAll] = useState(false);
  const [applyAllInfo, setApplyAllInfo] = useState<{ total: number; running: number }>({ total: 0, running: 0 });
  const [applyingAll, setApplyingAll] = useState(false);

  const load = useCallback(async () => {
    const [cached, checked, hours, baseDir] = await Promise.all([
      getAppSetting("asa_cached_build_id"),
      getAppSetting("asa_last_checked"),
      getAppSetting("asa_auto_check_hours"),
      getAppSetting("base_dir"),
    ]);
    setCached(cached ?? ""); setLastChecked(checked ?? ""); setAutoCheck(hours ?? "disabled");
    if (baseDir) {
      const sep = baseDir.includes("\\") ? "\\" : "/";
      const cacheDir = `${baseDir.replace(/[/\\]$/, "")}${sep}lokiasam${sep}cache${sep}asa-server`;
      const has = await tauriCmd.checkDir(cacheDir).then((r) => r.writable).catch(() => false);
      setHasCacheInstalled(has);
    } else {
      setHasCacheInstalled(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCheck = async () => {
    setChecking(true);
    try {
      const oldBuild = await getAppSetting("asa_cached_build_id") ?? "";
      const newBuild = await runAsaCacheUpdate();
      if (!newBuild) { toast.error("Base directory or SteamCMD not configured."); return; }

      const cacheUpdated = newBuild !== oldBuild;

      // Run per-server check now that the cache build ID is current.
      await runPerServerUpdateCheck();

      const servers = await getServers();
      const outdated = servers.filter((s) => s.update_available === 1);
      await setAppSetting("asa_update_available", String(outdated.length > 0));
      load();

      if (cacheUpdated) {
        await dispatchNotification({
          eventType:  NOTIFICATION_EVENTS.UPDATE_AVAILABLE,
          serverId:   null,
          serverName: "ASA Cache",
          title:      "Cache Updated",
          body:       `Cache updated to build ${newBuild}${oldBuild ? ` (was ${oldBuild})` : ""}. Outdated servers have been flagged.`,
          severity:   "info",
        });
      } else {
        // "Already up to date" is purely informational — toast only, no bell.
        toast.success(`Cache is up to date (build ${newBuild}).`);
      }

      if (outdated.length > 0) {
        const running = outdated.filter((s) => s.status === "running").length;
        setApplyAllInfo({ total: outdated.length, running });
        setShowApplyAll(true);
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

  const handleApplyAll = async () => {
    setShowApplyAll(false);
    setApplyingAll(true);
    try {
      const servers = await getServers();
      const outdated = servers.filter((s) => s.update_available === 1);
      for (const server of outdated) {
        try {
          await applyUpdateToServer(
            server.id,
            server.name,
            server.install_path,
            server.status === "running",
            false,
          );
        } catch (err) {
          // restartNeeded signal — server updated successfully, restart handled inside.
          if (!(err && typeof err === "object" && "restartNeeded" in err)) {
            await dispatchNotification({
              eventType:  NOTIFICATION_EVENTS.UPDATE_FAILED,
              serverId:   server.id,
              serverName: server.name,
              title:      `${server.name} Update Failed`,
              body:       `Failed to update ${server.name}: ${err}`,
              severity:   "error",
            });
          }
        }
      }
      await dispatchNotification({
        eventType:  NOTIFICATION_EVENTS.SERVER_UPDATED,
        serverId:   null,
        serverName: "All Servers",
        title:      `${outdated.length} Server${outdated.length !== 1 ? "s" : ""} Updated`,
        body:       `${outdated.length} server${outdated.length !== 1 ? "s have" : " has"} been updated from the cache.`,
        severity:   "success",
      });
    } catch (e) {
      await dispatchNotification({
        eventType:  NOTIFICATION_EVENTS.UPDATE_FAILED,
        serverId:   null,
        serverName: "ASA Cache",
        title:      "Apply All Failed",
        body:       `Failed to apply updates: ${e}`,
        severity:   "error",
      });
    } finally {
      setApplyingAll(false);
    }
  };

  const handleAutoCheckChange = async (value: string) => {
    setAutoCheck(value);
    await setAppSetting("asa_auto_check_hours", value);
  };

  return (
    <div className="space-y-5">
      <p className="text-xs" style={{ color: "var(--text-muted)" }}>
        Runs SteamCMD to update the shared server cache. If a new version is available it will be downloaded automatically. Servers are then compared against the updated cache and marked for update if behind.
      </p>
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>Cache Build</span>
          <span className="font-mono text-sm" style={{ color: "var(--text-primary)" }}>{cachedBuild || "—"}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>Last Checked</span>
          <span className="text-sm" style={{ color: "var(--text-primary)" }}>{lastChecked ? new Date(lastChecked).toLocaleString() : "Never"}</span>
        </div>
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <Button
          onClick={!cachedBuild ? onPreDownload : handleCheck}
          disabled={checking || !!asaCacheOpLabel}
          size="sm" className="gap-1.5"
          style={{ background: "rgba(var(--neon-purple-rgb),0.15)", border: "1px solid rgba(var(--neon-purple-rgb),0.4)", color: "var(--neon-purple)" }}
        >
          {checking || asaCacheOpLabel
            ? <Loader2 className="w-3 h-3 animate-spin" />
            : !cachedBuild
              ? <Download className="w-3 h-3" />
              : <RefreshCw className="w-3 h-3" />}
          {asaCacheOpLabel
            ? asaCacheOpLabel.replace("…", "")
            : !cachedBuild
              ? "Pre-Download Server Cache"
              : "Check for ASA Server Update"}
        </Button>
        {!cachedBuild && !asaCacheOpLabel && (
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>
            No server files cached yet — this will download them via SteamCMD.
          </span>
        )}
      </div>
      <Separator style={{ background: "var(--border)" }} />
      <div className="space-y-2">
        <Label style={{ color: "var(--text-primary)" }}>Auto-Check Interval</Label>
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>Automatically runs the cache update on an interval — immune to tray throttling. If a new version is downloaded, outdated servers are marked automatically.</p>
        <div className="flex gap-2 flex-wrap">
          {AUTO_CHECK_OPTIONS.map((opt) => (
            <button key={opt.value} onClick={() => handleAutoCheckChange(opt.value)} className="text-xs px-3 py-1.5 rounded-lg transition-all"
              style={{
                background: autoCheckHours === opt.value ? "rgba(var(--neon-purple-rgb),0.15)" : "transparent",
                border: `1px solid ${autoCheckHours === opt.value ? "var(--neon-purple)" : "var(--border)"}`,
                color: autoCheckHours === opt.value ? "var(--neon-purple)" : "var(--text-muted)",
              }}>
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Apply to all servers dialog ── */}
      <Dialog open={showApplyAll} onOpenChange={setShowApplyAll}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Apply Update to All Servers?</DialogTitle>
            <DialogDescription>
              {applyAllInfo.total} server{applyAllInfo.total !== 1 ? "s are" : " is"} behind the cache.
              {applyAllInfo.running > 0 && (
                <> {applyAllInfo.running} currently running server{applyAllInfo.running !== 1 ? "s" : ""} will be stopped and restarted after the update.</>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowApplyAll(false)}
              style={{ borderColor: "rgba(var(--neon-purple-rgb),0.3)", color: "var(--text-muted)" }}>
              No, skip
            </Button>
            <Button onClick={handleApplyAll} disabled={applyingAll}
              style={{ background: "rgba(255,165,0,0.15)", borderColor: "rgba(255,165,0,0.5)", color: "#ffa500" }}>
              {applyingAll
                ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                : <ArrowUp className="w-3.5 h-3.5 mr-1.5" />}
              Yes, update all
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LokiASAM App Updates section
// ---------------------------------------------------------------------------

const APP_UPDATE_MODE_OPTIONS = [
  { value: "off",      label: "Disabled" },
  { value: "startup",  label: "On startup" },
  { value: "periodic", label: "On startup + hourly" },
];

function AppUpdateSection() {
  const [mode, setMode]           = useState("startup");
  const [checking, setChecking]   = useState(false);
  const [currentVersion, setCurrentVersion] = useState("");
  const [installMethod, setInstallMethod]   = useState("binary");
  const [updateResult, setUpdateResult] = useState<{ version: string; body?: string | null; available: boolean } | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installDone, setInstallDone] = useState(false);

  useEffect(() => {
    getAppSetting("app_update_check_mode").then((v) => setMode(v ?? "startup"));
    getVersion().then(setCurrentVersion).catch(() => {});
    invoke<string>("get_install_method").then(setInstallMethod).catch(() => {});
  }, []);

  const handleModeChange = async (value: string) => {
    setMode(value);
    await setAppSetting("app_update_check_mode", value);
  };

  const handleCheckNow = async () => {
    setChecking(true);
    setUpdateResult(null);
    try {
      const update = await check();
      if (!update) {
        setUpdateResult({ version: currentVersion, available: false });
        toast.success("LokiASAM is up to date.");
      } else {
        setUpdateResult({ version: update.version, body: update.body, available: true });
        toast.info(`LokiASAM ${update.version} is available.`);
      }
    } catch (e) { toast.error(`Update check failed: ${e}`); }
    finally { setChecking(false); }
  };

  const handleInstall = async () => {
    setChecking(true);
    try {
      const update = await check();
      if (!update) { toast.info("No update available."); return; }
      setInstalling(true);
      const loadingId = toast.loading("Downloading update…");
      try {
        await update.downloadAndInstall();
        toast.dismiss(loadingId);
        toast.success("Update installed. Restart LokiASAM to apply it.", { duration: Infinity });
        setInstallDone(true);
      } catch (e) { toast.dismiss(loadingId); toast.error(`Update failed: ${e}`); }
      finally { setInstalling(false); }
    } catch (e) { toast.error(`Update check failed: ${e}`); }
    finally { setChecking(false); }
  };

  return (
    <div className="space-y-5">
      <p className="text-xs" style={{ color: "var(--text-muted)" }}>
        Automatic update checks for LokiASAM itself. When an update is found, a notification appears with a Download &amp; Install button.
      </p>

      <div className="flex flex-wrap gap-2">
        <Button onClick={handleCheckNow} disabled={checking || installing} size="sm" className="gap-1.5"
          style={{ background: "rgba(var(--neon-purple-rgb),0.15)", border: "1px solid rgba(var(--neon-purple-rgb),0.4)", color: "var(--neon-purple)" }}>
          {checking ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
          Check for LokiASAM Update
        </Button>

        {updateResult?.available && installMethod !== "pkgbuild" && (
          <Button onClick={handleInstall} disabled={checking || installing || installDone} size="sm" className="gap-1.5"
            style={{
              background: installDone ? "rgba(0,255,136,0.15)" : "rgba(var(--neon-purple-rgb),0.15)",
              border: `1px solid ${installDone ? "rgba(0,255,136,0.4)" : "rgba(var(--neon-purple-rgb),0.4)"}`,
              color: installDone ? "var(--neon-green)" : "var(--neon-purple)",
            }}>
            {installing ? <Loader2 className="w-3 h-3 animate-spin" /> : installDone ? <CheckCircle2 className="w-3 h-3" /> : <Download className="w-3 h-3" />}
            {installDone ? "Update Complete" : "Download & Install"}
          </Button>
        )}
      </div>

      {updateResult && (
        <div className="rounded-lg p-3 space-y-2"
          style={{
            background: updateResult.available ? "rgba(var(--neon-purple-rgb),0.08)" : "rgba(0,255,136,0.06)",
            border: `1px solid ${updateResult.available ? "rgba(var(--neon-purple-rgb),0.3)" : "rgba(0,255,136,0.25)"}`,
          }}>
          {currentVersion && (
            <div className="flex items-center gap-2 text-xs flex-wrap">
              <span style={{ color: "var(--text-muted)" }}>Current:</span>
              <span className="font-mono" style={{ color: "var(--foreground)" }}>{currentVersion}</span>
              <span style={{ color: "var(--text-muted)" }}>→</span>
              <span className="font-mono" style={{ color: "var(--neon-purple)" }}>{updateResult.version}</span>
            </div>
          )}
          {updateResult.available ? (
            installMethod === "pkgbuild" ? (
              <p className="text-xs" style={{ color: "var(--neon-orange)" }}>
                Manual update required — run <span className="font-mono">makepkg -si</span> in your LokiASAM folder to update.
              </p>
            ) : (
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>A newer version is available.</p>
            )
          ) : (
            <p className="text-xs" style={{ color: "var(--neon-green)" }}>You are on the latest version.</p>
          )}
        </div>
      )}

      <Separator style={{ background: "var(--border)" }} />
      <div className="space-y-2">
        <Label style={{ color: "var(--text-primary)" }}>Check Frequency</Label>
        <div className="flex gap-2 flex-wrap">
          {APP_UPDATE_MODE_OPTIONS.map((opt) => (
            <button key={opt.value} onClick={() => handleModeChange(opt.value)} className="text-xs px-3 py-1.5 rounded-lg transition-all"
              style={{
                background: mode === opt.value ? "rgba(var(--neon-purple-rgb),0.15)" : "transparent",
                border: `1px solid ${mode === opt.value ? "var(--neon-purple)" : "var(--border)"}`,
                color: mode === opt.value ? "var(--neon-purple)" : "var(--text-muted)",
              }}>
              {opt.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ASA Server Cache row — Install / Reinstall / Verify the shared server cache
// ---------------------------------------------------------------------------

// Persists the active operation type across navigation (component remounts)
let _asaCacheActiveOp: "install" | "reinstall" | "verify" = "install";

const CACHE_OP_LABELS: Record<string, string> = {
  install:   "Installing ASA cache…",
  reinstall: "Reinstalling ASA cache…",
  verify:    "Verifying ASA cache…",
};

function AsaServerCacheRow({ autoStart = false, onAutoStartConsumed }: { autoStart?: boolean; onAutoStartConsumed?: () => void }) {
  const [cachedBuild, setCachedBuild] = useState("");
  const [baseDir, setBaseDir]         = useState("");
  const [phase, setPhase]             = useState<"idle" | "running" | "done" | "error">("idle");
  const [operation, setOperation]     = useState<"install" | "reinstall" | "verify">("install");
  const [autoStartPending, setAutoStartPending] = useState(false);
  // True only when we reconnected to an op that was already running (navigation case).
  // When runCacheOp starts the op directly, it manages phase itself — no polling needed.
  const reconnectedRef = useRef(false);
  const containerRef   = useRef<HTMLDivElement>(null);

  const getCacheDir = useCallback((dir: string) => {
    if (!dir) return "";
    const sep = dir.includes("\\") ? "\\" : "/";
    return `${dir.replace(/[/\\]$/, "")}${sep}lokiasam${sep}cache${sep}asa-server`;
  }, []);

  const runCacheOp = useCallback(async (op: "install" | "reinstall" | "verify") => {
    if (!baseDir) { toast.error("Base directory not configured."); return; }
    reconnectedRef.current = false; // Direct mode: runCacheOp manages phase
    _asaCacheActiveOp = op;
    setOperation(op);
    setPhase("running");
    try {
      if (op === "reinstall") {
        await tauriCmd.deleteDirectory(getCacheDir(baseDir)).catch(() => {});
        await setAppSetting("asa_cached_build_id", "");
      }
      const newBuild = await runAsaCacheUpdate(CACHE_OP_LABELS[op]);
      if (newBuild) {
        setCachedBuild(newBuild);
        setPhase("done");
        const label = op === "reinstall" ? "reinstalled" : op === "install" ? "installed" : "verified";
        toast.success(`Server cache ${label} (build ${newBuild}).`);
      } else {
        setPhase("error");
      }
    } catch (e) {
      if (!String(e).includes("Aborted")) toast.error(`Cache ${op} failed: ${e}`);
      setPhase("error");
    }
  }, [baseDir, getCacheDir]);

  const load = useCallback(async () => {
    const [build, dir] = await Promise.all([
      getAppSetting("asa_cached_build_id"),
      getAppSetting("base_dir"),
    ]);
    setCachedBuild(build ?? "");
    setBaseDir(dir ?? "");
    return dir ?? "";
  }, []);

  // On mount: check if a cache operation is already running in the background
  // (e.g. user navigated away and came back). Restore running state if so.
  useEffect(() => {
    if (autoStart) {
      onAutoStartConsumed?.();
      setAutoStartPending(true);
    }
    load().then((dir) => {
      if (autoStart && dir) return; // autoStartPending will drive the start via the effect below
      tauriCmd.getRunningOps().then((ops) => {
        if (ops.includes("check")) {
          reconnectedRef.current = true;
          setOperation(_asaCacheActiveOp);
          setPhase("running");
        }
      }).catch(() => {});
    });
  }, [load]); // eslint-disable-line react-hooks/exhaustive-deps

  // After an auto-start navigation: once baseDir is loaded, scroll into view and start install.
  useEffect(() => {
    if (!autoStartPending || !baseDir) return;
    setAutoStartPending(false);
    containerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    runCacheOp("install");
  }, [autoStartPending, baseDir, runCacheOp]);

  // Poll for completion — only when we reconnected to a background op.
  // When runCacheOp started the op directly, it awaits the result itself.
  useEffect(() => {
    if (phase !== "running" || !reconnectedRef.current) return;
    const interval = setInterval(async () => {
      try {
        const ops = await tauriCmd.getRunningOps();
        if (!ops.includes("check")) {
          clearInterval(interval);
          reconnectedRef.current = false;
          // Brief delay so the JS side of runAsaCacheUpdate() can finish saving
          // asa_cached_build_id before we read it.
          await new Promise((r) => setTimeout(r, 400));
          const build = await getAppSetting("asa_cached_build_id");
          setCachedBuild(build ?? "");
          setPhase(build ? "done" : "error");
        }
      } catch { /* ignore poll errors */ }
    }, 2000);
    return () => clearInterval(interval);
  }, [phase]);

  const hasCache = !!cachedBuild;
  const busy = phase === "running";

  return (
    <div ref={containerRef} className="space-y-3">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
            ARK: Survival Ascended Server
          </p>
          <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
            {hasCache ? (
              <>Shared cache build: <span className="font-mono" style={{ color: "var(--neon-purple)" }}>{cachedBuild}</span></>
            ) : (
              "Shared server cache not yet downloaded."
            )}
          </p>
          <p className="text-[11px] mt-0.5" style={{ color: "var(--text-subtle)" }}>
            This is the shared cache used by all server instances, not an individual server install.
          </p>
        </div>
        <div className="flex gap-2 shrink-0 flex-wrap">
          {busy && (
            <Button onClick={() => tauriCmd.abortOperation("check")} size="sm" variant="ghost" className="gap-1 h-7 text-xs"
              style={{ color: "var(--neon-red)", border: "1px solid rgba(255,0,85,0.3)" }}>
              <StopCircle className="w-3 h-3" /> Abort
            </Button>
          )}
          {hasCache && (
            <Button onClick={() => runCacheOp("verify")} disabled={busy} size="sm" className="gap-1.5 h-7 text-xs"
              style={{
                background: phase === "done" && operation === "verify" ? "rgba(0,255,136,0.1)" : "rgba(var(--neon-purple-rgb),0.08)",
                border: `1px solid ${phase === "done" && operation === "verify" ? "rgba(0,255,136,0.4)" : "rgba(var(--neon-purple-rgb),0.3)"}`,
                color: phase === "done" && operation === "verify" ? "var(--neon-green)" : "var(--neon-purple)",
              }}>
              {busy && operation === "verify" ? <Loader2 className="w-3 h-3 animate-spin" /> : phase === "done" && operation === "verify" ? <CheckCircle2 className="w-3 h-3" /> : <CheckCircle2 className="w-3 h-3" />}
              {phase === "done" && operation === "verify" ? "Verified" : "Verify"}
            </Button>
          )}
          <Button onClick={() => runCacheOp(hasCache ? "reinstall" : "install")} disabled={busy} size="sm" className="gap-1.5 h-7 text-xs"
            style={{
              background: phase === "done" && operation !== "verify" ? "rgba(0,255,136,0.1)" : "rgba(var(--neon-purple-rgb),0.08)",
              border: `1px solid ${phase === "done" && operation !== "verify" ? "rgba(0,255,136,0.4)" : "rgba(var(--neon-purple-rgb),0.3)"}`,
              color: phase === "done" && operation !== "verify" ? "var(--neon-green)" : "var(--neon-purple)",
            }}>
            {busy && operation !== "verify"
              ? <Loader2 className="w-3 h-3 animate-spin" />
              : phase === "done" && operation !== "verify"
                ? <CheckCircle2 className="w-3 h-3" />
                : hasCache ? <RefreshCw className="w-3 h-3" /> : <Download className="w-3 h-3" />}
            {phase === "done" && operation !== "verify" ? "Done" : hasCache ? "Reinstall ASA Server Cache" : "Install ASA Server Cache"}
          </Button>
        </div>
      </div>
      {(busy || phase === "done") && (
        <CommandOutputPanel
          eventChannel="steamcmd://output/check"
          label="ASA Server Cache"
          completed={phase === "done"}
          bodyClassName="h-40"
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SteamCMD reinstall row (shown inline under the SteamCMD path field)
// ---------------------------------------------------------------------------

function SteamcmdReinstallRow() {
  const [reinstalling, setReinstalling] = useState(false);
  const [done, setDone]                 = useState(false);

  const handleReinstall = async () => {
    const currentPath = await getAppSetting("steamcmd_path");
    if (!currentPath) { toast.error("SteamCMD path not configured."); return; }
    // Reinstall to the same directory the current executable lives in
    const targetDir = currentPath.replace(/[/\\][^/\\]+$/, "");
    setReinstalling(true); setDone(false);
    try {
      await tauriCmd.installSteamcmd(targetDir);
      const sep = targetDir.includes("\\") ? "\\" : "/";
      const exe = navigator.userAgent.includes("Windows") ? "steamcmd.exe" : "steamcmd.sh";
      const newPath = `${targetDir}${sep}${exe}`;
      await setAppSetting("steamcmd_path", newPath);
      setDone(true);
      toast.success("SteamCMD reinstalled successfully.");
    } catch (e) {
      if (String(e).includes("Aborted")) toast.info("SteamCMD reinstall aborted.");
      else toast.error(`SteamCMD reinstall failed: ${e}`);
    } finally { setReinstalling(false); }
  };

  return (
    <div className="flex items-center justify-between pt-1">
      <p className="text-xs" style={{ color: "var(--text-muted)" }}>
        Re-download and extract SteamCMD to the default location.
      </p>
      <div className="flex gap-2">
        {reinstalling && (
          <Button onClick={() => tauriCmd.abortOperation("steamcmd_install")} size="sm" variant="ghost" className="gap-1 h-7 text-xs"
            style={{ color: "var(--neon-red)", border: "1px solid rgba(255,0,85,0.3)" }}>
            <StopCircle className="w-3 h-3" /> Abort
          </Button>
        )}
        <Button onClick={handleReinstall} disabled={reinstalling} size="sm" className="gap-1.5 h-7 text-xs"
          style={{
            background: done ? "rgba(0,255,136,0.1)" : "rgba(var(--neon-purple-rgb),0.08)",
            border: `1px solid ${done ? "rgba(0,255,136,0.4)" : "rgba(var(--neon-purple-rgb),0.3)"}`,
            color: done ? "var(--neon-green)" : "var(--neon-purple)",
          }}>
          {reinstalling ? <Loader2 className="w-3 h-3 animate-spin" /> : done ? <CheckCircle2 className="w-3 h-3" /> : <RefreshCw className="w-3 h-3" />}
          {done ? "Done" : "Reinstall SteamCMD"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Proton-GE install/reinstall row (managed installs only, Linux only)
// ---------------------------------------------------------------------------

const PROTON_CHANNEL = "proton://output/download";

function ProtonGeInstallRow() {
  const protonOpLabel    = useAppStore((s) => s.protonOpLabel);
  const protonOpDone     = useAppStore((s) => s.protonOpDone);
  const setProtonOpLabel = useAppStore((s) => s.setProtonOpLabel);
  const setProtonOpDone  = useAppStore((s) => s.setProtonOpDone);

  const [protonPath, setProtonPath]           = useState("");
  const [isManaged, setIsManaged]             = useState(false);
  const [phase, setPhase]                     = useState<"idle" | "running" | "done" | "error">("idle");
  const [isReinstall, setIsReinstall]         = useState(false);
  const [showManagedConfirm, setShowManagedConfirm] = useState(false);

  useEffect(() => {
    Promise.all([
      getAppSetting("proton_path"),
      getAppSetting("proton_ge_managed"),
    ]).then(([p, managed]) => {
      setProtonPath(p ?? "");
      setIsManaged(managed === "true");
    });
  }, []);

  // Restore phase from Zustand on mount so nav-away/back shows the right state.
  useEffect(() => {
    if (protonOpLabel !== null) setPhase("running");
    else if (protonOpDone)      setPhase("done");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleConfirmManaged = async () => {
    await setAppSetting("proton_ge_managed", "true");
    setIsManaged(true);
    setShowManagedConfirm(false);
    toast.success("LokiASAM will now manage Proton-GE updates.");
  };

  const hasInstall = !!protonPath;
  const busy = phase === "running";

  const handleRun = async (reinstall: boolean) => {
    const baseDir = await getAppSetting("base_dir");
    if (!baseDir) { toast.error("Base directory not configured."); return; }
    const sep = baseDir.includes("\\") ? "\\" : "/";
    // Reinstall: go back to the same parent directory we deleted from.
    // Fresh install: fall back to the managed default location.
    const targetDir = protonPath
      ? protonPath.replace(/[/\\][^/\\]+$/, "")
      : `${baseDir.replace(/[/\\]$/, "")}${sep}lokiasam${sep}proton`;
    setIsReinstall(reinstall);
    setPhase("running");
    setProtonOpLabel(reinstall ? "Reinstalling Proton-GE…" : "Installing Proton-GE…");
    setProtonOpDone(false);
    try {
      if (reinstall && protonPath) {
        await tauriCmd.deleteDirectory(protonPath).catch(() => {});
      }
      const newPath = await tauriCmd.downloadProtonGe(targetDir);
      await setAppSetting("proton_path", newPath);
      setProtonPath(newPath);
      setPhase("done");
      setProtonOpLabel(null);
      setProtonOpDone(true);
      toast.success(`Proton-GE ${reinstall ? "reinstalled" : "installed"} successfully.`);
    } catch (e) {
      if (!String(e).includes("Aborted")) toast.error(`Proton-GE ${reinstall ? "reinstall" : "install"} failed: ${e}`);
      setPhase("error");
      setProtonOpLabel(null);
      setProtonOpDone(false);
    }
  };

  if (!isManaged) {
    return (
      <div className="space-y-3 pt-1">
        <div className="flex items-start gap-2 rounded-lg px-3 py-2.5"
          style={{ background: "rgba(255,136,0,0.07)", border: "1px solid rgba(255,136,0,0.2)" }}>
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: "var(--neon-orange)" }} />
          <p className="text-xs" style={{ color: "var(--neon-orange)" }}>
            Proton-GE is in unmanaged mode — LokiASAM will not check for or update it.
          </p>
        </div>
        <div className="flex justify-end">
          <Button
            variant="outline"
            onClick={() => setShowManagedConfirm(true)}
            className="gap-2 bg-[rgba(255,0,85,0.08)]! hover:bg-[rgba(255,0,85,0.2)]!"
            style={{ borderColor: "rgba(255,0,85,0.3)", color: "var(--neon-red)" }}
          >
            <TriangleAlert className="w-4 h-4" />
            Allow LokiASAM to Manage This Proton Install
          </Button>
        </div>
        <Dialog open={showManagedConfirm} onOpenChange={(v) => { if (!v) setShowManagedConfirm(false); }}>
          <DialogContent showCloseButton={false} className="max-w-lg" style={{ background: "var(--popover)", border: "1px solid rgba(255,136,0,0.35)" }}>
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
                  For the safest experience, let LokiASAM download and install its own dedicated copy of Proton-GE instead.
                </span>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="flex-col gap-2 sm:flex-col">
              <Button variant="outline"
                className="w-full gap-1.5 bg-[rgba(255,0,85,0.08)]! hover:bg-[rgba(255,0,85,0.2)]!"
                style={{ borderColor: "rgba(255,0,85,0.3)", color: "var(--neon-red)" }}
                onClick={handleConfirmManaged}>
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
    );
  }

  return (
    <div className="space-y-3 pt-1">
      <div className="flex items-center justify-between gap-4">
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          {hasInstall
            ? "Re-download and replace the managed Proton-GE installation."
            : "Download and install Proton-GE to the managed location."}
        </p>
        <div className="flex gap-2 shrink-0">
          {busy && (
            <Button onClick={() => tauriCmd.abortOperation("proton_download")} size="sm" variant="ghost" className="gap-1 h-7 text-xs"
              style={{ color: "var(--neon-red)", border: "1px solid rgba(255,0,85,0.3)" }}>
              <StopCircle className="w-3 h-3" /> Abort
            </Button>
          )}
          <Button onClick={() => handleRun(hasInstall)} disabled={busy} size="sm" className="gap-1.5 h-7 text-xs"
            style={{
              background: phase === "done" ? "rgba(0,255,136,0.1)" : "rgba(var(--neon-purple-rgb),0.08)",
              border: `1px solid ${phase === "done" ? "rgba(0,255,136,0.4)" : "rgba(var(--neon-purple-rgb),0.3)"}`,
              color: phase === "done" ? "var(--neon-green)" : "var(--neon-purple)",
            }}>
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : phase === "done" ? <CheckCircle2 className="w-3 h-3" /> : hasInstall ? <RefreshCw className="w-3 h-3" /> : <Download className="w-3 h-3" />}
            {phase === "done" ? "Done" : hasInstall ? "Reinstall Proton-GE" : "Install Proton-GE"}
          </Button>
        </div>
      </div>
      {(phase === "running" || phase === "done" || hasOutputBuffer(PROTON_CHANNEL)) && (
        <CommandOutputPanel eventChannel={PROTON_CHANNEL} label="Proton-GE" completed={phase === "done"} bodyClassName="h-40" />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Amazon Root CA certificate install row
// ---------------------------------------------------------------------------

function CertInstallRow() {
  const [phase, setPhase]       = useState<"idle" | "downloading" | "installing" | "done" | "error">("idle");
  const [error, setError]       = useState("");
  const [isInstalled, setIsInstalled] = useState(false);

  useEffect(() => {
    (async () => {
      const protonPath  = IS_LINUX ? (await getAppSetting("proton_path"))        ?? undefined : undefined;
      const prefixPath  = IS_LINUX ? (await getAppSetting("proton_prefix_path")) ?? undefined : undefined;
      const installed = await tauriCmd.checkAmazonRootCaInstalled(protonPath, prefixPath).catch(() => false);
      setIsInstalled(installed);
    })();
  }, []);

  const handleInstall = async () => {
    setError("");
    try {
      const baseDir = await getAppSetting("base_dir");
      const tmp = await tempDir();
      setPhase("downloading");
      const certPath = await tauriCmd.downloadAmazonRootCa(tmp);

      setPhase("installing");
      const protonPath  = IS_LINUX ? (await getAppSetting("proton_path"))        ?? undefined : undefined;
      const prefixPath  = IS_LINUX ? (await getAppSetting("proton_prefix_path")) ?? undefined : undefined;
      // If prefix path isn't saved yet, compute it from base dir.
      const resolvedPrefix = prefixPath ?? (IS_LINUX && baseDir
        ? (() => {
            const sep = baseDir.includes("\\") ? "\\" : "/";
            return `${baseDir.replace(/[/\\]$/, "")}${sep}lokiasam${sep}proton${sep}prefix`;
          })()
        : undefined);
      await tauriCmd.installAmazonRootCa(certPath, protonPath, resolvedPrefix);
      setPhase("done");
      setIsInstalled(true);
      toast.success("Amazon Root CA 1 installed successfully.");
    } catch (e) {
      setError(String(e));
      setPhase("error");
      toast.error(`Certificate install failed: ${e}`);
    }
  };

  const busy = phase === "downloading" || phase === "installing";

  return (
    <div className="flex flex-col gap-1.5 pt-1">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>Amazon Root CA 1</p>
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            {IS_LINUX
              ? "Install into the Wine prefix so CurseForge mod API TLS works correctly."
              : "Install into the Windows cert store so CurseForge mod API TLS works correctly."}
          </p>
        </div>
        <Button
          onClick={handleInstall}
          disabled={busy}
          size="sm"
          className="gap-1.5 h-7 text-xs shrink-0 ml-4"
          style={{
            background: phase === "done" ? "rgba(0,255,136,0.1)" : "rgba(var(--neon-purple-rgb),0.08)",
            border: `1px solid ${phase === "done" ? "rgba(0,255,136,0.4)" : "rgba(var(--neon-purple-rgb),0.3)"}`,
            color: phase === "done" ? "var(--neon-green)" : "var(--neon-purple)",
          }}
        >
          {busy
            ? <Loader2 className="w-3 h-3 animate-spin" />
            : phase === "done"
              ? <CheckCircle2 className="w-3 h-3" />
              : <ShieldCheck className="w-3 h-3" />}
          {busy
            ? (phase === "downloading" ? "Downloading…" : "Installing…")
            : phase === "done"
              ? "Installed"
              : isInstalled ? "Reinstall Certs" : "Install Certs"}
        </Button>
      </div>
      {phase === "error" && (
        <p className="text-xs break-all" style={{ color: "var(--neon-red, #f87171)" }}>
          {error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Firewall check/repair row
// ---------------------------------------------------------------------------

function FirewallRepairRow() {
  const [phase, setPhase] = useState<"idle" | "checking" | "ready" | "error">("idle");
  const [isFixing, setIsFixing] = useState(false);
  const [fwStatus, setFwStatus] = useState<FirewallStatus | null>(null);
  const [error, setError] = useState("");

  const runCheck = async () => {
    setError("");
    setPhase("checking");
    try {
      const servers = await getServers();
      const seen = new Map<string, PortDef>();
      for (const srv of servers) {
        for (const p of getServerFirewallPorts(srv)) {
          seen.set(`${p.port}/${p.protocol}`, p);
        }
      }
      const allPorts = [...seen.values()];
      if (allPorts.length === 0) {
        setFwStatus({ firewallType: "none", active: false, ports: [] });
        setPhase("ready");
        return;
      }
      const result = await tauriCmd.checkFirewallPorts(allPorts);
      setFwStatus(result);
      setPhase("ready");
    } catch (e) {
      setError(String(e));
      setPhase("error");
    }
  };

  const handleFix = async () => {
    if (!fwStatus) return;
    setIsFixing(true);
    try {
      // Pass the complete desired port set so the backend can rebuild from scratch,
      // removing any stale entries from previously deleted servers.
      const allPorts: PortDef[] = fwStatus.ports
        .map((p) => ({ port: p.port, protocol: p.protocol as "tcp" | "udp" }));
      const protonPath = IS_LINUX ? (await getAppSetting("proton_path")) ?? undefined : undefined;
      await tauriCmd.addFirewallRules(allPorts, protonPath);
      toast.success("Firewall rules added.");
      await runCheck();
    } catch (e) {
      setError(String(e));
      setPhase("error");
      toast.error(`Failed to add firewall rules: ${e}`);
    } finally {
      setIsFixing(false);
    }
  };

  const missing = fwStatus?.ports.filter((p) => !p.covered) ?? [];
  const allGood = fwStatus !== null && (!fwStatus.active || missing.length === 0);
  const busy = phase === "checking" || isFixing;

  return (
    <div className="flex flex-col gap-2 pt-1">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>Firewall Rules</p>
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            Check and repair port rules for all configured servers.
          </p>
        </div>
        <Button
          onClick={runCheck}
          disabled={busy}
          size="sm"
          className="gap-1.5 h-7 text-xs shrink-0 ml-4"
          style={{
            background: allGood ? "rgba(0,255,136,0.1)" : "rgba(var(--neon-purple-rgb),0.08)",
            border: `1px solid ${allGood ? "rgba(0,255,136,0.4)" : "rgba(var(--neon-purple-rgb),0.3)"}`,
            color: allGood ? "var(--neon-green)" : "var(--neon-purple)",
          }}
        >
          {phase === "checking"
            ? <Loader2 className="w-3 h-3 animate-spin" />
            : allGood
              ? <CheckCircle2 className="w-3 h-3" />
              : <ShieldCheck className="w-3 h-3" />}
          {phase === "checking" ? "Checking…" : allGood ? "All Good" : "Check & Repair Firewall"}
        </Button>
      </div>

      {phase === "ready" && fwStatus && (
        <div className="pl-1 flex flex-col gap-1">
          {!fwStatus.active ? (
            <p className="text-xs flex items-center gap-1.5" style={{ color: "var(--neon-green)" }}>
              <CheckCircle2 className="w-3 h-3 shrink-0" />
              No active firewall detected — nothing to do.
            </p>
          ) : fwStatus.ports.length === 0 ? (
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>No servers configured.</p>
          ) : (
            <>
              {fwStatus.ports.map((p) => (
                <p
                  key={`${p.port}/${p.protocol}`}
                  className="text-xs flex items-center gap-1.5"
                  style={{ color: p.covered ? "var(--neon-green)" : "var(--neon-orange, #fb923c)" }}
                >
                  {p.covered
                    ? <CheckCircle2 className="w-3 h-3 shrink-0" />
                    : <AlertCircle className="w-3 h-3 shrink-0" />}
                  {p.port}/{p.protocol.toUpperCase()} — {p.covered ? "allowed" : "missing"}
                </p>
              ))}
              {missing.length > 0 && (
                <Button
                  onClick={handleFix}
                  disabled={isFixing}
                  size="sm"
                  className="gap-1.5 h-7 text-xs mt-1 self-start"
                  style={{
                    background: "rgba(251,146,60,0.1)",
                    border: "1px solid rgba(251,146,60,0.4)",
                    color: "var(--neon-orange, #fb923c)",
                  }}
                >
                  {isFixing
                    ? <><Loader2 className="w-3 h-3 animate-spin" /> Adding rules…</>
                    : `Fix ${missing.length} Missing Rule${missing.length > 1 ? "s" : ""}`}
                </Button>
              )}
            </>
          )}
        </div>
      )}

      {phase === "error" && (
        <p className="text-xs break-all" style={{ color: "var(--neon-red, #f87171)" }}>{error}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Proton-GE Update section (Linux only)
// ---------------------------------------------------------------------------

function ProtonGeUpdateSection({ autoStart }: { autoStart?: boolean }) {
  const protonOpLabel    = useAppStore((s) => s.protonOpLabel);
  const protonOpDone     = useAppStore((s) => s.protonOpDone);
  const setProtonOpLabel = useAppStore((s) => s.setProtonOpLabel);
  const setProtonOpDone  = useAppStore((s) => s.setProtonOpDone);

  const [protonPath, setProtonPath]         = useState("");
  const [isManaged, setIsManaged]           = useState(false);
  const [checking, setChecking]             = useState(false);
  const [updateInfo, setUpdateInfo]         = useState<ProtonUpdateInfo | null>(null);
  const [downloading, setDownloading]       = useState(false);
  const [downloadDone, setDownloadDone]     = useState(false);
  const [checkMode, setCheckMode]           = useState("disabled");
  const [showManagedConfirm, setShowManagedConfirm] = useState(false);
  const autoStartedRef = useRef(false);
  const sectionRef     = useRef<HTMLDivElement>(null);

  useEffect(() => {
    Promise.all([
      getAppSetting("proton_path"),
      getAppSetting("proton_ge_managed"),
      getAppSetting("proton_ge_check_mode"),
    ]).then(([p, managed, mode]) => {
      setProtonPath(p ?? "");
      setIsManaged(managed === "true");
      setCheckMode(mode ?? "disabled");
    });
  }, []);

  // Restore in-progress / done state from Zustand on mount (nav-away/back).
  useEffect(() => {
    if (protonOpLabel !== null) setDownloading(true);
    else if (protonOpDone)      setDownloadDone(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Scroll this section into view when navigated here from the update toast.
  useEffect(() => {
    if (!autoStart) return;
    const frame = requestAnimationFrame(() => {
      sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => cancelAnimationFrame(frame);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCheckUpdate = async () => {
    setChecking(true);
    setUpdateInfo(null);
    try {
      const info = await tauriCmd.checkProtonGeUpdate(protonPath);
      setUpdateInfo(info);
      if (info.updateAvailable) {
        toast.info(`Proton-GE ${info.latestVersion} is available.`);
      } else {
        toast.success("Proton-GE is up to date.");
      }
    } catch (e) { toast.error(`Failed to check for updates: ${e}`); }
    finally { setChecking(false); }
  };

  const handleDownload = async () => {
    if (!protonPath) { toast.error("Proton-GE path not configured."); return; }
    const targetDir = protonPath.replace(/[/\\][^/\\]+$/, "");
    setDownloading(true); setDownloadDone(false);
    setProtonOpLabel("Updating Proton-GE…");
    setProtonOpDone(false);
    try {
      const newPath = await tauriCmd.downloadProtonGe(targetDir);
      await setAppSetting("proton_path", newPath);
      await setAppSetting("proton_ge_managed", "true");
      setProtonPath(newPath);
      setIsManaged(true);
      setDownloadDone(true);
      setUpdateInfo(null);
      setProtonOpLabel(null);
      setProtonOpDone(true);
      toast.success("Proton-GE updated successfully.");
    } catch (e) {
      setProtonOpLabel(null);
      setProtonOpDone(false);
      if (!String(e).includes("Aborted")) toast.error(`Proton-GE update failed: ${e}`);
    }
    finally { setDownloading(false); }
  };

  const handleConfirmManaged = async () => {
    await setAppSetting("proton_ge_managed", "true");
    setIsManaged(true);
    setShowManagedConfirm(false);
    toast.success("LokiASAM will now manage Proton-GE updates.");
  };

  const handleCheckModeChange = async (value: string) => {
    setCheckMode(value);
    await setAppSetting("proton_ge_check_mode", value);
  };

  // When navigated here via the update toast, auto-start the download once settings are loaded.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!autoStart || autoStartedRef.current || !protonPath || !isManaged) return;
    autoStartedRef.current = true;
    handleDownload();
  }, [autoStart, protonPath, isManaged]);

  // Determine if the current path is inside the managed location
  const managedPattern = /[/\\]proton[/\\]GE-Proton/;
  const looksExternal = protonPath && !managedPattern.test(protonPath);
  const currentVersion = protonPath
    ? protonPath.replace(/[/\\]$/, "").split(/[/\\]/).pop() ?? ""
    : "";

  return (
    <div ref={sectionRef} className="space-y-4">
      {/* Current version row */}
      {currentVersion && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>Installed:</span>
          <span className="font-mono text-xs px-2 py-0.5 rounded"
            style={{ background: "rgba(0,255,136,0.1)", color: "var(--neon-green)", border: "1px solid rgba(0,255,136,0.3)" }}>
            {currentVersion}
          </span>
          {isManaged
            ? <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: "rgba(0,255,136,0.08)", color: "var(--neon-green)", border: "1px solid rgba(0,255,136,0.2)" }}>Managed</span>
            : <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: "rgba(255,136,0,0.08)", color: "var(--neon-orange)", border: "1px solid rgba(255,136,0,0.2)" }}>Unmanaged</span>
          }
        </div>
      )}

      {/* Unmanaged notice — shown whenever isManaged is false */}
      {!isManaged && (
        <div className="space-y-3">
          <div className="flex items-start gap-2 rounded-lg px-3 py-2.5"
            style={{ background: "rgba(255,136,0,0.07)", border: "1px solid rgba(255,136,0,0.2)" }}>
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: "var(--neon-orange)" }} />
            <p className="text-xs" style={{ color: "var(--neon-orange)" }}>
              Proton-GE is in unmanaged mode — LokiASAM will not check for or update it.
              {looksExternal && " The current path is outside LokiASAM's managed directory."}
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
        </div>
      )}

      {/* Update check result */}
      {updateInfo && !downloadDone && (
        <div className="rounded-lg p-3 space-y-2"
          style={{
            background: updateInfo.updateAvailable ? "rgba(var(--neon-purple-rgb),0.08)" : "rgba(0,255,136,0.06)",
            border: `1px solid ${updateInfo.updateAvailable ? "rgba(var(--neon-purple-rgb),0.3)" : "rgba(0,255,136,0.25)"}`,
          }}>
          {updateInfo.currentVersion ? (
            <div className="flex items-center gap-2 text-xs flex-wrap">
              <span style={{ color: "var(--text-muted)" }}>Current:</span>
              <span className="font-mono" style={{ color: "var(--foreground)" }}>{updateInfo.currentVersion}</span>
              <span style={{ color: "var(--text-muted)" }}>→</span>
              <span className="font-mono" style={{ color: "var(--neon-purple)" }}>{updateInfo.latestVersion}</span>
            </div>
          ) : (
            <p className="text-xs" style={{ color: "var(--foreground)" }}>
              Latest: <span className="font-mono" style={{ color: "var(--neon-purple)" }}>{updateInfo.latestVersion}</span>
            </p>
          )}
          {updateInfo.updateAvailable ? (
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>A newer version is available.</p>
          ) : (
            <p className="text-xs" style={{ color: "var(--neon-green)" }}>You are on the latest version.</p>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex flex-wrap gap-2">
        <Button onClick={handleCheckUpdate} disabled={checking || !!protonOpLabel || !isManaged} size="sm" className="gap-1.5"
          style={{ background: "rgba(var(--neon-purple-rgb),0.08)", border: "1px solid rgba(var(--neon-purple-rgb),0.3)", color: "var(--neon-purple)" }}>
          {checking ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
          Check for Proton-GE Update
        </Button>

        {(updateInfo?.updateAvailable || (!protonPath && updateInfo)) && (isManaged || !looksExternal) && (
          <Button onClick={handleDownload} disabled={!!protonOpLabel || downloadDone} size="sm" className="gap-1.5"
            style={{
              background: downloadDone ? "rgba(0,255,136,0.15)" : "rgba(var(--neon-purple-rgb),0.15)",
              border: `1px solid ${downloadDone ? "rgba(0,255,136,0.4)" : "rgba(var(--neon-purple-rgb),0.4)"}`,
              color: downloadDone ? "var(--neon-green)" : "var(--neon-purple)",
            }}>
            {downloading ? <Loader2 className="w-3 h-3 animate-spin" /> : downloadDone ? <CheckCircle2 className="w-3 h-3" /> : <Download className="w-3 h-3" />}
            {downloadDone ? "Update Complete" : "Download & Install"}
          </Button>
        )}

        {protonOpLabel && (
          <Button onClick={() => tauriCmd.abortOperation("proton_download")} size="sm" variant="ghost" className="gap-1.5"
            style={{ color: "var(--neon-red)", border: "1px solid rgba(255,0,85,0.3)" }}>
            <StopCircle className="w-3 h-3" /> Abort
          </Button>
        )}
      </div>

      {/* Auto-check mode */}
      <div className="space-y-2" style={{ opacity: isManaged ? 1 : 0.4, pointerEvents: isManaged ? "auto" : "none" }}>
        <Label style={{ color: "var(--text-primary)" }}>Auto-Check Frequency</Label>
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          Automatically check GitHub for new GE-Proton releases.
        </p>
        <div className="flex gap-2 flex-wrap">
          {[
            { value: "disabled",       label: "Disabled" },
            { value: "startup",        label: "On startup" },
            { value: "startup_hourly", label: "On startup + hourly" },
          ].map((opt) => (
            <button key={opt.value} onClick={() => handleCheckModeChange(opt.value)} className="text-xs px-3 py-1.5 rounded-lg transition-all"
              style={{
                background: checkMode === opt.value ? "rgba(var(--neon-purple-rgb),0.15)" : "transparent",
                border: `1px solid ${checkMode === opt.value ? "var(--neon-purple)" : "var(--border)"}`,
                color: checkMode === opt.value ? "var(--neon-purple)" : "var(--text-muted)",
              }}>
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Managed confirmation dialog */}
      <Dialog open={showManagedConfirm} onOpenChange={(v) => { if (!v) setShowManagedConfirm(false); }}>
        <DialogContent showCloseButton={false} className="max-w-lg" style={{ background: "var(--popover)", border: "1px solid rgba(255,136,0,0.35)" }}>
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
                For the safest experience, let LokiASAM download and install its own dedicated copy of Proton-GE instead.
              </span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col gap-2 sm:flex-col">
            <Button variant="outline"
              className="w-full gap-1.5 bg-[rgba(255,0,85,0.08)]! hover:bg-[rgba(255,0,85,0.2)]!"
              style={{ borderColor: "rgba(255,0,85,0.3)", color: "var(--neon-red)" }}
              onClick={handleConfirmManaged}>
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

      {/* Download output */}
      {(downloading || downloadDone || hasOutputBuffer(PROTON_CHANNEL)) && (
        <CommandOutputPanel eventChannel={PROTON_CHANNEL} label="Proton-GE Download" completed={downloadDone} bodyClassName="h-48" />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notification Channels section
// ---------------------------------------------------------------------------

const GLOBAL_CHANNEL_DEFS = [
  {
    id: "discord", label: "Discord Webhook", icon: MessageSquare,
    desc: "Global Discord webhook for all server events (can be overridden per server).",
    fields: [{ key: "webhookUrl", label: "Webhook URL", placeholder: "https://discord.com/api/webhooks/…", type: "url" }],
  },
  {
    id: "email", label: "Email / SMTP", icon: Mail,
    desc: "Global SMTP settings for all server email alerts.",
    fields: [
      { key: "host",        label: "SMTP Host", placeholder: "smtp.example.com",    type: "text"     },
      { key: "port",        label: "Port",       placeholder: "587",                 type: "number"   },
      { key: "username",    label: "Username",   placeholder: "user@example.com",    type: "text"     },
      { key: "password",    label: "Password",   placeholder: "••••••••",            type: "password" },
      { key: "fromAddress", label: "From",       placeholder: "noreply@example.com", type: "email"    },
      { key: "toAddress",   label: "To",         placeholder: "admin@example.com",   type: "email"    },
    ],
  },
];

function GlobalNotificationsSection({ onCredentialSaved }: { onCredentialSaved?: () => void }) {
  const [configs, setConfigs] = useState<NotificationConfigRow[]>([]);
  const [saving, setSaving]   = useState<string | null>(null);

  const loadConfigs = useCallback(async () => {
    try { setConfigs(await getNotificationConfigs(null)); } catch (err) { toast.error("Failed to load notification configs", { description: String(err) }); }
  }, []);

  useEffect(() => { loadConfigs(); }, [loadConfigs]);

  function getConfig(channelId: string) { return configs.find((c) => c.channel === channelId); }

  async function handleToggle(channelId: string, enabled: boolean) {
    const existing = getConfig(channelId);
    await saveNotificationConfig({
      id: existing?.id ?? crypto.randomUUID(), serverId: null, channel: channelId,
      enabled, configJson: existing?.config_json ?? "{}", eventsJson: existing?.events_json ?? "[]",
    });
    await loadConfigs();
  }

  async function handleSaveConfig(channelId: string, configJson: string) {
    setSaving(channelId);
    try {
      const existing = getConfig(channelId);
      await saveNotificationConfig({
        id: existing?.id ?? crypto.randomUUID(), serverId: null, channel: channelId,
        enabled: existing?.enabled === 1, configJson, eventsJson: existing?.events_json ?? "[]",
      });
      await loadConfigs();
      toast.success("Notification config saved.");
      onCredentialSaved?.();
    } catch (e) { toast.error(`Failed to save: ${e}`); }
    finally { setSaving(null); }
  }

  async function handleTest(channelId: string, cfgJson: string): Promise<boolean> {
    const cfg = JSON.parse(cfgJson) as Record<string, string | boolean | number>;
    try {
      if (channelId === "discord") {
        const url = cfg.webhookUrl as string | undefined;
        if (!url) { toast.error("Enter a webhook URL first."); return false; }
        await tauriCmd.sendDiscordNotification(url, { title: "LokiASAM Test", description: "Discord notifications are working.", color: 0x00ff88, serverName: "Global", eventType: "test" });
      } else if (channelId === "email") {
        const to = cfg.toAddress as string | undefined;
        if (!to) { toast.error("Enter a To address first."); return false; }
        await tauriCmd.sendEmailNotification(
          { host: (cfg.host as string) ?? "", port: Number(cfg.port ?? 587), username: (cfg.username as string) ?? "", password: (cfg.password as string) ?? "", fromAddress: (cfg.fromAddress as string) ?? "noreply@lokiasam", toAddress: to, useTls: Boolean(cfg.useTls ?? false) },
          { subject: "LokiASAM Test", body: "Email notifications are working." }
        );
      }
      toast.success("Test notification sent.");
      return true;
    } catch (e) { toast.error(`Test failed: ${e}`); return false; }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs" style={{ color: "var(--text-muted)" }}>
        Global channels apply to all servers that don&apos;t have a per-server override configured.
      </p>
      {GLOBAL_CHANNEL_DEFS.map((ch) => {
        const row = getConfig(ch.id);
        const enabled = row?.enabled === 1;
        const cfg = JSON.parse(row?.config_json ?? "{}") as Record<string, string>;
        const Icon = ch.icon;
        return (
          <GlobalChannelCard
            key={ch.id} channelId={ch.id} icon={Icon} label={ch.label} desc={ch.desc}
            fields={ch.fields} enabled={enabled} cfg={cfg} saving={saving === ch.id}
            onToggle={(v) => handleToggle(ch.id, v)}
            onSave={(cfgJson) => handleSaveConfig(ch.id, cfgJson)}
            onTest={(cfgJson) => handleTest(ch.id, cfgJson)}
          />
        );
      })}
    </div>
  );
}

interface GlobalChannelCardProps {
  channelId: string;
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  label: string; desc: string;
  fields: { key: string; label: string; placeholder: string; type: string }[];
  enabled: boolean; cfg: Record<string, string>; saving: boolean;
  onToggle: (v: boolean) => void;
  onSave: (cfgJson: string) => void;
  onTest: (cfgJson: string) => Promise<boolean>;
}

function GlobalChannelCard({ channelId: _channelId, icon: Icon, label, desc, fields, enabled, cfg, saving, onToggle, onSave, onTest }: GlobalChannelCardProps) {
  const [localCfg, setLocalCfg] = useState<Record<string, string>>(cfg);
  const [testing, setTesting]   = useState(false);
  const [testPassed, setTestPassed] = useState(false);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setLocalCfg(cfg); }, [JSON.stringify(cfg)]);

  const handleTestClick = async () => {
    setTesting(true);
    try {
      const passed = await onTest(JSON.stringify(localCfg));
      if (passed) {
        setTestPassed(true);
        await onSave(JSON.stringify(localCfg));
        if (!enabled) onToggle(true);
      }
    } finally {
      setTesting(false);
    }
  };

  const handleToggleAttempt = (v: boolean) => {
    if (v && !enabled && !testPassed) {
      toast.info("Test the connection first to enable this channel.");
      return;
    }
    onToggle(v);
  };

  return (
    <div className="rounded-xl overflow-hidden" style={{ border: "1px solid var(--border)" }}>
      <div className="flex items-center gap-3 px-4 py-3">
        <Icon className="w-4 h-4 shrink-0" style={{ color: "var(--neon-purple)" }} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>{label}</p>
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>{desc}</p>
        </div>
        <SettingsToggle checked={enabled} onChange={handleToggleAttempt} />
      </div>
      <div className="px-4 pb-4 pt-2 space-y-3 border-t" style={{ borderColor: "var(--border)" }}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {fields.map((f) => (
            <div key={f.key} className="flex flex-col gap-1">
              <Label className="text-[10px]" style={{ color: "var(--text-muted)" }}>{f.label}</Label>
              <Input type={f.type} value={localCfg[f.key] ?? ""} onChange={(e) => setLocalCfg((prev) => ({ ...prev, [f.key]: e.target.value }))}
                placeholder={f.placeholder} className="h-7 text-xs"
                style={{ background: "var(--surface)", borderColor: "var(--border)" }}
              />
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={handleTestClick} disabled={testing || saving} className="h-7 text-xs gap-1"
            style={{
              background: testPassed ? "rgba(0,255,136,0.1)" : "rgba(var(--neon-purple-rgb),0.12)",
              border: `1px solid ${testPassed ? "rgba(0,255,136,0.4)" : "rgba(var(--neon-purple-rgb),0.35)"}`,
              color: testPassed ? "var(--neon-green)" : "var(--neon-purple)",
            }}>
            {testing ? <Loader2 className="w-3 h-3 animate-spin" /> : testPassed ? <CheckCircle2 className="w-3 h-3" /> : <Send className="w-3 h-3" />}
            {testing ? "Testing…" : testPassed ? "Test Passed" : "Test"}
          </Button>
          <Button size="sm" onClick={() => onSave(JSON.stringify(localCfg))} disabled={saving} className="h-7 text-xs"
            style={{ background: "transparent", border: "1px solid var(--border)", color: "var(--text-muted)" }}>
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : "Save"}
          </Button>
        </div>
        {!enabled && !testPassed && (
          <p className="text-xs" style={{ color: "var(--text-subtle)" }}>
            Click Test to verify and enable this channel.
          </p>
        )}
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Close-to-tray section
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// AppImage integration (Linux AppImage only)
// ---------------------------------------------------------------------------

function AppImageIntegrationSection() {
  const [status, setStatus]   = useState<{ isAppimage: boolean; isInstalled: boolean } | null>(null);
  const [working, setWorking] = useState(false);

  const refresh = useCallback(() => {
    tauriCmd.checkAppimageIntegration().then(setStatus).catch(() => {});
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  if (!status?.isAppimage) return null;

  const handleInstall = async () => {
    setWorking(true);
    try {
      await tauriCmd.installAppimageIntegration();
      refresh();
      toast.success("LokiASAM added to your application menu.", {
        description: "If it doesn't appear right away, log out and back in.",
        duration: 6000,
      });
    } catch (e) {
      toast.error("Installation failed", { description: String(e) });
    } finally {
      setWorking(false);
    }
  };

  const handleUninstall = async () => {
    setWorking(true);
    try {
      await tauriCmd.uninstallAppimageIntegration();
      refresh();
      toast.success("Removed from application menu.");
    } catch (e) {
      toast.error("Removal failed", { description: String(e) });
    } finally {
      setWorking(false);
    }
  };

  return (
    <Section
      icon={Layers}
      title="Application Menu Integration"
      description="Install LokiASAM into your desktop launcher."
    >
      <div className="space-y-4">
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          Adds LokiASAM to your desktop application launcher so you can find, launch, and pin it
          without navigating to the AppImage file each time. Writes a <code>.desktop</code> file and
          icon to <code>~/.local/share/</code> only — no files are placed outside that folder.
          Removing it restores the system to its original state.
        </p>
        {status.isInstalled ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <span className="text-sm flex items-center gap-2" style={{ color: "var(--neon-green)" }}>
                <CheckCircle2 className="w-4 h-4" />
                Installed in application menu
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={handleUninstall}
                disabled={working}
                className="gap-1.5"
                style={{ borderColor: "rgba(255,0,85,0.4)", color: "var(--neon-red)" }}
              >
                {working
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <StopCircle className="w-3.5 h-3.5" />}
                Remove from Menu
              </Button>
            </div>
            <p className="text-xs" style={{ color: "var(--text-subtle)" }}>
              If the icon doesn't appear in your launcher, log out and back in (or reboot).
            </p>
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
    </Section>
  );
}

function CloseToTraySection() {
  const [closeToTray, setCloseToTrayState] = useState(true);
  const { enabled: autostartEnabled, loading: autostartLoading, toggle: toggleAutostart } = useAutostart();

  useEffect(() => { getAppSetting("close_to_tray").then((v) => setCloseToTrayState(v !== "false")); }, []);

  const handleToggle = async (enabled: boolean) => {
    setCloseToTrayState(enabled);
    await setAppSetting("close_to_tray", String(enabled));
    tauriCmd.setCloseToTray(enabled).catch(() => {});
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-6">
        <div className="space-y-1.5 flex-1">
          <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>Minimize to Tray on Close</p>
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            When enabled, clicking the close button hides LokiASAM to the system tray instead of exiting. Servers and schedules continue running in the background. Click the tray icon to restore the window.
          </p>
          {!closeToTray && (
            <p className="text-xs mt-1" style={{ color: "#ffa500" }}>
              Closing the window will exit LokiASAM. Running servers will remain running but schedules and monitoring will stop.
            </p>
          )}
        </div>
        <SettingsToggle checked={closeToTray} onChange={handleToggle} />
      </div>

      <div className="flex items-start justify-between gap-6">
        <div className="space-y-1.5 flex-1">
          <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>Launch at Login</p>
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            Start LokiASAM automatically when your OS boots. Pairs well with &ldquo;Minimize to tray on close&rdquo; so the app runs quietly in the background.
          </p>
        </div>
        <button
          type="button"
          disabled={autostartLoading}
          onClick={() => toggleAutostart(!autostartEnabled)}
          aria-label={autostartEnabled ? "Disable launch at login" : "Enable launch at login"}
        >
          {autostartEnabled
            ? <ToggleRight className="w-8 h-8" style={{ color: "var(--neon-purple)" }} />
            : <ToggleLeft  className="w-8 h-8" style={{ color: "var(--text-subtle)" }} />}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Startup section
// ---------------------------------------------------------------------------

type AutoRestartPref = "ask" | "auto" | "never";

function StartupSection() {
  const [pref, setPref] = useState<AutoRestartPref>("ask");

  useEffect(() => {
    getAppSetting("auto_restart_downed").then((v) => {
      if (v === "auto" || v === "never") setPref(v);
      else setPref("ask");
    });
  }, []);

  const handleChange = async (v: AutoRestartPref) => {
    setPref(v);
    await setAppSetting("auto_restart_downed", v);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-6 flex-wrap">
        <div className="space-y-1.5 flex-1 min-w-0">
          <Label className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
            Relaunch Previously Running Servers
          </Label>
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            When the app starts, if servers were running during the last session but are now
            offline (e.g. after a power loss or system reboot), LokiASAM can prompt you to
            restart them, restart them automatically, or do nothing.
          </p>
          {pref === "never" && (
            <p className="text-xs mt-1" style={{ color: "#ffa500" }}>
              The restart prompt is suppressed. Change this setting back to{" "}
              <strong>Ask each time</strong> to re-enable it.
            </p>
          )}
        </div>
        <Select value={pref} onValueChange={(v) => handleChange(v as AutoRestartPref)}>
          <SelectTrigger
            className="w-44 shrink-0"
            style={{ borderColor: "var(--border)", background: "var(--surface)", color: "var(--text-primary)" }}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent style={{ background: "var(--popover)", borderColor: "rgba(var(--neon-purple-rgb),0.25)" }}>
            <SelectItem value="ask">Ask each time</SelectItem>
            <SelectItem value="auto">Auto-restart</SelectItem>
            <SelectItem value="never">Do nothing</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab navigation
// ---------------------------------------------------------------------------

const TABS = [
  { id: "general",       label: "General" },
  { id: "updates",       label: "Updates" },
  { id: "notifications", label: "Notifications" },
  { id: "about",         label: "About" },
] as const;

type TabId = typeof TABS[number]["id"];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function SettingsPage() {
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab") as TabId | null;
  const autoUpdateProton = searchParams.get("autoUpdateProton") === "1";

  const [activeTab, setActiveTab] = useState<TabId>(
    tabParam && TABS.some((t) => t.id === tabParam) ? tabParam : "general"
  );
  const [matrixRefreshKey, setMatrixRefreshKey] = useState(0);
  const [autoStartCache, setAutoStartCache] = useState(false);
  const scrollContainerRef  = useRef<HTMLDivElement>(null);
  const skipScrollToTopRef  = useRef(false);

  // Reset scroll position on tab change, unless the tab switch came from the
  // pre-download button (which scrolls to the cache row instead).
  useEffect(() => {
    if (skipScrollToTopRef.current) {
      skipScrollToTopRef.current = false;
      return;
    }
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = 0;
    }
  }, [activeTab]);

  return (
    <div className="h-full overflow-hidden flex flex-col gap-6">
      <div className="shrink-0">
        <div className="flex items-center gap-3">
          <Settings className="w-6 h-6 shrink-0" style={{ color: "var(--neon-purple)" }} />
          <h1 className="text-2xl font-bold" style={{ color: "var(--neon-purple)", textShadow: "var(--glow-purple)" }}>Settings</h1>
        </div>
        <p className="text-sm mt-1" style={{ color: "var(--text-muted)" }}>Global application configuration.</p>
      </div>

      {/* Tab bar */}
      <div
        className="flex gap-1 p-1 rounded-xl flex-wrap shrink-0"
        style={{ background: "rgba(0,0,0,0.4)", border: "1px solid rgba(var(--neon-purple-rgb),0.15)" }}
      >
        {TABS.map((tab) => {
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => { if (tab.id !== activeTab) setActiveTab(tab.id); }}
              className="px-3 py-1.5 text-sm rounded-lg transition-all cursor-pointer"
              style={{
                color: active ? "var(--neon-purple)" : "var(--text-muted)",
                background: active ? "rgba(var(--neon-purple-rgb),0.12)" : "transparent",
                border: active ? "1px solid rgba(var(--neon-purple-rgb),0.3)" : "1px solid transparent",
                fontWeight: active ? 600 : 400,
                textShadow: active ? "var(--glow-purple)" : "none",
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div ref={scrollContainerRef} className="flex-1 min-h-0 overflow-y-auto pr-6">
      {/* General tab */}
      {activeTab === "general" && (
        <div className="flex flex-col gap-6">
          <Section icon={Folder} title="Directories" description="File system paths for servers and backups.">
            <BaseDirMigrationSection />
            <Separator style={{ background: "var(--border)" }} />
            <PathField label="Backup Directory" settingKey="backup_dir" placeholder="/path/to/Backups"
              hint="Where scheduled and manual backup zips are stored." validateDir />
          </Section>

          <BackupSettingsSection />

          <Section icon={Terminal} title="Tools" description="Paths to SteamCMD and (on Linux) Proton-GE.">
            <AsaServerCacheRow autoStart={autoStartCache} onAutoStartConsumed={() => setAutoStartCache(false)} />
            <Separator style={{ background: "var(--border)" }} />
            <ToolPathField
              label="SteamCMD Path" settingKey="steamcmd_path" placeholder="/path/to/steamcmd"
              hint="Path to the steamcmd executable. Used for all server installs and updates."
              validateFn={(p) => tauriCmd.validateSteamcmd(p)}
              validLabel="SteamCMD is valid"
              onInstallOffer={async (typedPath) => {
                const isExe = /[/\\](steamcmd\.sh|steamcmd\.exe)$/i.test(typedPath);
                const targetDir = isExe ? typedPath.replace(/[/\\][^/\\]+$/, "") : typedPath;
                await tauriCmd.installSteamcmd(targetDir);
                const sep = targetDir.includes("\\") ? "\\" : "/";
                const exe = navigator.userAgent.includes("Windows") ? "steamcmd.exe" : "steamcmd.sh";
                return `${targetDir}${sep}${exe}`;
              }}
              installOfferTitle="SteamCMD Not Found"
              installOfferBody="No SteamCMD executable was found at this path. Would you like to install it here?"
            />
            <SteamcmdReinstallRow />
            {IS_LINUX && (
              <>
                <Separator style={{ background: "var(--border)" }} />
                <ToolPathField
                  label="Proton-GE Directory" settingKey="proton_path"
                  placeholder="/path/to/GE-Proton9-x"
                  hint="Proton-GE installation used to run the Windows ASA server binary on Linux."
                  pickDirectory validateFn={(p) => tauriCmd.validateProtonPath(p)}
                  validLabel="Proton-GE is valid"
                  onInstallOffer={async (targetDir) => {
                    const newPath = await tauriCmd.downloadProtonGe(targetDir);
                    await setAppSetting("proton_ge_managed", "true");
                    return newPath;
                  }}
                  installOfferTitle="Proton-GE Not Found"
                  installOfferBody="No Proton-GE installation was found at this path. Would you like to install it here?"
                />
                <ProtonGeInstallRow />
              </>
            )}
            <Separator style={{ background: "var(--border)" }} />
            <CertInstallRow />
            <Separator style={{ background: "var(--border)" }} />
            <FirewallRepairRow />
          </Section>

          <Section icon={Palette} title="Themes" description="Choose a background preset and accent color.">
            <ThemesSection />
          </Section>

          <Section icon={Monitor} title="System Tray" description="Control how LokiASAM behaves when minimized or closed.">
            <CloseToTraySection />
          </Section>

          <Section icon={Power} title="Startup" description="What to do when previously running servers are found offline on launch.">
            <StartupSection />
          </Section>

          {IS_LINUX && <AppImageIntegrationSection />}
        </div>
      )}

      {/* Updates tab */}
      {activeTab === "updates" && (
        <div className="flex flex-col gap-6">
          <Section icon={Server} title="ASA Server Updates" description="Check for ARK: Survival Ascended dedicated server updates via the Steam API.">
            <ServerUpdatesSection onPreDownload={() => { skipScrollToTopRef.current = true; setAutoStartCache(true); setActiveTab("general"); }} />
          </Section>
          <Section icon={Download} title="LokiASAM App Updates" description="Check for and install updates to LokiASAM itself.">
            <AppUpdateSection />
          </Section>
          {IS_LINUX && (
            <Section icon={Terminal} title="Proton-GE" description="Update the Proton-GE compatibility layer to the latest release.">
              <ProtonGeUpdateSection autoStart={autoUpdateProton} />
            </Section>
          )}
        </div>
      )}

      {/* Notifications tab */}
      {activeTab === "notifications" && (
        <div className="flex flex-col gap-6">
          <Section icon={Bell} title="Notification Channels" description="Configure Discord webhook and SMTP email credentials. Configuring a channel unlocks it in the event matrix below.">
            <GlobalNotificationsSection onCredentialSaved={() => setMatrixRefreshKey((k) => k + 1)} />
          </Section>
          <Section icon={Bell} title="Notification Events" description="Choose which events trigger each channel. Configure Discord and SMTP credentials above to unlock those columns.">
            <NotificationMatrix refreshKey={matrixRefreshKey} />
          </Section>
        </div>
      )}

      {/* About tab */}
      {activeTab === "about" && (
        <div className="flex justify-center py-4">
          <div className="w-full max-w-xl">
            <AboutSection />
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
