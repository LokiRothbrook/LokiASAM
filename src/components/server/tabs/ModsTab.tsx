"use client";

import { useState, useEffect, useRef } from "react";
import {
  Package, Plus, Trash2, ChevronUp, ChevronDown, Globe,
  AlertCircle, RefreshCw, ToggleLeft, ToggleRight, Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CommandOutputPanel } from "@/components/shared/CommandOutputPanel";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import {
  getServerMods,
  addServerMod,
  removeServerMod,
  toggleServerMod,
  reorderServerMods,
  getAppSetting,
  type ModRow,
} from "@/lib/db";
import { tauriCmd } from "@/lib/tauri-commands";
import type { ServerRow } from "@/lib/db";

interface Props {
  server: ServerRow;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ModsTab({ server }: Props) {
  const [mods, setMods] = useState<ModRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingModIds, setPendingModIds] = useState<Set<string>>(new Set());
  const [installing, setInstalling] = useState(false);
  const [installCompleted, setInstallCompleted] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);

  // Add-by-ID form state
  const [addModId, setAddModId] = useState("");
  const [addModName, setAddModName] = useState("");
  const [addError, setAddError] = useState("");
  const [addLoading, setAddLoading] = useState(false);

  const addInputRef = useRef<HTMLInputElement>(null);

  // ── Load mods from SQLite ──────────────────────────────────────────────
  const loadMods = async () => {
    setLoading(true);
    try {
      const rows = await getServerMods(server.id);
      setMods(rows);
    } catch (e) {
      console.error("Failed to load mods:", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadMods();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id]);

  // Close any open mod browser when this tab unmounts (e.g. server deleted / navigated away).
  useEffect(() => {
    return () => {
      tauriCmd.closeModBrowser().catch(() => {});
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Browser lifecycle events from the overlay script ──────────────────
  // "Close" button in overlay header → close the window via Rust command.
  useTauriEvent<unknown>("mod://close-browser", () => {
    tauriCmd.closeModBrowser().catch(console.error);
  });

  // "Pop Out" button in overlay header → reopen as decorated window at current URL.
  useTauriEvent<unknown>("mod://popout-browser", (raw) => {
    try {
      const data = (typeof raw === "string" ? JSON.parse(raw) : raw) as {
        serverId: string;
        currentUrl: string;
      };
      if (data.serverId !== server.id) return;
      tauriCmd.popoutModBrowser(server.id, server.name, data.currentUrl)
        .then(() => setBrowserOpen(true))
        .catch(console.error);
    } catch (e) {
      console.error("mod://popout-browser parse error:", e);
    }
  });

  // Fired by Rust when any mod browser window is closed.
  useTauriEvent<unknown>("mod://browser-closed", () => {
    setBrowserOpen(false);
    loadMods();
  });

  // ── Listen for mod://add-to-server events from the browser window ──────
  // The injected script emits JSON.stringify({ serverId, modId, modName }).
  // Tauri may deliver the payload as the object or as a JSON string — handle both.
  useTauriEvent<unknown>("mod://add-to-server", async (raw) => {
    try {
      const data = (typeof raw === "string" ? JSON.parse(raw) : raw) as {
        serverId: string;
        modId: string;
        modName: string;
      };
      if (data.serverId !== server.id) return;
      await handleAddMod(data.modId.trim(), data.modName.trim() || "Unknown Mod");
    } catch (e) {
      console.error("mod://add-to-server parse error:", e);
    }
  });

  // ── Mod CRUD ──────────────────────────────────────────────────────────
  const handleAddMod = async (modId: string, modName: string) => {
    if (!modId) return;
    const exists = mods.some((m) => m.mod_id === modId);
    if (exists) {
      setAddError(`Mod ${modId} is already in the list.`);
      return;
    }
    setAddLoading(true);
    setAddError("");
    try {
      await addServerMod(server.id, modId, modName || `Mod ${modId}`);
      setPendingModIds((prev) => new Set([...prev, modId]));
      setAddModId("");
      setAddModName("");
      await loadMods();
    } catch (e) {
      setAddError(String(e));
    } finally {
      setAddLoading(false);
    }
  };

  const handleAddFromForm = async () => {
    const id = addModId.trim();
    if (!id) { setAddError("Enter a mod ID."); return; }
    await handleAddMod(id, addModName.trim() || `Mod ${id}`);
  };

  const handleRemoveMod = async (modId: string) => {
    try {
      await removeServerMod(server.id, modId);
      setPendingModIds((prev) => {
        const next = new Set(prev);
        next.delete(modId);
        return next;
      });
      await loadMods();
    } catch (e) {
      console.error("Remove mod failed:", e);
    }
  };

  const handleToggleMod = async (modId: string, enabled: boolean) => {
    try {
      await toggleServerMod(server.id, modId, enabled);
      await loadMods();
    } catch (e) {
      console.error("Toggle mod failed:", e);
    }
  };

  const handleMoveUp = async (index: number) => {
    if (index === 0) return;
    const reordered = [...mods];
    [reordered[index - 1], reordered[index]] = [reordered[index], reordered[index - 1]];
    await reorderServerMods(server.id, reordered.map((m) => m.mod_id));
    await loadMods();
  };

  const handleMoveDown = async (index: number) => {
    if (index === mods.length - 1) return;
    const reordered = [...mods];
    [reordered[index], reordered[index + 1]] = [reordered[index + 1], reordered[index]];
    await reorderServerMods(server.id, reordered.map((m) => m.mod_id));
    await loadMods();
  };

  // ── Install (Apply Changes) ────────────────────────────────────────────
  const handleApplyChanges = async () => {
    setInstalling(true);
    setInstallCompleted(false);
    try {
      const [steamcmdPath, baseDir] = await Promise.all([
        getAppSetting("steamcmd_path"),
        getAppSetting("base_dir"),
      ]);
      if (!steamcmdPath || !baseDir) {
        throw new Error("Setup not complete. Run the setup wizard first.");
      }
      const enabledModIds = mods
        .filter((m) => m.enabled === 1)
        .map((m) => m.mod_id);
      await tauriCmd.installMods({
        serverId: server.id,
        steamcmdPath,
        baseDir,
        installPath: server.install_path,
        modIds: enabledModIds,
      });
      setPendingModIds(new Set());
      setInstallCompleted(true);
    } catch (e) {
      console.error("Install mods failed:", e);
    } finally {
      setInstalling(false);
    }
  };

  // ── Open mod browser window ─────────────────────────────────────────
  const handleOpenBrowser = async () => {
    try {
      await tauriCmd.openModBrowser(server.id, server.name);
      setBrowserOpen(true);
    } catch (e) {
      console.error("Open mod browser failed:", e);
    }
  };

  const hasPending = pendingModIds.size > 0;

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <div className="flex gap-4" style={{ minHeight: 520 }}>
      {/* ── Left column: mod list ─────────────────────────────────────── */}
      <div className="flex-1 flex flex-col gap-3 min-w-0">

        {/* Header */}
        <div className="flex items-center justify-between">
          <h2
            className="text-base font-semibold"
            style={{ color: "var(--text-primary)" }}
          >
            Installed Mods
            <span
              className="ml-2 text-sm font-normal"
              style={{ color: "var(--text-muted)" }}
            >
              ({mods.length})
            </span>
          </h2>
          {hasPending && (
            <span
              className="text-xs px-2 py-0.5 rounded-full font-medium"
              style={{
                background: "rgba(191,0,255,0.12)",
                border: "1px solid rgba(191,0,255,0.35)",
                color: "var(--neon-purple)",
              }}
            >
              {pendingModIds.size} pending install
            </span>
          )}
        </div>

        {/* Mod list */}
        <div
          className="glass-card flex-1 flex flex-col gap-1 rounded-xl p-2 overflow-y-auto"
          style={{
            minHeight: 220,
            maxHeight: 420,
            borderColor: "rgba(191,0,255,0.15)",
          }}
        >
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <RefreshCw
                className="w-5 h-5 animate-spin"
                style={{ color: "var(--text-muted)" }}
              />
            </div>
          ) : mods.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
              <Package className="w-8 h-8" style={{ color: "var(--text-muted)" }} />
              <p className="text-sm" style={{ color: "var(--text-muted)" }}>
                No mods installed. Add a mod ID below or open the browser.
              </p>
            </div>
          ) : (
            mods.map((mod, index) => (
              <ModRow
                key={mod.mod_id}
                mod={mod}
                index={index}
                total={mods.length}
                isPending={pendingModIds.has(mod.mod_id)}
                onMoveUp={() => handleMoveUp(index)}
                onMoveDown={() => handleMoveDown(index)}
                onToggle={(enabled) => handleToggleMod(mod.mod_id, enabled)}
                onRemove={() => handleRemoveMod(mod.mod_id)}
              />
            ))
          )}
        </div>

        {/* Add-by-ID form */}
        <div
          className="glass-card flex flex-col gap-2 rounded-xl p-3"
          style={{ borderColor: "rgba(191,0,255,0.12)" }}
        >
          <p className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>
            Add mod by ID
          </p>
          <div className="flex gap-2">
            <Input
              ref={addInputRef}
              value={addModId}
              onChange={(e) => { setAddModId(e.target.value); setAddError(""); }}
              onKeyDown={(e) => { if (e.key === "Enter") handleAddFromForm(); }}
              placeholder="Mod ID (e.g. 927090)"
              className="flex-1 text-sm font-mono"
              style={{ background: "rgba(0,0,0,0.4)", borderColor: "rgba(191,0,255,0.2)" }}
              disabled={addLoading}
            />
            <Input
              value={addModName}
              onChange={(e) => setAddModName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleAddFromForm(); }}
              placeholder="Name (optional)"
              className="flex-1 text-sm"
              style={{ background: "rgba(0,0,0,0.4)", borderColor: "rgba(191,0,255,0.2)" }}
              disabled={addLoading}
            />
            <Button
              onClick={handleAddFromForm}
              disabled={addLoading || !addModId.trim()}
              className="shrink-0 btn-neon-purple"
              size="sm"
            >
              <Plus className="w-4 h-4 mr-1" />
              Add
            </Button>
          </div>
          {addError && (
            <p className="text-xs flex items-center gap-1" style={{ color: "var(--neon-red)" }}>
              <AlertCircle className="w-3 h-3 shrink-0" />
              {addError}
            </p>
          )}
        </div>

        {/* Apply Changes button */}
        <Button
          onClick={handleApplyChanges}
          disabled={installing || mods.length === 0}
          className="w-full btn-neon-purple"
          style={
            hasPending
              ? { boxShadow: "0 0 16px rgba(191,0,255,0.4)" }
              : {}
          }
        >
          {installing ? (
            <>
              <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
              Installing mods…
            </>
          ) : (
            <>
              <Package className="w-4 h-4 mr-2" />
              {hasPending ? `Apply Changes (${pendingModIds.size} pending)` : "Re-install All Mods"}
            </>
          )}
        </Button>

        {/* Install output panel */}
        {(installing || installCompleted) && (
          <CommandOutputPanel
            eventChannel={`mods://progress/${server.id}`}
            label="Mod install output"
            completed={installCompleted}
            bodyClassName="h-40"
          />
        )}
      </div>

      {/* ── Right column: browser panel ─────────────────────────────── */}
      <div
        className="flex flex-col gap-3 shrink-0"
        style={{ width: 260 }}
      >
        {/* Open browser card */}
        <div
          className="glass-card flex flex-col gap-3 p-4 rounded-xl"
          style={{ borderColor: "rgba(191,0,255,0.15)" }}
        >
          <div className="flex items-center gap-2">
            <Globe className="w-4 h-4 shrink-0" style={{ color: "var(--neon-purple)" }} />
            <span
              className="text-sm font-semibold"
              style={{ color: "var(--text-primary)" }}
            >
              Mod Browser
            </span>
          </div>
          <p className="text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
            Opens CurseForge in a dedicated browser window with a neon
            <span style={{ color: "var(--neon-purple)" }}> "+ Add to {server.name}"</span>{" "}
            button injected on each mod page.
          </p>
          <Button
            onClick={handleOpenBrowser}
            className="w-full btn-neon-purple"
          >
            <Globe className="w-4 h-4 mr-2" />
            {browserOpen ? "Mod Browser Open" : "Open Mod Browser"}
          </Button>
        </div>

        {/* Info card */}
        <div
          className="glass-card flex flex-col gap-2 p-4 rounded-xl"
          style={{ borderColor: "rgba(0,255,255,0.1)" }}
        >
          <p
            className="text-xs font-semibold uppercase tracking-wide"
            style={{ color: "var(--neon-cyan)" }}
          >
            How mods work
          </p>
          <ul
            className="text-xs leading-relaxed space-y-1.5"
            style={{ color: "var(--text-muted)" }}
          >
            <li>• Add mods by ID or via the browser window</li>
            <li>• Reorder using ↑↓ arrows — order matters for ASA</li>
            <li>• Toggle the switch to disable a mod without removing it</li>
            <li>• Click <strong style={{ color: "var(--text-primary)" }}>Apply Changes</strong> to download &amp; install</li>
            <li>• The server must be restarted for mod changes to take effect</li>
          </ul>
        </div>

        {/* Search helper */}
        <div
          className="glass-card flex flex-col gap-2 p-4 rounded-xl"
          style={{ borderColor: "rgba(191,0,255,0.1)" }}
        >
          <div className="flex items-center gap-2">
            <Search className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--text-muted)" }} />
            <p className="text-xs font-semibold" style={{ color: "var(--text-muted)" }}>
              Finding mod IDs
            </p>
          </div>
          <p className="text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
            The mod ID is the numeric project ID shown on the CurseForge mod page (e.g.{" "}
            <span className="font-mono" style={{ color: "var(--text-primary)" }}>927090</span>).
            Open the browser above and click the purple button on any mod page to add it automatically.
          </p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ModRow sub-component
// ---------------------------------------------------------------------------

interface ModRowProps {
  mod: ModRow;
  index: number;
  total: number;
  isPending: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onToggle: (enabled: boolean) => void;
  onRemove: () => void;
}

function ModRow({
  mod,
  index,
  total,
  isPending,
  onMoveUp,
  onMoveDown,
  onToggle,
  onRemove,
}: ModRowProps) {
  const enabled = mod.enabled === 1;

  return (
    <div
      className="flex items-center gap-2 px-2 py-2 rounded-lg group transition-all"
      style={{
        background: "rgba(10,10,30,0.4)",
        border: "1px solid rgba(191,0,255,0.08)",
        opacity: enabled ? 1 : 0.55,
      }}
    >
      {/* Order index */}
      <span
        className="text-xs font-mono w-5 text-center shrink-0"
        style={{ color: "var(--text-muted)" }}
      >
        {index + 1}
      </span>

      {/* Up / Down */}
      <div className="flex flex-col gap-0.5 shrink-0">
        <button
          type="button"
          onClick={onMoveUp}
          disabled={index === 0}
          className="p-0.5 rounded transition-colors disabled:opacity-20"
          style={{ color: "var(--text-muted)" }}
          title="Move up"
        >
          <ChevronUp className="w-3 h-3" />
        </button>
        <button
          type="button"
          onClick={onMoveDown}
          disabled={index === total - 1}
          className="p-0.5 rounded transition-colors disabled:opacity-20"
          style={{ color: "var(--text-muted)" }}
          title="Move down"
        >
          <ChevronDown className="w-3 h-3" />
        </button>
      </div>

      {/* Mod info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span
            className="text-sm font-medium truncate"
            style={{ color: "var(--text-primary)" }}
          >
            {mod.mod_name}
          </span>
          {isPending && (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0"
              style={{
                background: "rgba(191,0,255,0.1)",
                border: "1px solid rgba(191,0,255,0.3)",
                color: "var(--neon-purple)",
              }}
            >
              pending
            </span>
          )}
        </div>
        <span
          className="text-xs font-mono"
          style={{ color: "var(--text-muted)" }}
        >
          {mod.mod_id}
        </span>
      </div>

      {/* Enable toggle */}
      <button
        type="button"
        onClick={() => onToggle(!enabled)}
        title={enabled ? "Disable mod" : "Enable mod"}
        className="shrink-0 transition-colors"
        style={{ color: enabled ? "var(--neon-purple)" : "var(--text-muted)" }}
      >
        {enabled ? (
          <ToggleRight className="w-5 h-5" />
        ) : (
          <ToggleLeft className="w-5 h-5" />
        )}
      </button>

      {/* Remove */}
      <button
        type="button"
        onClick={onRemove}
        title="Remove mod"
        className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
        style={{ color: "var(--neon-red)" }}
      >
        <Trash2 className="w-4 h-4" />
      </button>
    </div>
  );
}
