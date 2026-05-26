"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Folder, Terminal, Palette, Info,
  FolderOpen, CheckCircle2, AlertCircle, Loader2,
  Save, RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { getAppSetting, setAppSetting } from "@/lib/db";
import { tauriCmd, type DirCheckResult } from "@/lib/tauri-commands";
import { applyThemeAccent, type ThemeAccent } from "@/lib/theme";
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
    <div
      className="glass-card rounded-xl overflow-hidden"
      style={{ border: "1px solid var(--border)" }}
    >
      <div
        className="px-6 py-4 flex items-center gap-3 border-b"
        style={{ borderColor: "var(--border)" }}
      >
        <Icon className="w-4 h-4 shrink-0" style={{ color: "var(--neon-purple)" }} />
        <div>
          <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            {title}
          </h2>
          <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
            {description}
          </p>
        </div>
      </div>
      <div className="p-6 space-y-6">{children}</div>
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
  readOnly?: boolean;
  pickDirectory?: boolean;
  validateDir?: boolean;
  validateSteamcmd?: boolean;
}

function PathField({
  label,
  settingKey,
  placeholder,
  hint,
  readOnly = false,
  pickDirectory = true,
  validateDir = false,
  validateSteamcmd = false,
}: PathFieldProps) {
  const [value, setValue] = useState("");
  const [original, setOriginal] = useState("");
  const [dirResult, setDirResult] = useState<DirCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [scmdValid, setScmdValid] = useState<boolean | null>(null);

  useEffect(() => {
    getAppSetting(settingKey).then((v) => {
      const val = v ?? "";
      setValue(val);
      setOriginal(val);
    });
  }, [settingKey]);

  const checkDir = useCallback(async (path: string) => {
    if (!path.trim() || !validateDir) return;
    setChecking(true);
    setDirResult(null);
    try {
      const r = await tauriCmd.checkDir(path);
      setDirResult(r);
    } catch {
      setDirResult({ writable: false, freeBytes: 0, error: "Could not check directory." });
    } finally {
      setChecking(false);
    }
  }, [validateDir]);

  const handleBrowse = async () => {
    try {
      const selected = await open({
        directory: pickDirectory,
        multiple: false,
        title: `Select ${label}`,
      });
      if (typeof selected === "string" && selected) {
        setValue(selected);
        if (validateDir) checkDir(selected);
      }
    } catch {/* outside Tauri */}
  };

  const handleValidateSteamcmd = async () => {
    if (!value.trim()) return;
    setValidating(true);
    setScmdValid(null);
    try {
      const ok = await tauriCmd.validateSteamcmd(value.trim());
      setScmdValid(ok);
      if (!ok) toast.error("SteamCMD validation failed — check the path.");
    } catch {
      setScmdValid(false);
    } finally {
      setValidating(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await setAppSetting(settingKey, value.trim());
      setOriginal(value.trim());
      toast.success(`${label} saved.`);
    } catch {
      toast.error(`Failed to save ${label}.`);
    } finally {
      setSaving(false);
    }
  };

  const dirty = value !== original;

  return (
    <div className="space-y-2">
      <Label style={{ color: "var(--text-primary)" }}>{label}</Label>
      {hint && (
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>{hint}</p>
      )}
      <div className="flex gap-2">
        <Input
          value={value}
          onChange={(e) => { setValue(e.target.value); setDirResult(null); setScmdValid(null); }}
          onBlur={() => validateDir && checkDir(value)}
          placeholder={placeholder}
          readOnly={readOnly}
          className="flex-1 font-mono text-sm"
          style={{
            background: readOnly ? "rgba(5,5,20,0.8)" : "var(--surface)",
            borderColor: "var(--border)",
            color: readOnly ? "var(--text-muted)" : "var(--text-primary)",
            cursor: readOnly ? "default" : undefined,
          }}
        />
        {!readOnly && (
          <Button
            onClick={handleBrowse}
            variant="outline"
            size="icon"
            className="shrink-0"
            style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
          >
            <FolderOpen className="w-4 h-4" />
          </Button>
        )}
        {validateSteamcmd && !readOnly && (
          <Button
            onClick={handleValidateSteamcmd}
            disabled={validating || !value.trim()}
            variant="outline"
            size="sm"
            className="shrink-0"
            style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
            title="Validate SteamCMD"
          >
            {validating ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
          </Button>
        )}
        {!readOnly && (
          <Button
            onClick={handleSave}
            disabled={saving || !dirty}
            size="sm"
            className="shrink-0 gap-1"
            style={{
              background: dirty ? "rgba(191,0,255,0.15)" : "transparent",
              border: `1px solid ${dirty ? "var(--neon-purple)" : "var(--border)"}`,
              color: dirty ? "var(--neon-purple)" : "var(--text-muted)",
            }}
          >
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
            Save
          </Button>
        )}
      </div>

      {checking && (
        <p className="text-xs flex items-center gap-1.5" style={{ color: "var(--text-muted)" }}>
          <Loader2 className="w-3 h-3 animate-spin" /> Checking…
        </p>
      )}
      {dirResult && (
        <div className="space-y-0.5">
          {dirResult.writable ? (
            <p className="text-xs flex items-center gap-1.5" style={{ color: "var(--neon-green)" }}>
              <CheckCircle2 className="w-3 h-3" /> Writable
              {dirResult.freeBytes > 0 && ` · ${formatBytes(dirResult.freeBytes)} free`}
            </p>
          ) : (
            <p className="text-xs flex items-center gap-1.5" style={{ color: "var(--neon-red)" }}>
              <AlertCircle className="w-3 h-3" /> {dirResult.error ?? "Not writable"}
            </p>
          )}
        </div>
      )}
      {scmdValid === true && (
        <p className="text-xs flex items-center gap-1.5" style={{ color: "var(--neon-green)" }}>
          <CheckCircle2 className="w-3 h-3" /> SteamCMD is valid
        </p>
      )}
      {scmdValid === false && !validating && (
        <p className="text-xs flex items-center gap-1.5" style={{ color: "var(--neon-red)" }}>
          <AlertCircle className="w-3 h-3" /> SteamCMD not found at this path
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Appearance section
// ---------------------------------------------------------------------------

const ACCENT_OPTIONS: { value: ThemeAccent; label: string; hex: string }[] = [
  { value: "purple", label: "Purple", hex: "#bf00ff" },
  { value: "cyan",   label: "Cyan",   hex: "#00ffff" },
  { value: "green",  label: "Green",  hex: "#00ff88" },
];

function AppearanceSection() {
  const [accent, setAccent] = useState<ThemeAccent>("purple");
  const [saved, setSaved] = useState<ThemeAccent>("purple");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getAppSetting("theme_accent").then((v) => {
      const a = (v as ThemeAccent) ?? "purple";
      setAccent(a);
      setSaved(a);
    });
  }, []);

  const handleSelect = (a: ThemeAccent) => {
    setAccent(a);
    applyThemeAccent(a);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await setAppSetting("theme_accent", accent);
      setSaved(accent);
      toast.success("Theme saved.");
    } catch {
      toast.error("Failed to save theme.");
    } finally {
      setSaving(false);
    }
  };

  const dirty = accent !== saved;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label style={{ color: "var(--text-primary)" }}>Accent Color</Label>
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          Remaps the primary interface accent to your chosen color. The preview is live — save to persist on restart.
        </p>
      </div>
      <div className="flex gap-3">
        {ACCENT_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => handleSelect(opt.value)}
            className="flex flex-col items-center gap-2 rounded-xl px-6 py-4 transition-all"
            style={{
              background: accent === opt.value ? `${opt.hex}18` : "var(--surface)",
              border: `1px solid ${accent === opt.value ? opt.hex : "var(--border)"}`,
              boxShadow: accent === opt.value ? `0 0 16px ${opt.hex}33` : "none",
            }}
          >
            <span
              className="w-6 h-6 rounded-full"
              style={{
                background: opt.hex,
                boxShadow: accent === opt.value ? `0 0 10px ${opt.hex}` : "none",
              }}
            />
            <span
              className="text-xs font-semibold"
              style={{ color: accent === opt.value ? opt.hex : "var(--text-muted)" }}
            >
              {opt.label}
            </span>
          </button>
        ))}
      </div>
      <Button
        onClick={handleSave}
        disabled={saving || !dirty}
        size="sm"
        className="gap-1.5"
        style={{
          background: dirty ? "rgba(191,0,255,0.15)" : "transparent",
          border: `1px solid ${dirty ? "var(--neon-purple)" : "var(--border)"}`,
          color: dirty ? "var(--neon-purple)" : "var(--text-muted)",
        }}
      >
        {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
        Save Appearance
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// About section
// ---------------------------------------------------------------------------

function AboutSection() {
  const [paths, setPaths] = useState({
    baseDir: "",
    dbPath: "",
    cachePath: "",
  });

  useEffect(() => {
    (async () => {
      const baseDir = (await getAppSetting("base_dir")) ?? "";
      if (!baseDir) return;
      const sep = baseDir.includes("\\") ? "\\" : "/";
      const base = baseDir.replace(/[/\\]$/, "");
      setPaths({
        baseDir,
        dbPath:    `${base}${sep}lokiasam${sep}lokiasam.db`,
        cachePath: `${base}${sep}lokiasam${sep}cache${sep}asa-server`,
      });
    })();
  }, []);

  const bootstrapHint = IS_LINUX
    ? "~/.local/share/lokiasam/bootstrap.json"
    : "%APPDATA%\\lokiasam\\bootstrap.json";

  const rows = [
    { label: "Version",        value: "0.1.0" },
    { label: "Base Directory", value: paths.baseDir  || "—" },
    { label: "Database",       value: paths.dbPath   || "—" },
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
            <span className="font-mono text-right break-all" style={{ color: "var(--text-primary)" }}>
              {value}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function SettingsPage() {
  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      <div>
        <h1
          className="text-2xl font-bold"
          style={{ color: "var(--neon-purple)", textShadow: "var(--glow-purple)" }}
        >
          Settings
        </h1>
        <p className="text-sm mt-1" style={{ color: "var(--text-muted)" }}>
          Global application configuration.
        </p>
      </div>

      <Section icon={Folder} title="Directories" description="File system paths for servers, backups, and tools.">
        <PathField
          label="Base Directory"
          settingKey="base_dir"
          placeholder="/path/to/ArkServers"
          hint="Root folder for all server installs. To change, re-run the setup wizard."
          readOnly
        />
        <Separator style={{ background: "var(--border)" }} />
        <PathField
          label="Backup Directory"
          settingKey="backup_dir"
          placeholder="/path/to/Backups"
          hint="Where scheduled and manual backup zips are stored."
          validateDir
        />
      </Section>

      <Section icon={Terminal} title="Tools" description="Paths to SteamCMD and (on Linux) Proton-GE.">
        <PathField
          label="SteamCMD Path"
          settingKey="steamcmd_path"
          placeholder="/path/to/steamcmd"
          hint="Path to the steamcmd executable. Used for all server installs and updates."
          pickDirectory={false}
          validateSteamcmd
        />
        {IS_LINUX && (
          <>
            <Separator style={{ background: "var(--border)" }} />
            <PathField
              label="Proton-GE Directory"
              settingKey="proton_path"
              placeholder="/path/to/GE-Proton9-x"
              hint="Proton-GE installation used to run the Windows ASA server binary on Linux."
            />
          </>
        )}
      </Section>

      <Section icon={Palette} title="Appearance" description="Customize the interface accent color.">
        <AppearanceSection />
      </Section>

      <Section icon={Info} title="About" description="Application version and data paths.">
        <AboutSection />
      </Section>
    </div>
  );
}
