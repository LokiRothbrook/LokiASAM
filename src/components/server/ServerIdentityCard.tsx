"use client";

/**
 * ServerIdentityCard — edit the settings that describe the server itself:
 * name, ports, passwords and max players. These live both in the servers DB
 * row (used by RCON, firewall rules, the launch command and the UI) and in
 * GameUserSettings.ini; saving here updates both in one step, so the two can
 * no longer drift apart.
 */

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { serverNotify } from "@/lib/notify";
import { IdCard, Eye, EyeOff, Save, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSavedFlash } from "@/hooks/useSavedFlash";
import {
  getServers, getAppSetting, getServerConfig, saveServerConfig, updateServerIdentity, isServerNameTaken,
  type ServerRow, type ServerIdentity,
} from "@/lib/db";
import { tauriCmd, type ServerConfigJson, type IniPatchOp, type PortDef } from "@/lib/tauri-commands";
import { applyIdentityToGus } from "@/lib/server-config";
import { GAME_SESSION_SECTION } from "@/lib/ini-utils";
import { getServerFirewallPorts } from "@/lib/firewall-utils";

function identityOf(server: ServerRow): ServerIdentity {
  return {
    name: server.name,
    port: server.port,
    queryPort: server.query_port,
    rconPort: server.rcon_port,
    maxPlayers: server.max_players,
    serverPassword: server.server_password ?? "",
    adminPassword: server.admin_password,
  };
}

/** In-place INI edits for the identity keys (nothing else in the files changes). */
function identityPatchOps(id: ServerIdentity): IniPatchOp[] {
  return [
    { file: "gus", section: "SessionSettings", key: "SessionName", value: id.name },
    { file: "gus", section: "ServerSettings", key: "ServerPassword", value: id.serverPassword ?? "" },
    { file: "gus", section: "SessionSettings", key: "ServerPassword", value: null },
    { file: "gus", section: "ServerSettings", key: "ServerAdminPassword", value: id.adminPassword },
    { file: "gus", section: "ServerSettings", key: "RCONPort", value: String(id.rconPort) },
    { file: "gus", section: GAME_SESSION_SECTION, key: "MaxPlayers", value: String(id.maxPlayers) },
  ];
}

export function ServerIdentityCard({
  server,
  onIdentitySaved,
}: {
  server: ServerRow;
  /** Called with the saved identity so the Config editor can mirror it without losing unsaved edits. */
  onIdentitySaved: (applyToGus: (cfg: ServerConfigJson) => ServerConfigJson) => void;
}) {
  const sn = serverNotify(server);
  const queryClient = useQueryClient();
  const [form, setForm] = useState<ServerIdentity>(() => identityOf(server));
  const [showPw, setShowPw] = useState(false);
  const [showAdminPw, setShowAdminPw] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, triggerSaved] = useSavedFlash();

  // Re-sync the form when the row changes underneath us (another save,
  // raw-editor sync) — but only while the user has nothing unsaved here.
  const rowKey = JSON.stringify(identityOf(server));
  const [prevRowKey, setPrevRowKey] = useState(rowKey);
  const original = identityOf(server);
  const dirty = JSON.stringify(form) !== JSON.stringify(original);
  if (rowKey !== prevRowKey) {
    setPrevRowKey(rowKey);
    if (!dirty) setForm(identityOf(server));
  }

  const stopped = server.status === "stopped";
  const portsChanged =
    form.port !== original.port || form.queryPort !== original.queryPort || form.rconPort !== original.rconPort;

  const set = <K extends keyof ServerIdentity>(k: K, v: ServerIdentity[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function validate(): Promise<string | null> {
    if (!form.name.trim()) return "Server name is required.";
    if (form.name.trim() !== server.name && await isServerNameTaken(form.name.trim())) {
      return `Another server is already named "${form.name.trim()}".`;
    }
    if (!form.adminPassword.trim()) return "Admin password is required — the app also uses it for RCON.";
    if (!Number.isInteger(form.maxPlayers) || form.maxPlayers < 1 || form.maxPlayers > 255) {
      return "Max players must be between 1 and 255.";
    }
    const ports = [form.port, form.queryPort, form.rconPort];
    if (ports.some((p) => !Number.isInteger(p) || p < 1024 || p > 65535)) return "Ports must be between 1024 and 65535.";
    if (new Set(ports).size !== 3) return "Game, query and RCON ports must all be different.";
    if (portsChanged) {
      const others = (await getServers()).filter((s) => s.id !== server.id);
      for (const p of ports) {
        const clash = others.find((s) => [s.port, s.query_port, s.rcon_port].includes(p));
        if (clash) return `Port ${p} is already used by "${clash.name}".`;
      }
      for (const p of ports.filter((p) => ![original.port, original.queryPort, original.rconPort].includes(p))) {
        const free = await tauriCmd.checkPortAvailable(p).catch(() => true);
        if (!free) return `Port ${p} is in use by another program on this machine.`;
      }
    }
    return null;
  }

  async function handleSave() {
    const problem = await validate();
    if (problem) { sn.error(problem, { event: "input_problem" }); return; }
    setSaving(true);
    const next: ServerIdentity = { ...form, name: form.name.trim(), adminPassword: form.adminPassword.trim() };
    try {
      // Snapshot the INI files first so this change shows up in Config History.
      const backupDir = await getAppSetting("backup_dir").catch(() => null);
      if (backupDir) await tauriCmd.createIniBackup(server.id, server.install_path, backupDir).catch(() => {});

      // Disk: patch only the identity keys. DB copy: same keys, rest untouched.
      await tauriCmd.patchServerIni(server.install_path, identityPatchOps(next));
      const row = await getServerConfig(server.id);
      const gus = JSON.parse(row?.game_user_settings_json || "{}");
      await saveServerConfig(
        server.id,
        JSON.stringify(applyIdentityToGus(gus, next)),
        row?.game_ini_json || "{}",
        row?.launch_args_json || "{}",
      );
      await updateServerIdentity(server.id, next);

      if (next.adminPassword !== original.adminPassword || next.rconPort !== original.rconPort) {
        tauriCmd.rconDisconnect(server.id).catch(() => {});
      }
      onIdentitySaved((cfg) => ({ ...cfg, gameUserSettings: applyIdentityToGus(cfg.gameUserSettings, next) }));
      queryClient.invalidateQueries({ queryKey: ["servers"] });
      triggerSaved();
      sn.success(stopped ? "Server identity saved." : "Server identity saved — takes effect on the next restart.");

      if (portsChanged) await offerFirewallUpdate({ ...server, port: next.port, query_port: next.queryPort, rcon_port: next.rconPort });
    } catch (e) {
      sn.error(`Failed to save server identity: ${e}`);
    } finally {
      setSaving(false);
    }
  }

  async function offerFirewallUpdate(updated: ServerRow) {
    const status = await tauriCmd.checkFirewallPorts(getServerFirewallPorts(updated)).catch(() => null);
    if (!status?.active) return;
    const missing = status.ports.filter((p) => !p.covered);
    if (missing.length === 0) return;
    sn.warning(`New ports aren't open in the firewall: ${missing.map((p) => `${p.port}/${p.protocol.toUpperCase()}`).join(", ")}`, {
      duration: Infinity,
      action: {
        label: "Open ports",
        onClick: async () => {
          try {
            // The firewall command takes the complete desired port set.
            const all = new Map<string, PortDef>();
            for (const s of await getServers()) {
              for (const p of getServerFirewallPorts(s)) all.set(`${p.port}/${p.protocol}`, p);
            }
            const protonPath = (await getAppSetting("proton_path")) ?? undefined;
            await tauriCmd.addFirewallRules([...all.values()], protonPath);
            sn.success("Firewall rules updated.");
          } catch (e) {
            sn.error(`Failed to update firewall: ${e}`);
          }
        },
      },
      cancel: { label: "Dismiss", onClick: () => {} },
    });
  }

  const inputStyle = { background: "var(--surface)", borderColor: "rgba(var(--neon-purple-rgb),0.25)", color: "var(--text-primary)" };
  const numField = (label: string, key: "port" | "queryPort" | "rconPort" | "maxPlayers", disabled = false) => (
    <div className="space-y-1">
      <Label className="text-xs" style={{ color: "var(--text-muted)" }}>{label}</Label>
      <Input
        type="number"
        value={Number.isNaN(form[key]) ? "" : form[key]}
        disabled={disabled}
        onChange={(e) => set(key, parseInt(e.target.value, 10))}
        className="h-8 text-sm font-mono"
        style={inputStyle}
      />
    </div>
  );

  return (
    <div id="settings-identity" data-tour="cfg-identity" className="glass-card rounded-xl p-4 space-y-4" style={{ border: "1px solid rgba(var(--neon-purple-rgb),0.2)" }}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <IdCard className="w-4 h-4 shrink-0" style={{ color: "var(--neon-purple)" }} />
          <div>
            <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Server Identity</p>
            <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
              Name, ports, passwords and player cap. Saved to both the app and GameUserSettings.ini.
            </p>
          </div>
        </div>
        <Button
          size="sm"
          className={saved ? "btn-neon-green" : "btn-neon-purple"}
          onClick={handleSave}
          disabled={saving || !dirty}
        >
          <Save className="w-3.5 h-3.5 mr-1.5" />
          {saving ? "Saving…" : saved ? "Saved!" : "Save Identity"}
        </Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1 sm:col-span-2">
          <Label className="text-xs" style={{ color: "var(--text-muted)" }}>Server name (shown in the server browser)</Label>
          <Input value={form.name} onChange={(e) => set("name", e.target.value)} className="h-8 text-sm" style={inputStyle} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs" style={{ color: "var(--text-muted)" }}>Join password (blank = public)</Label>
          <div className="relative">
            <Input
              type={showPw ? "text" : "password"}
              value={form.serverPassword ?? ""}
              onChange={(e) => set("serverPassword", e.target.value)}
              className="h-8 text-sm pr-8"
              style={inputStyle}
            />
            <button type="button" tabIndex={-1} onClick={() => setShowPw((v) => !v)}
              className="absolute inset-y-0 right-0 flex items-center pr-2.5 opacity-50 hover:opacity-90"
              style={{ color: "var(--text-primary)" }}>
              {showPw ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
        <div className="space-y-1">
          <Label className="text-xs" style={{ color: "var(--text-muted)" }}>Admin password (also used for RCON)</Label>
          <div className="relative">
            <Input
              type={showAdminPw ? "text" : "password"}
              value={form.adminPassword}
              onChange={(e) => set("adminPassword", e.target.value)}
              className="h-8 text-sm pr-8"
              style={inputStyle}
            />
            <button type="button" tabIndex={-1} onClick={() => setShowAdminPw((v) => !v)}
              className="absolute inset-y-0 right-0 flex items-center pr-2.5 opacity-50 hover:opacity-90"
              style={{ color: "var(--text-primary)" }}>
              {showAdminPw ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
        {numField("Max players", "maxPlayers")}
        <div />
        {numField("Game port (UDP)", "port", !stopped)}
        {numField("Query port (UDP)", "queryPort", !stopped)}
        {numField("RCON port (TCP)", "rconPort", !stopped)}
      </div>

      {!stopped && (
        <p className="text-xs flex items-center gap-1.5" style={{ color: "var(--text-muted)" }}>
          <Lock className="w-3 h-3 shrink-0" />
          Stop the server to change ports. Other changes apply on the next restart.
        </p>
      )}
    </div>
  );
}
