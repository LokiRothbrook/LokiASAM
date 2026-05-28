"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Folder, Terminal, Info,
  FolderOpen, CheckCircle2, AlertCircle, Loader2,
  Save, RefreshCw, ArrowUp, Bell, MessageSquare, Mail, Monitor, Send, Download,
  Server, Palette, Link, StopCircle,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { CommandOutputPanel } from "@/components/shared/CommandOutputPanel";
import {
  getAppSetting, setAppSetting,
  saveNotificationConfig, getNotificationConfigs,
  type NotificationConfigRow,
} from "@/lib/db";
import { check } from "@tauri-apps/plugin-updater";
import { getVersion } from "@tauri-apps/api/app";
import { tauriCmd, type DirCheckResult, type ProtonUpdateInfo, type MigrateProgress } from "@/lib/tauri-commands";
import { listen } from "@tauri-apps/api/event";
import {
  applyTheme, applyThemeAccent, applyThemePreset,
  ACCENT_OPTIONS, THEME_PRESETS,
  type ThemeAccent, type ThemePreset,
} from "@/lib/theme";
import { open } from "@tauri-apps/plugin-dialog";

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
          style={{ background: "rgba(5,5,20,0.8)", borderColor: "var(--border)", color: "var(--text-muted)", cursor: "default" }}
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
            <Switch checked={createBackup} onCheckedChange={setCreateBackup} />
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
            style={{ background: "rgba(191,0,255,0.15)", border: "1px solid rgba(191,0,255,0.4)", color: "var(--neon-purple)" }}>
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
    catch { setDirResult({ writable: false, freeBytes: 0, error: "Could not check directory." }); }
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
            background: dirty ? "rgba(191,0,255,0.15)" : "transparent",
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
}

function ToolPathField({
  label, settingKey, placeholder, hint,
  pickDirectory = false, validateFn,
  validLabel = "Valid", invalidLabel = "Validation failed — check the path.",
}: ToolPathFieldProps) {
  const [value, setValue] = useState("");
  const [original, setOriginal] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [valid, setValid] = useState<boolean | null>(null);

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
      } else {
        toast.error(invalidLabel);
      }
    } catch (e) {
      setValid(false);
      toast.error(`Verification failed: ${e}`);
    } finally {
      setVerifying(false);
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
            background: dirty ? "rgba(191,0,255,0.15)" : "transparent",
            border: `1px solid ${dirty ? "var(--neon-purple)" : "var(--border)"}`,
            color: dirty ? "var(--neon-purple)" : "var(--text-muted)",
          }}
        >
          {verifying ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
          Verify &amp; Save
        </Button>
      </div>
      {valid === true  && <p className="text-xs flex items-center gap-1.5" style={{ color: "var(--neon-green)" }}><CheckCircle2 className="w-3 h-3" /> {validLabel}</p>}
      {valid === false && !verifying && <p className="text-xs flex items-center gap-1.5" style={{ color: "var(--neon-red)" }}><AlertCircle className="w-3 h-3" /> {invalidLabel}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Themes section (replaces Appearance)
// ---------------------------------------------------------------------------

const PRESET_ORDER: ThemePreset[] = ["neon", "abyss", "toxic", "storm"];

function ThemesSection() {
  const [preset,    setPresetState]  = useState<ThemePreset>("neon");
  const [accent,    setAccentState]  = useState<ThemeAccent>("purple");
  const [savedPreset, setSavedPreset] = useState<ThemePreset>("neon");
  const [savedAccent, setSavedAccent] = useState<ThemeAccent>("purple");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([getAppSetting("theme_preset"), getAppSetting("theme_accent")]).then(([p, a]) => {
      const pr = (p as ThemePreset) ?? "neon";
      const ac = (a as ThemeAccent) ?? "purple";
      setPresetState(pr); setSavedPreset(pr);
      setAccentState(ac); setSavedAccent(ac);
    });
  }, []);

  const handlePreset = (p: ThemePreset) => {
    setPresetState(p);
    const defaultAccent = THEME_PRESETS[p].defaultAccent;
    setAccentState(defaultAccent);
    applyTheme(p, defaultAccent);
  };

  const handleAccent = (a: ThemeAccent) => {
    setAccentState(a);
    applyThemeAccent(a);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await setAppSetting("theme_preset", preset);
      await setAppSetting("theme_accent", accent);
      setSavedPreset(preset); setSavedAccent(accent);
      toast.success("Theme saved.");
    } catch { toast.error("Failed to save theme."); }
    finally { setSaving(false); }
  };

  const dirty = preset !== savedPreset || accent !== savedAccent;

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
                  background: isActive ? "rgba(191,0,255,0.12)" : info.surface,
                  border: `1px solid ${isActive ? "var(--neon-purple)" : "var(--border)"}`,
                  boxShadow: isActive ? "0 0 12px rgba(191,0,255,0.15)" : "none",
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

      <Button onClick={handleSave} disabled={saving || !dirty} size="sm" className="gap-1.5"
        style={{
          background: dirty ? "rgba(191,0,255,0.15)" : "transparent",
          border: `1px solid ${dirty ? "var(--neon-purple)" : "var(--border)"}`,
          color: dirty ? "var(--neon-purple)" : "var(--text-muted)",
        }}
      >
        {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
        Save Theme
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// About section
// ---------------------------------------------------------------------------

function AboutSection() {
  const [paths, setPaths] = useState({ baseDir: "", dbPath: "", cachePath: "" });
  const [appVersion, setAppVersion] = useState("…");

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion("0.9.1"));
    (async () => {
      const baseDir = (await getAppSetting("base_dir")) ?? "";
      if (!baseDir) return;
      const sep = baseDir.includes("\\") ? "\\" : "/";
      const base = baseDir.replace(/[/\\]$/, "");
      setPaths({ baseDir, dbPath: `${base}${sep}lokiasam${sep}lokiasam.db`, cachePath: `${base}${sep}lokiasam${sep}cache${sep}asa-server` });
    })();
  }, []);

  const bootstrapHint = IS_LINUX
    ? "~/.config/xyz.lokisoft.lokiasam/bootstrap.json"
    : "%APPDATA%\\xyz.lokisoft.lokiasam\\bootstrap.json";

  const rows = [
    { label: "Version",        value: appVersion },
    { label: "Base Directory", value: paths.baseDir   || "—" },
    { label: "Database",       value: paths.dbPath    || "—" },
    { label: "Server Cache",   value: paths.cachePath || "—" },
    { label: "Bootstrap",      value: bootstrapHint },
  ];

  return (
    <div className="space-y-3">
      {rows.map(({ label, value }, i) => (
        <div key={label}>
          {i > 0 && <Separator className="mb-3" style={{ background: "var(--border)" }} />}
          <div className="flex items-start justify-between gap-4 text-xs">
            <span className="shrink-0 w-32" style={{ color: "var(--text-muted)" }}>{label}</span>
            <span className="font-mono text-right break-all" style={{ color: "var(--text-primary)" }}>{value}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ASA Server Updates section
// ---------------------------------------------------------------------------

const AUTO_CHECK_OPTIONS = [
  { value: "0",  label: "Disabled" },
  { value: "1",  label: "Every hour" },
  { value: "6",  label: "Every 6 hours" },
  { value: "12", label: "Every 12 hours" },
  { value: "24", label: "Daily" },
];

function ServerUpdatesSection() {
  const [checking, setChecking]       = useState(false);
  const [updateAvailable, setUpdate]  = useState(false);
  const [cachedBuild, setCached]      = useState("");
  const [latestBuild, setLatest]      = useState("");
  const [lastChecked, setLastChecked] = useState("");
  const [autoCheckHours, setAutoCheck] = useState("0");
  const [autoSaved, setAutoSaved]     = useState(false);

  const load = useCallback(async () => {
    const [avail, cached, latest, checked, hours] = await Promise.all([
      getAppSetting("asa_update_available"),
      getAppSetting("asa_cached_build_id"),
      getAppSetting("asa_latest_build_id"),
      getAppSetting("asa_last_checked"),
      getAppSetting("asa_auto_check_hours"),
    ]);
    setUpdate(avail === "true"); setCached(cached ?? ""); setLatest(latest ?? "");
    setLastChecked(checked ?? ""); setAutoCheck(hours ?? "0");
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCheck = async () => {
    setChecking(true);
    try {
      const baseDir = await getAppSetting("base_dir");
      if (!baseDir) { toast.error("Base directory not configured."); return; }
      const sep = baseDir.includes("\\") ? "\\" : "/";
      const cacheDir = `${baseDir.replace(/[/\\]$/, "")}${sep}lokiasam${sep}cache${sep}asa-server`;
      const hasCacheDir = await tauriCmd.checkDir(cacheDir).then((r) => r.writable).catch(() => false);
      if (!hasCacheDir) {
        toast.info("No server cache yet — install a server first, then check for updates.");
        return;
      }
      const result = await tauriCmd.checkAsaUpdate(cacheDir);
      const now = new Date().toISOString();
      await setAppSetting("asa_update_available", String(result.updateAvailable));
      await setAppSetting("asa_cached_build_id",  result.cachedBuildId);
      await setAppSetting("asa_latest_build_id",  result.latestBuildId);
      await setAppSetting("asa_last_checked",     now);
      load();
      if (result.updateAvailable) {
        toast.info(`Update available — build ${result.latestBuildId} (cache is at ${result.cachedBuildId}).`);
      } else {
        toast.success("ASA server cache is up to date.");
      }
    } catch (e) {
      toast.error(`Update check failed: ${e}`);
    } finally {
      setChecking(false);
    }
  };

  const handleSaveAutoCheck = async () => {
    await setAppSetting("asa_auto_check_hours", autoCheckHours);
    setAutoSaved(true); setTimeout(() => setAutoSaved(false), 2000);
    toast.success("Auto-check interval saved.");
  };

  return (
    <div className="space-y-5">
      <p className="text-xs" style={{ color: "var(--text-muted)" }}>
        Compares the locally cached build ID against the latest build on Steam. Does not run SteamCMD or alter any files — apply updates per-server from the server Overview tab or via an Auto-Update schedule.
      </p>
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>Cache Build</span>
          <span className="font-mono text-sm" style={{ color: "var(--text-primary)" }}>{cachedBuild || "—"}</span>
        </div>
        {updateAvailable && latestBuild && (
          <>
            <div className="text-xs" style={{ color: "var(--text-muted)" }}>→</div>
            <div className="flex flex-col gap-0.5">
              <span className="text-xs" style={{ color: "var(--text-muted)" }}>Steam Build</span>
              <span className="font-mono text-sm" style={{ color: "#ffa500" }}>{latestBuild}</span>
            </div>
          </>
        )}
        <div className="flex flex-col gap-0.5">
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>Last Checked</span>
          <span className="text-sm" style={{ color: "var(--text-primary)" }}>{lastChecked ? new Date(lastChecked).toLocaleString() : "Never"}</span>
        </div>
        {updateAvailable && (
          <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium"
            style={{ background: "rgba(255,165,0,0.1)", border: "1px solid rgba(255,165,0,0.4)", color: "#ffa500" }}>
            <ArrowUp className="w-3 h-3" /> Update Available
          </span>
        )}
      </div>
      <Button onClick={handleCheck} disabled={checking} size="sm" className="gap-1.5"
        style={{ background: "rgba(191,0,255,0.15)", border: "1px solid rgba(191,0,255,0.4)", color: "var(--neon-purple)" }}>
        {checking ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
        Check for ASA Server Update
      </Button>
      <Separator style={{ background: "var(--border)" }} />
      <div className="space-y-2">
        <Label style={{ color: "var(--text-primary)" }}>Auto-Check Interval</Label>
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>Automatically check for ASA updates via the Rust scheduler (immune to tray throttling).</p>
        <div className="flex gap-2 flex-wrap">
          {AUTO_CHECK_OPTIONS.map((opt) => (
            <button key={opt.value} onClick={() => setAutoCheck(opt.value)} className="text-xs px-3 py-1.5 rounded-lg transition-all"
              style={{
                background: autoCheckHours === opt.value ? "rgba(191,0,255,0.15)" : "transparent",
                border: `1px solid ${autoCheckHours === opt.value ? "var(--neon-purple)" : "var(--border)"}`,
                color: autoCheckHours === opt.value ? "var(--neon-purple)" : "var(--text-muted)",
              }}>
              {opt.label}
            </button>
          ))}
        </div>
        <Button onClick={handleSaveAutoCheck} size="sm" className="gap-1.5"
          style={{
            background: autoSaved ? "rgba(0,255,136,0.15)" : "rgba(191,0,255,0.15)",
            border: `1px solid ${autoSaved ? "rgba(0,255,136,0.4)" : "rgba(191,0,255,0.4)"}`,
            color: autoSaved ? "var(--neon-green)" : "var(--neon-purple)",
          }}>
          {autoSaved ? <><CheckCircle2 className="w-3 h-3" /> Saved</> : <><Save className="w-3 h-3" /> Save</>}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LokiASAM App Updates section
// ---------------------------------------------------------------------------

const APP_UPDATE_MODE_OPTIONS = [
  { value: "startup",  label: "On startup only" },
  { value: "periodic", label: "Every hour" },
  { value: "off",      label: "Disabled" },
];

function AppUpdateSection() {
  const [mode, setMode]      = useState("startup");
  const [saved, setSaved]    = useState("startup");
  const [checking, setCheck] = useState(false);

  useEffect(() => {
    getAppSetting("app_update_check_mode").then((v) => { const m = v ?? "startup"; setMode(m); setSaved(m); });
  }, []);

  const handleSave = async () => {
    await setAppSetting("app_update_check_mode", mode); setSaved(mode);
    toast.success("Update check preference saved.");
  };

  const handleCheckNow = async () => {
    setCheck(true);
    try {
      const update = await check();
      if (!update) {
        toast.success("LokiASAM is up to date.");
      } else {
        const toastId = `app-update-${update.version}`;
        const firstLine = (update.body ?? "").split("\n").find((l) => l.trim()) ?? "";
        const description = firstLine.length > 120 ? firstLine.slice(0, 120) + "…" : firstLine || "A new version is ready to install.";
        toast.info(`LokiASAM ${update.version} is available`, {
          id: toastId, description, duration: Infinity,
          action: {
            label: "Download & Install",
            onClick: async () => {
              toast.dismiss(toastId);
              const loadingId = toast.loading("Downloading update…");
              try {
                await update.downloadAndInstall();
                toast.dismiss(loadingId);
                toast.success("Update installed. Restart LokiASAM to apply it.", { duration: Infinity });
              } catch (e) { toast.dismiss(loadingId); toast.error(`Update failed: ${e}`); }
            },
          },
          cancel: { label: "Later", onClick: () => {} },
        });
      }
    } catch (e) { toast.error(`Update check failed: ${e}`); }
    finally { setCheck(false); }
  };

  const dirty = mode !== saved;
  return (
    <div className="space-y-5">
      <p className="text-xs" style={{ color: "var(--text-muted)" }}>
        Automatic update checks for LokiASAM itself. When an update is found, a notification appears with a Download &amp; Install button.
      </p>
      <div className="space-y-2">
        <Label style={{ color: "var(--text-primary)" }}>Check Frequency</Label>
        <div className="flex gap-2 flex-wrap">
          {APP_UPDATE_MODE_OPTIONS.map((opt) => (
            <button key={opt.value} onClick={() => setMode(opt.value)} className="text-xs px-3 py-1.5 rounded-lg transition-all"
              style={{
                background: mode === opt.value ? "rgba(191,0,255,0.15)" : "transparent",
                border: `1px solid ${mode === opt.value ? "var(--neon-purple)" : "var(--border)"}`,
                color: mode === opt.value ? "var(--neon-purple)" : "var(--text-muted)",
              }}>
              {opt.label}
            </button>
          ))}
        </div>
        <Button onClick={handleSave} disabled={!dirty} size="sm" className="gap-1.5"
          style={{
            background: dirty ? "rgba(191,0,255,0.15)" : "transparent",
            border: `1px solid ${dirty ? "var(--neon-purple)" : "var(--border)"}`,
            color: dirty ? "var(--neon-purple)" : "var(--text-muted)",
          }}>
          <Save className="w-3 h-3" /> Save
        </Button>
      </div>
      <Separator style={{ background: "var(--border)" }} />
      <Button onClick={handleCheckNow} disabled={checking} size="sm" className="gap-1.5"
        style={{ background: "rgba(191,0,255,0.15)", border: "1px solid rgba(191,0,255,0.4)", color: "var(--neon-purple)" }}>
        {checking ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
        Check for LokiASAM Update
      </Button>
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
    const baseDir = await getAppSetting("base_dir");
    if (!baseDir) { toast.error("Base directory not configured."); return; }
    const sep = baseDir.includes("\\") ? "\\" : "/";
    const targetDir = `${baseDir.replace(/[/\\]$/, "")}${sep}steamcmd`;
    setReinstalling(true); setDone(false);
    try {
      await tauriCmd.installSteamcmd(targetDir);
      const newPath = targetDir + (navigator.userAgent.includes("Windows") ? "\\steamcmd.exe" : "/steamcmd.sh");
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
            background: done ? "rgba(0,255,136,0.1)" : "rgba(191,0,255,0.08)",
            border: `1px solid ${done ? "rgba(0,255,136,0.4)" : "rgba(191,0,255,0.3)"}`,
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
// Proton-GE Update section (Linux only)
// ---------------------------------------------------------------------------

function ProtonGeUpdateSection() {
  const [protonPath, setProtonPath]       = useState("");
  const [isManaged, setIsManaged]         = useState(false);
  const [checking, setChecking]           = useState(false);
  const [updateInfo, setUpdateInfo]       = useState<ProtonUpdateInfo | null>(null);
  const [downloading, setDownloading]     = useState(false);
  const [downloadDone, setDownloadDone]   = useState(false);
  const [autoCheck, setAutoCheck]         = useState(false);

  useEffect(() => {
    Promise.all([
      getAppSetting("proton_path"),
      getAppSetting("proton_ge_managed"),
      getAppSetting("proton_ge_auto_check"),
    ]).then(([p, managed, auto]) => {
      setProtonPath(p ?? "");
      setIsManaged(managed === "true");
      setAutoCheck(auto === "true");
    });
  }, []);

  const handleCheckUpdate = async () => {
    setChecking(true);
    setUpdateInfo(null);
    try {
      const info = await tauriCmd.checkProtonGeUpdate(protonPath);
      setUpdateInfo(info);
    } catch (e) { toast.error(`Failed to check for updates: ${e}`); }
    finally { setChecking(false); }
  };

  const handleDownload = async () => {
    const baseDir = await getAppSetting("base_dir");
    if (!baseDir) { toast.error("Base directory not configured."); return; }
    const sep = baseDir.includes("\\") ? "\\" : "/";
    const targetDir = `${baseDir.replace(/[/\\]$/, "")}${sep}proton`;
    setDownloading(true); setDownloadDone(false);
    try {
      const newPath = await tauriCmd.downloadProtonGe(targetDir);
      await setAppSetting("proton_path", newPath);
      await setAppSetting("proton_ge_managed", "true");
      setProtonPath(newPath);
      setIsManaged(true);
      setDownloadDone(true);
      setUpdateInfo(null);
      toast.success("Proton-GE updated successfully.");
    } catch (e) { toast.error(`Proton-GE update failed: ${e}`); }
    finally { setDownloading(false); }
  };

  const handleTakeOwnership = async () => {
    await setAppSetting("proton_ge_managed", "true");
    setIsManaged(true);
    toast.success("LokiASAM will now manage Proton-GE updates.");
  };

  const handleAutoCheckToggle = async (checked: boolean) => {
    setAutoCheck(checked);
    await setAppSetting("proton_ge_auto_check", checked ? "true" : "false");
  };

  // Determine if the current path is inside the managed location
  const managedPattern = /[/\\]proton[/\\]GE-Proton/;
  const looksExternal = protonPath && !managedPattern.test(protonPath);
  const currentVersion = protonPath
    ? protonPath.replace(/[/\\]$/, "").split(/[/\\]/).pop() ?? ""
    : "";

  return (
    <div className="space-y-4">
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

      {/* External path notice */}
      {looksExternal && !isManaged && (
        <div className="rounded-lg p-3 space-y-2" style={{ background: "rgba(255,136,0,0.08)", border: "1px solid rgba(255,136,0,0.25)" }}>
          <div className="flex items-start gap-2">
            <Link className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" style={{ color: "var(--neon-orange)" }} />
            <p className="text-xs" style={{ color: "var(--neon-orange)" }}>
              This Proton-GE path is outside LokiASAM's managed directory. Automatic updates are suppressed.
            </p>
          </div>
          <Button onClick={handleTakeOwnership} size="sm" className="gap-1.5 h-7 text-xs"
            style={{ background: "rgba(255,136,0,0.12)", border: "1px solid rgba(255,136,0,0.35)", color: "var(--neon-orange)" }}>
            Allow LokiASAM to Manage
          </Button>
        </div>
      )}

      {/* Update check result */}
      {updateInfo && !downloadDone && (
        <div className="rounded-lg p-3 space-y-2"
          style={{
            background: updateInfo.updateAvailable ? "rgba(191,0,255,0.08)" : "rgba(0,255,136,0.06)",
            border: `1px solid ${updateInfo.updateAvailable ? "rgba(191,0,255,0.3)" : "rgba(0,255,136,0.25)"}`,
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
        <Button onClick={handleCheckUpdate} disabled={checking || downloading} size="sm" className="gap-1.5"
          style={{ background: "rgba(0,255,255,0.08)", border: "1px solid rgba(0,255,255,0.3)", color: "var(--neon-cyan)" }}>
          {checking ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
          Check for Update
        </Button>

        {(updateInfo?.updateAvailable || (!protonPath && updateInfo)) && (isManaged || !looksExternal) && (
          <Button onClick={handleDownload} disabled={downloading || downloadDone} size="sm" className="gap-1.5"
            style={{
              background: downloadDone ? "rgba(0,255,136,0.15)" : "rgba(191,0,255,0.15)",
              border: `1px solid ${downloadDone ? "rgba(0,255,136,0.4)" : "rgba(191,0,255,0.4)"}`,
              color: downloadDone ? "var(--neon-green)" : "var(--neon-purple)",
            }}>
            {downloading ? <Loader2 className="w-3 h-3 animate-spin" /> : downloadDone ? <CheckCircle2 className="w-3 h-3" /> : <Download className="w-3 h-3" />}
            {downloadDone ? "Update Complete" : "Download & Install"}
          </Button>
        )}

        {downloading && (
          <Button onClick={() => tauriCmd.abortOperation("proton_download")} size="sm" variant="ghost" className="gap-1.5"
            style={{ color: "var(--neon-red)", border: "1px solid rgba(255,0,85,0.3)" }}>
            <StopCircle className="w-3 h-3" /> Abort
          </Button>
        )}
      </div>

      {/* Auto-check toggle */}
      <div className="flex items-center justify-between py-2">
        <div>
          <p className="text-sm" style={{ color: "var(--foreground)" }}>Daily Auto-Check</p>
          <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
            Automatically check GitHub for new GE-Proton releases once per day.
          </p>
        </div>
        <Switch checked={autoCheck} onCheckedChange={handleAutoCheckToggle} />
      </div>

      {/* Download output */}
      {(downloading || downloadDone) && (
        <CommandOutputPanel eventChannel="proton://output/download" label="Proton-GE Download" completed={downloadDone} bodyClassName="h-48" />
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

function GlobalNotificationsSection() {
  const [configs, setConfigs] = useState<NotificationConfigRow[]>([]);
  const [saving, setSaving]   = useState<string | null>(null);

  const loadConfigs = useCallback(async () => {
    try { setConfigs(await getNotificationConfigs(null)); } catch { /* ignore */ }
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
    } catch (e) { toast.error(`Failed to save: ${e}`); }
    finally { setSaving(null); }
  }

  async function handleTest(channelId: string) {
    const config = getConfig(channelId);
    const cfg = JSON.parse(config?.config_json ?? "{}") as Record<string, string | boolean | number>;
    try {
      if (channelId === "discord") {
        const url = cfg.webhookUrl as string | undefined;
        if (!url) { toast.error("Enter a webhook URL first."); return; }
        await tauriCmd.sendDiscordNotification(url, { title: "LokiASAM Test", description: "Discord notifications are working.", color: 0x00ff88, serverName: "Global", eventType: "test" });
      } else if (channelId === "email") {
        const to = cfg.toAddress as string | undefined;
        if (!to) { toast.error("Enter a To address first."); return; }
        await tauriCmd.sendEmailNotification(
          { host: (cfg.host as string) ?? "", port: Number(cfg.port ?? 587), username: (cfg.username as string) ?? "", password: (cfg.password as string) ?? "", fromAddress: (cfg.fromAddress as string) ?? "noreply@lokiasam", toAddress: to, useTls: Boolean(cfg.useTls ?? false) },
          { subject: "LokiASAM Test", body: "Email notifications are working." }
        );
      }
      toast.success("Test notification sent.");
    } catch (e) { toast.error(`Test failed: ${e}`); }
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
            onTest={() => handleTest(ch.id)}
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
  onTest: () => void;
}

function GlobalChannelCard({ channelId, icon: Icon, label, desc, fields, enabled, cfg, saving, onToggle, onSave, onTest }: GlobalChannelCardProps) {
  const [localCfg, setLocalCfg] = useState<Record<string, string>>(cfg);
  const [expanded, setExpanded] = useState(false);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setLocalCfg(cfg); }, [JSON.stringify(cfg)]);

  const isConfigured = Object.values(cfg).some((v) => v && v.trim());

  return (
    <div className="rounded-xl overflow-hidden" style={{ border: "1px solid var(--border)" }}>
      <div className="flex items-center gap-3 px-4 py-3">
        <Icon className="w-4 h-4 shrink-0" style={{ color: "var(--neon-purple)" }} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>{label}</p>
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>{desc}</p>
          {!isConfigured && (
            <p className="text-xs mt-0.5" style={{ color: "#ffa500" }}>Not configured — click Configure to set up.</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {enabled && isConfigured && (
            <Button variant="ghost" size="icon" className="w-7 h-7" onClick={onTest} title="Send test">
              <Send className="w-3.5 h-3.5" style={{ color: "var(--text-muted)" }} />
            </Button>
          )}
          <button onClick={() => setExpanded((v) => !v)} className="text-xs" style={{ color: "var(--neon-purple)" }}>
            {expanded ? "Hide" : "Configure"}
          </button>
          <Switch checked={enabled && isConfigured} onCheckedChange={(v) => { if (!isConfigured && v) { setExpanded(true); return; } onToggle(v); }} />
        </div>
      </div>
      {expanded && (
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
            <Button size="sm" onClick={() => onSave(JSON.stringify(localCfg))} disabled={saving}
              className="h-7 text-xs"
              style={{ background: "transparent", border: "1px solid var(--neon-purple)", color: "var(--neon-purple)" }}>
              {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : "Save"}
            </Button>
            <Button size="sm" onClick={onTest} className="h-7 text-xs gap-1"
              style={{ background: "transparent", border: "1px solid var(--border)", color: "var(--text-muted)" }}>
              <Send className="w-3 h-3" /> Test
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notification Events section
// ---------------------------------------------------------------------------

const NOTIFICATION_TOGGLES = [
  { key: "notify_server_start",    label: "Server Started",         desc: "Notify when a managed server successfully starts.",       defaultOn: true  },
  { key: "notify_server_crash",    label: "Server Crashed",         desc: "Notify when a server exits unexpectedly.",               defaultOn: true  },
  { key: "notify_server_stop",     label: "Server Stopped",         desc: "Notify when a server is manually stopped.",              defaultOn: false },
  { key: "notify_update_available",label: "ASA Update Available",   desc: "Notify when a new ASA server build is detected on Steam.", defaultOn: true },
];

function NotificationEventsSection() {
  const [desktopEnabled, setDesktopEnabled] = useState(true);
  const [values, setValues] = useState<Record<string, boolean>>({});

  useEffect(() => {
    getAppSetting("desktop_notifications_enabled").then((v) => setDesktopEnabled(v !== "false"));
    Promise.all(NOTIFICATION_TOGGLES.map((t) => getAppSetting(t.key))).then((results) => {
      const v: Record<string, boolean> = {};
      NOTIFICATION_TOGGLES.forEach((t, i) => { v[t.key] = results[i] !== null ? results[i] === "true" : t.defaultOn; });
      setValues(v);
    });
  }, []);

  const handleDesktopToggle = async (enabled: boolean) => {
    setDesktopEnabled(enabled);
    await setAppSetting("desktop_notifications_enabled", String(enabled));
  };

  const handleToggle = async (key: string, enabled: boolean) => {
    setValues((prev) => ({ ...prev, [key]: enabled }));
    await setAppSetting(key, String(enabled));
  };

  return (
    <div className="space-y-4">
      {/* Desktop notifications — separate from event list */}
      <div className="flex items-start justify-between gap-4 pb-4 border-b" style={{ borderColor: "var(--border)" }}>
        <div>
          <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>Desktop Notifications</p>
          <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
            Show OS system notifications for server events.
            <span className="block mt-0.5" style={{ color: "var(--text-subtle)" }}>
              In-app toast notifications always appear regardless of this setting.
            </span>
          </p>
        </div>
        <Switch checked={desktopEnabled} onCheckedChange={handleDesktopToggle} />
      </div>

      {/* Per-event toggles */}
      <div className="divide-y" style={{ borderColor: "var(--border)" }}>
        {NOTIFICATION_TOGGLES.map((t) => (
          <div key={t.key} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
            <div>
              <p className="text-sm" style={{ color: "var(--text-primary)" }}>{t.label}</p>
              <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>{t.desc}</p>
            </div>
            <Switch checked={values[t.key] ?? t.defaultOn} onCheckedChange={(v) => handleToggle(t.key, v)} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Close-to-tray section
// ---------------------------------------------------------------------------

function CloseToTraySection() {
  const [closeToTray, setCloseToTrayState] = useState(true);

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
        <Switch checked={closeToTray} onCheckedChange={handleToggle} />
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
  const [activeTab, setActiveTab] = useState<TabId>("general");

  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold" style={{ color: "var(--neon-purple)", textShadow: "var(--glow-purple)" }}>Settings</h1>
        <p className="text-sm mt-1" style={{ color: "var(--text-muted)" }}>Global application configuration.</p>
      </div>

      {/* Tab bar */}
      <div className="flex gap-0 border-b" style={{ borderColor: "var(--border)" }}>
        {TABS.map((tab) => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
            className="px-4 py-2.5 text-sm font-medium transition-colors relative"
            style={{
              color: activeTab === tab.id ? "var(--neon-purple)" : "var(--text-muted)",
              borderBottom: activeTab === tab.id ? "2px solid var(--neon-purple)" : "2px solid transparent",
              marginBottom: "-1px",
            }}>
            {tab.label}
          </button>
        ))}
      </div>

      {/* General tab */}
      {activeTab === "general" && (
        <div className="flex flex-col gap-6">
          <Section icon={Folder} title="Directories" description="File system paths for servers and backups.">
            <BaseDirMigrationSection />
            <Separator style={{ background: "var(--border)" }} />
            <PathField label="Backup Directory" settingKey="backup_dir" placeholder="/path/to/Backups"
              hint="Where scheduled and manual backup zips are stored." validateDir />
          </Section>

          <Section icon={Terminal} title="Tools" description="Paths to SteamCMD and (on Linux) Proton-GE.">
            <ToolPathField
              label="SteamCMD Path" settingKey="steamcmd_path" placeholder="/path/to/steamcmd"
              hint="Path to the steamcmd executable. Used for all server installs and updates."
              validateFn={(p) => tauriCmd.validateSteamcmd(p)}
              validLabel="SteamCMD is valid" invalidLabel="SteamCMD not found at this path — check the path."
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
                  validLabel="Proton-GE is valid" invalidLabel="Not a valid Proton-GE directory — check the path."
                />
              </>
            )}
          </Section>

          <Section icon={Palette} title="Themes" description="Choose a background preset and accent color.">
            <ThemesSection />
          </Section>

          <Section icon={Monitor} title="System Tray" description="Control how LokiASAM behaves when minimized or closed.">
            <CloseToTraySection />
          </Section>
        </div>
      )}

      {/* Updates tab */}
      {activeTab === "updates" && (
        <div className="flex flex-col gap-6">
          <Section icon={Server} title="ASA Server Updates" description="Check for ARK: Survival Ascended dedicated server updates via the Steam API.">
            <ServerUpdatesSection />
          </Section>
          <Section icon={Download} title="LokiASAM App Updates" description="Check for and install updates to LokiASAM itself.">
            <AppUpdateSection />
          </Section>
          {IS_LINUX && (
            <Section icon={Terminal} title="Proton-GE" description="Update the Proton-GE compatibility layer to the latest release.">
              <ProtonGeUpdateSection />
            </Section>
          )}
        </div>
      )}

      {/* Notifications tab */}
      {activeTab === "notifications" && (
        <div className="flex flex-col gap-6">
          <Section icon={Bell} title="Notification Channels" description="Default Discord and email channels for all server events.">
            <GlobalNotificationsSection />
          </Section>
          <Section icon={Bell} title="Notification Events" description="Choose which events trigger notifications across all channels.">
            <NotificationEventsSection />
          </Section>
        </div>
      )}

      {/* About tab */}
      {activeTab === "about" && (
        <div className="flex flex-col gap-6">
          <Section icon={Info} title="About" description="Application version and data paths.">
            <AboutSection />
          </Section>
        </div>
      )}
    </div>
  );
}
