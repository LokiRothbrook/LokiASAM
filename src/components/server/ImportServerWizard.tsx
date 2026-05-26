"use client";

import { useState } from "react";
import {
  FolderOpen, Server, CheckCircle2, AlertCircle, Loader2,
  ArrowRight, X, Info,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { tauriCmd, type DetectedServerConfig } from "@/lib/tauri-commands";
import {
  createServer, saveServerConfig, getAppSetting, isServerNameTaken,
} from "@/lib/db";
import { ARK_MAPS } from "@/data/game-data";
import { open } from "@tauri-apps/plugin-dialog";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  onClose: () => void;
  onImported: () => void;
}

// ---------------------------------------------------------------------------
// Step 1: Pick folder
// ---------------------------------------------------------------------------

interface Step1Props {
  onDetected: (path: string, detected: DetectedServerConfig) => void;
}

function Step1({ onDetected }: Step1Props) {
  const [path, setPath]       = useState("");
  const [scanning, setScanning] = useState(false);
  const [error, setError]     = useState("");

  const handleBrowse = async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: "Select Server Installation Folder" });
      if (typeof selected === "string" && selected) setPath(selected);
    } catch { /* outside Tauri */ }
  };

  const handleScan = async () => {
    if (!path.trim()) return;
    setScanning(true);
    setError("");
    try {
      const detected = await tauriCmd.detectServerInstall(path.trim());
      if (!detected.exeFound) {
        setError("ArkAscendedServer.exe not found in that folder. Make sure to select the root server installation directory (the one containing the ShooterGame folder).");
        return;
      }
      onDetected(path.trim(), detected);
    } catch (e) {
      setError(`Scan failed: ${e}`);
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label style={{ color: "var(--text-primary)" }}>Server Installation Folder</Label>
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          Select the root folder of an existing ASA server installation (the folder containing ShooterGame/).
        </p>
        <div className="flex gap-2">
          <Input
            value={path}
            onChange={(e) => { setPath(e.target.value); setError(""); }}
            placeholder="/path/to/ArkServer"
            className="flex-1 font-mono text-sm"
            style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--text-primary)" }}
          />
          <Button
            variant="outline"
            size="icon"
            onClick={handleBrowse}
            style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
          >
            <FolderOpen className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {error && (
        <div
          className="flex items-start gap-2 p-3 rounded-lg text-sm"
          style={{ background: "rgba(255,0,85,0.06)", border: "1px solid rgba(255,0,85,0.2)", color: "var(--neon-red)" }}
        >
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      <Button
        onClick={handleScan}
        disabled={!path.trim() || scanning}
        className="gap-2"
        style={{ background: "rgba(191,0,255,0.15)", border: "1px solid rgba(191,0,255,0.4)", color: "var(--neon-purple)" }}
      >
        {scanning ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
        Scan Folder
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2: Fill in details
// ---------------------------------------------------------------------------

interface Step2Props {
  installPath: string;
  detected: DetectedServerConfig;
  onBack: () => void;
  onImported: () => void;
}

function Step2({ installPath, detected, onBack, onImported }: Step2Props) {
  const [name, setName]           = useState(detected.sessionName ?? "");
  const [mapId, setMapId]         = useState("theisland");
  const [port, setPort]           = useState(String(detected.port ?? 7777));
  const [queryPort, setQueryPort] = useState(String(detected.queryPort ?? 27015));
  const [rconPort, setRconPort]   = useState(String(detected.rconPort ?? 27020));
  const [adminPass, setAdminPass] = useState(detected.adminPassword ?? "");
  const [serverPass, setServerPass] = useState(detected.serverPassword ?? "");
  const [maxPlayers, setMaxPlayers] = useState(String(detected.maxPlayers ?? 70));
  const [saving, setSaving]       = useState(false);

  const handleImport = async () => {
    if (!name.trim()) { toast.error("Server name is required."); return; }
    if (await isServerNameTaken(name.trim())) { toast.error("A server with that name already exists."); return; }

    setSaving(true);
    try {
      const id = crypto.randomUUID();
      const rconPassword = crypto.randomUUID().slice(0, 12);

      await createServer({
        id,
        name: name.trim(),
        mapId,
        installPath,
        port: parseInt(port) || 7777,
        queryPort: parseInt(queryPort) || 27015,
        rconPort: parseInt(rconPort) || 27020,
        rconPassword,
        maxPlayers: parseInt(maxPlayers) || 70,
        serverPassword: serverPass.trim() || undefined,
        adminPassword: adminPass.trim(),
      });

      // Create a blank server_config row so tabs don't break.
      await saveServerConfig(id, "{}", "{}", "{}");

      toast.success(`"${name}" imported successfully.`);
      onImported();
    } catch (e) {
      toast.error(`Import failed: ${e}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Detection summary */}
      <div
        className="flex items-start gap-2.5 p-3 rounded-lg text-xs"
        style={{ background: "rgba(0,255,136,0.04)", border: "1px solid rgba(0,255,136,0.15)" }}
      >
        <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" style={{ color: "var(--neon-green)" }} />
        <div style={{ color: "var(--text-muted)" }}>
          <span style={{ color: "var(--neon-green)", fontWeight: 600 }}>Server executable found.</span>
          {detected.buildId && <span> Build ID: {detected.buildId}.</span>}
          {" "}Fields pre-filled from GameUserSettings.ini where available.
        </div>
      </div>

      {/* Form */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-1 sm:col-span-2">
          <Label style={{ color: "var(--text-primary)" }}>Server Name <span style={{ color: "var(--neon-red)" }}>*</span></Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Imported Server"
            style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--text-primary)" }}
          />
        </div>

        <div className="space-y-1 sm:col-span-2">
          <Label style={{ color: "var(--text-primary)" }}>Map</Label>
          <div className="flex flex-wrap gap-2">
            {ARK_MAPS.filter((m) => m.released).map((m) => (
              <button
                key={m.id}
                onClick={() => setMapId(m.id)}
                className="text-xs px-3 py-1.5 rounded-lg transition-all"
                style={{
                  background: mapId === m.id ? "rgba(191,0,255,0.15)" : "transparent",
                  border: `1px solid ${mapId === m.id ? "var(--neon-purple)" : "var(--border)"}`,
                  color: mapId === m.id ? "var(--neon-purple)" : "var(--text-muted)",
                }}
              >
                {m.displayName}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1">
          <Label style={{ color: "var(--text-primary)" }}>Game Port</Label>
          <Input type="number" value={port} onChange={(e) => setPort(e.target.value)}
            style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--text-primary)" }} />
        </div>
        <div className="space-y-1">
          <Label style={{ color: "var(--text-primary)" }}>Query Port</Label>
          <Input type="number" value={queryPort} onChange={(e) => setQueryPort(e.target.value)}
            style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--text-primary)" }} />
        </div>
        <div className="space-y-1">
          <Label style={{ color: "var(--text-primary)" }}>RCON Port</Label>
          <Input type="number" value={rconPort} onChange={(e) => setRconPort(e.target.value)}
            style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--text-primary)" }} />
        </div>
        <div className="space-y-1">
          <Label style={{ color: "var(--text-primary)" }}>Max Players</Label>
          <Input type="number" value={maxPlayers} onChange={(e) => setMaxPlayers(e.target.value)}
            style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--text-primary)" }} />
        </div>
        <div className="space-y-1">
          <Label style={{ color: "var(--text-primary)" }}>Admin Password</Label>
          <Input type="text" value={adminPass} onChange={(e) => setAdminPass(e.target.value)}
            placeholder="(from GameUserSettings.ini)"
            style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--text-primary)" }} />
        </div>
        <div className="space-y-1">
          <Label style={{ color: "var(--text-primary)" }}>Server Password <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>(optional)</span></Label>
          <Input type="text" value={serverPass} onChange={(e) => setServerPass(e.target.value)}
            placeholder="Leave blank for public"
            style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--text-primary)" }} />
        </div>
      </div>

      <div
        className="flex items-start gap-2 p-3 rounded-lg text-xs"
        style={{ background: "rgba(0,255,255,0.04)", border: "1px solid rgba(0,255,255,0.12)", color: "var(--text-muted)" }}
      >
        <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: "var(--neon-cyan)" }} />
        A new RCON password will be generated. Save data, configs, and mods are left untouched — only a database record is created.
      </div>

      <div className="flex gap-3">
        <Button variant="outline" onClick={onBack}
          style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}>
          Back
        </Button>
        <Button
          onClick={handleImport}
          disabled={saving || !name.trim()}
          className="gap-2"
          style={{ background: "rgba(0,255,136,0.15)", border: "1px solid rgba(0,255,136,0.4)", color: "var(--neon-green)" }}
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Server className="w-4 h-4" />}
          Import Server
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Wizard shell
// ---------------------------------------------------------------------------

export function ImportServerWizard({ onClose, onImported }: Props) {
  const [step, setStep]           = useState<1 | 2>(1);
  const [installPath, setInstallPath] = useState("");
  const [detected, setDetected]   = useState<DetectedServerConfig | null>(null);

  const handleDetected = (path: string, d: DetectedServerConfig) => {
    setInstallPath(path);
    setDetected(d);
    setStep(2);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div
        className="glass-card rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto"
        style={{ border: "1px solid rgba(191,0,255,0.3)" }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-6 py-4 border-b"
          style={{ borderColor: "rgba(191,0,255,0.15)" }}
        >
          <div className="flex items-center gap-3">
            <Server className="w-5 h-5" style={{ color: "var(--neon-purple)" }} />
            <div>
              <h2 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
                Import Existing Server
              </h2>
              <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
                Step {step} of 2 — {step === 1 ? "Select installation folder" : "Confirm details"}
              </p>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        {/* Step indicator */}
        <div className="flex px-6 pt-4 gap-2">
          {[1, 2].map((n) => (
            <div key={n} className="flex items-center gap-2">
              <div
                className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold"
                style={{
                  background: step >= n ? "rgba(191,0,255,0.2)" : "rgba(255,255,255,0.04)",
                  border: `1px solid ${step >= n ? "var(--neon-purple)" : "var(--border)"}`,
                  color: step >= n ? "var(--neon-purple)" : "var(--text-muted)",
                }}
              >
                {step > n ? <CheckCircle2 className="w-3.5 h-3.5" /> : n}
              </div>
              {n < 2 && (
                <div
                  className="h-px w-8"
                  style={{ background: step > n ? "var(--neon-purple)" : "var(--border)" }}
                />
              )}
            </div>
          ))}
        </div>

        {/* Body */}
        <div className="px-6 py-5">
          {step === 1 && <Step1 onDetected={handleDetected} />}
          {step === 2 && detected && (
            <Step2
              installPath={installPath}
              detected={detected}
              onBack={() => setStep(1)}
              onImported={onImported}
            />
          )}
        </div>
      </div>
    </div>
  );
}
