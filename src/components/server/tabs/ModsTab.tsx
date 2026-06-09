"use client";

import { useState, useEffect, useRef } from "react";
import {
  Package, Plus, Trash2, ChevronUp, ChevronDown, Globe,
  AlertCircle, RefreshCw, ToggleLeft, ToggleRight, Info, HelpCircle, X,
  Loader2, XCircle, Lock,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  getServerMods,
  removeServerMod,
  toggleServerMod,
  reorderServerMods,
  type ModRow,
} from "@/lib/db";
import { tauriCmd } from "@/lib/tauri-commands";
import { useAppStore } from "@/store/useAppStore";
import type { ServerRow } from "@/lib/db";

interface Props {
  server: ServerRow;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ModsTab({ server }: Props) {
  const [mods, setMods]             = useState<ModRow[]>([]);
  const [loading, setLoading]       = useState(true);
  const [showRestartNote, setShowRestartNote] = useState(false);

  // Add-by-ID form state
  const [addInput, setAddInput] = useState("");
  const [addError, setAddError] = useState("");

  const markChanged = () => {
    if (server.status === "running") setShowRestartNote(true);
  };

  const addInputRef = useRef<HTMLInputElement>(null);
  const prevVerifyingRef = useRef(false);

  const modBrowserOpen      = useAppStore((s) => s.modBrowserOpen);
  const setModBrowserOpen   = useAppStore((s) => s.setModBrowserOpen);
  const setModBrowserParams = useAppStore((s) => s.setModBrowserParams);
  const modBrowserJustClosed    = useAppStore((s) => s.modBrowserJustClosed);
  const setModBrowserJustClosed = useAppStore((s) => s.setModBrowserJustClosed);
  const modAddedCount    = useAppStore((s) => s.modAddedCount);
  const verifying        = useAppStore((s) => s.verifying);
  const verifyTotal      = useAppStore((s) => s.verifyTotal);
  const verifyProgress   = useAppStore((s) => s.verifyProgress);
  const startVerifying   = useAppStore((s) => s.startVerifying);
  const stopVerifying    = useAppStore((s) => s.stopVerifying);

  // ── Load mods from SQLite ──────────────────────────────────────────────
  const loadMods = async () => {
    setLoading(true);
    try {
      const rows = await getServerMods(server.id);
      setMods(rows);
    } catch (e) {
      toast.error("Failed to load mods", { description: String(e) });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadMods(); }, [server.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Real-time update: a mod was added via the browser window
  useEffect(() => {
    if (modAddedCount > 0) { loadMods(); markChanged(); }
  }, [modAddedCount]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reload when the browser window is closed (safety net for any missed events)
  useEffect(() => {
    if (modBrowserJustClosed) {
      loadMods();
      setModBrowserJustClosed(false);
    }
  }, [modBrowserJustClosed]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear the add input when verification finishes
  useEffect(() => {
    if (prevVerifyingRef.current && !verifying) {
      setAddInput("");
    }
    prevVerifyingRef.current = verifying;
  }, [verifying]);

  // ── Mod browser open / close ───────────────────────────────────────────
  const handleToggleBrowser = async () => {
    if (modBrowserOpen) {
      try { await tauriCmd.closeModBrowser(); } catch { /* not in Tauri */ }
    } else {
      setModBrowserParams({
        serverId: server.id,
        serverName: server.name,
        addedModIds: mods.map((m) => m.mod_id),
      });
      try {
        await tauriCmd.openModBrowser(
          server.id,
          server.name,
          mods.map((m) => m.mod_id),
        );
        setModBrowserOpen(true);
      } catch (e) {
        toast.error("Failed to open mod browser", { description: String(e) });
        setModBrowserParams(null);
      }
    }
  };

  // ── Add mods by ID (comma-separated, verified via hidden WebviewWindow) ──
  const handleAddFromForm = async () => {
    const raw = addInput.trim();
    if (!raw) { setAddError("Enter at least one mod ID."); return; }

    const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);

    const invalid = ids.filter((id) => !/^\d+$/.test(id));
    if (invalid.length > 0) {
      setAddError(`Invalid ID${invalid.length > 1 ? "s" : ""}: ${invalid.join(", ")} — IDs must be numbers.`);
      return;
    }

    const duplicates = ids.filter((id) => mods.some((m) => m.mod_id === id));
    const toVerify   = ids.filter((id) => !mods.some((m) => m.mod_id === id));

    if (toVerify.length === 0) {
      setAddError("All entered IDs are already in the mod list.");
      return;
    }

    if (duplicates.length > 0) {
      toast.warning(
        `${duplicates.length} ID${duplicates.length > 1 ? "s were" : " was"} already in the list`,
        { description: duplicates.join(", "), duration: 5000 },
      );
    }

    setAddError("");
    startVerifying(toVerify.length);
    markChanged();

    try {
      await tauriCmd.startModVerification(
        toVerify,
        server.id,
        mods.map((m) => m.mod_id),
      );
      // Verification is now running in the hidden window.
      // Results arrive via ModBrowserEventHandler events; input cleared when verifying → false.
    } catch (e) {
      stopVerifying();
      setAddError(String(e));
    }
  };

  // ── Mod CRUD ──────────────────────────────────────────────────────────
  const handleRemoveMod = async (mod: ModRow) => {
    if (mod.locked_by_map) {
      toast.warning("Cannot remove map mod", {
        description: "This mod is required by the server's map. Change the map to remove it.",
      });
      return;
    }
    try {
      await removeServerMod(server.id, mod.mod_id);
      await loadMods();
      markChanged();
    } catch (e) {
      toast.error("Failed to remove mod", { description: String(e) });
    }
  };

  const handleToggleMod = async (modId: string, enabled: boolean) => {
    try {
      await toggleServerMod(server.id, modId, enabled);
      await loadMods();
      markChanged();
    } catch (e) {
      toast.error("Failed to toggle mod", { description: String(e) });
    }
  };

  const handleMoveUp = async (index: number) => {
    if (index === 0) return;
    const reordered = [...mods];
    [reordered[index - 1], reordered[index]] = [reordered[index], reordered[index - 1]];
    await reorderServerMods(server.id, reordered.map((m) => m.mod_id));
    await loadMods();
    markChanged();
  };

  const handleMoveDown = async (index: number) => {
    if (index === mods.length - 1) return;
    const reordered = [...mods];
    [reordered[index], reordered[index + 1]] = [reordered[index + 1], reordered[index]];
    await reorderServerMods(server.id, reordered.map((m) => m.mod_id));
    await loadMods();
    markChanged();
  };

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <div className="h-full flex flex-col gap-3">
      {/* ── Full-width dismissible restart note (only while server running) ── */}
      {showRestartNote && (
        <div
          className="flex items-start gap-2 rounded-xl px-3 py-2.5 shrink-0"
          style={{
            background: "rgba(var(--neon-purple-rgb),0.04)",
            border: "1px solid rgba(var(--neon-purple-rgb),0.12)",
          }}
        >
          <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: "var(--neon-purple)" }} />
          <p className="text-xs leading-relaxed flex-1" style={{ color: "var(--text-muted)" }}>
            Mod changes apply on the next server start or restart — no manual install needed.
            ARK: Survival Ascended downloads mods automatically.
          </p>
          <button
            onClick={() => setShowRestartNote(false)}
            className="shrink-0 mt-0.5 rounded p-0.5 transition-colors hover:bg-white/10"
            style={{ color: "var(--text-muted)" }}
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* ── Full-width header ─────────────────────────────────────────── */}
      <div className="flex items-center justify-between shrink-0">
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
      </div>

      {/* ── Two-column body ───────────────────────────────────────────── */}
      <div className="flex gap-4 flex-1 min-h-0">
      {/* ── Left column: mod list ─────────────────────────────────────── */}
      <div className="flex-1 flex flex-col gap-3 min-w-0 min-h-0">

        {/* Mod list */}
        <div
          className="glass-card flex-1 flex flex-col gap-1 rounded-xl p-2 overflow-y-auto min-h-0"
          style={{
            minHeight: 80,
            borderColor: "rgba(var(--neon-purple-rgb),0.15)",
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
                No mods installed. Add mod IDs below or open the browser.
              </p>
            </div>
          ) : (
            mods.map((mod, index) => (
              <ModRowItem
                key={mod.mod_id}
                mod={mod}
                index={index}
                total={mods.length}
                onMoveUp={() => handleMoveUp(index)}
                onMoveDown={() => handleMoveDown(index)}
                onToggle={(enabled) => handleToggleMod(mod.mod_id, enabled)}
                onRemove={() => handleRemoveMod(mod)}
              />
            ))
          )}
        </div>

        {/* Add-by-ID form */}
        <div
          className="glass-card flex flex-col gap-2 rounded-xl p-3 shrink-0"
          style={{ borderColor: "rgba(var(--neon-purple-rgb),0.12)" }}
        >
          <p className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>
            Add mods by ID
          </p>
          <div className="flex gap-2">
            <Input
              ref={addInputRef}
              value={addInput}
              onChange={(e) => { setAddInput(e.target.value); setAddError(""); }}
              onKeyDown={(e) => { if (e.key === "Enter") handleAddFromForm(); }}
              placeholder="e.g. 927090, 123456, 789012"
              className="flex-1 text-sm font-mono"
              style={{ background: "rgba(0,0,0,0.4)", borderColor: "rgba(var(--neon-purple-rgb),0.2)" }}
              disabled={verifying}
            />
            <Button
              onClick={handleAddFromForm}
              disabled={verifying || !addInput.trim()}
              className="shrink-0 btn-neon-purple"
              size="sm"
            >
              {verifying ? (
                <Loader2 className="w-4 h-4 mr-1 animate-spin" />
              ) : (
                <Plus className="w-4 h-4 mr-1" />
              )}
              {verifying
                ? verifyTotal > 0
                  ? `Verifying ${verifyProgress} / ${verifyTotal}…`
                  : "Verifying…"
                : "Add"}
            </Button>
          </div>
          {addError && (
            <p className="text-xs flex items-center gap-1" style={{ color: "var(--neon-red)" }}>
              <AlertCircle className="w-3 h-3 shrink-0" />
              {addError}
            </p>
          )}
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            Separate multiple IDs with commas. Each ID is verified against CurseForge before being added.
          </p>
        </div>

      </div>

      {/* ── Right column: browser panel ─────────────────────────────── */}
      <div
        className="flex flex-col gap-3 shrink-0"
        style={{ width: 260 }}
      >
        {/* Open / Close browser card */}
        <div
          className="glass-card flex flex-col gap-3 p-4 rounded-xl"
          style={{ borderColor: "rgba(var(--neon-purple-rgb),0.15)" }}
        >
          <div className="flex items-center gap-2">
            <Globe className="w-4 h-4 shrink-0" style={{ color: "var(--neon-purple)" }} />
            <span
              className="text-sm font-semibold"
              style={{ color: "var(--text-primary)" }}
            >
              Mod Browser
            </span>
            {modBrowserOpen && (
              <span
                className="ml-auto text-xs px-1.5 py-0.5 rounded-full"
                style={{
                  background: "rgba(var(--neon-purple-rgb),0.15)",
                  color: "var(--neon-purple)",
                  border: "1px solid rgba(var(--neon-purple-rgb),0.3)",
                }}
              >
                Open
              </span>
            )}
          </div>
          <p className="text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
            {modBrowserOpen ? (
              <>
                CurseForge is open in a separate window. Click{" "}
                <span style={{ color: "var(--neon-purple)" }}>+ Add Mod</span>{" "}
                on any mod page — it appears in your list instantly.
              </>
            ) : (
              <>
                Opens CurseForge in a separate window with a
                <span style={{ color: "var(--neon-purple)" }}> "+ Add Mod"</span>{" "}
                button on each mod page.
              </>
            )}
          </p>
          <Button
            onClick={handleToggleBrowser}
            className={`w-full ${modBrowserOpen ? "" : "btn-neon-purple"}`}
            variant={modBrowserOpen ? "outline" : "default"}
          >
            {modBrowserOpen ? (
              <>
                <XCircle className="w-4 h-4 mr-2" />
                Close Mod Browser
              </>
            ) : (
              <>
                <Globe className="w-4 h-4 mr-2" />
                Open Mod Browser
              </>
            )}
          </Button>
        </div>

        {/* Info card */}
        <div
          className="glass-card flex flex-col gap-2 p-4 rounded-xl"
          style={{ borderColor: "rgba(var(--neon-purple-rgb),0.1)" }}
        >
          <div className="flex items-center gap-1.5">
            <HelpCircle className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--neon-purple)" }} />
            <p
              className="text-xs font-semibold uppercase tracking-wide"
              style={{ color: "var(--text-primary)" }}
            >
              How mods work
            </p>
          </div>
          <ul
            className="text-xs leading-relaxed space-y-1.5"
            style={{ color: "var(--text-muted)" }}
          >
            <li>• Add mods by ID or via the browser</li>
            <li>• Reorder using ↑↓ — order matters for ASA</li>
            <li>• Toggle the switch to disable without removing</li>
            <li>• Mods apply automatically on next server start</li>
            <li>• ASA downloads mods itself — no manual install</li>
          </ul>
        </div>
      </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ModRowItem sub-component
// ---------------------------------------------------------------------------

interface ModRowItemProps {
  mod: ModRow;
  index: number;
  total: number;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onToggle: (enabled: boolean) => void;
  onRemove: () => void;
}

function ModRowItem({
  mod,
  index,
  total,
  onMoveUp,
  onMoveDown,
  onToggle,
  onRemove,
}: ModRowItemProps) {
  const enabled = mod.enabled === 1;
  const locked  = mod.locked_by_map === 1;

  return (
    <div
      className="flex items-center gap-2 px-2 py-2 rounded-lg group transition-all"
      style={{
        background: locked ? "rgba(var(--neon-purple-rgb),0.04)" : "rgba(10,10,30,0.4)",
        border: `1px solid ${locked ? "rgba(var(--neon-purple-rgb),0.18)" : "rgba(var(--neon-purple-rgb),0.08)"}`,
        opacity: enabled ? 1 : 0.55,
      }}
    >
      {/* Order index */}
      <span className="text-xs font-mono w-5 text-center shrink-0" style={{ color: "var(--text-muted)" }}>
        {index + 1}
      </span>

      {/* Up / Down — disabled for locked mods */}
      <div className="flex flex-col gap-0.5 shrink-0">
        <button type="button" onClick={onMoveUp} disabled={index === 0 || locked} className="p-0.5 rounded transition-colors disabled:opacity-20" style={{ color: "var(--text-muted)" }} title="Move up">
          <ChevronUp className="w-3 h-3" />
        </button>
        <button type="button" onClick={onMoveDown} disabled={index === total - 1 || locked} className="p-0.5 rounded transition-colors disabled:opacity-20" style={{ color: "var(--text-muted)" }} title="Move down">
          <ChevronDown className="w-3 h-3" />
        </button>
      </div>

      {/* Mod info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          {locked && (
            <span title="Required by map — cannot be removed">
              <Lock className="w-3 h-3 shrink-0" style={{ color: "var(--neon-cyan)" }} />
            </span>
          )}
          <span className="text-sm font-medium truncate" style={{ color: locked ? "var(--neon-cyan)" : "var(--text-primary)" }}>
            {mod.mod_name}
          </span>
          {locked && (
            <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "rgba(var(--neon-purple-rgb),0.1)", color: "var(--neon-cyan)", border: "1px solid rgba(var(--neon-purple-rgb),0.2)" }}>
              Map Mod
            </span>
          )}
        </div>
        <span className="text-xs font-mono" style={{ color: "var(--text-muted)" }}>{mod.mod_id}</span>
        {locked && (
          <p className="text-[10px] mt-0.5" style={{ color: "var(--text-subtle)" }}>Required by this server&apos;s map — change the map to remove.</p>
        )}
      </div>

      {/* Enable toggle — locked mods stay enabled */}
      <button
        type="button"
        onClick={() => !locked && onToggle(!enabled)}
        title={locked ? "Map mod — always loaded" : enabled ? "Disable mod" : "Enable mod"}
        className="shrink-0 transition-colors"
        style={{ color: locked ? "var(--neon-cyan)" : enabled ? "var(--neon-purple)" : "var(--text-muted)", cursor: locked ? "default" : "pointer" }}
      >
        {enabled ? <ToggleRight className="w-5 h-5" /> : <ToggleLeft className="w-5 h-5" />}
      </button>

      {/* Remove — hidden for locked mods, shown on hover for normal mods */}
      {locked ? (
        <span title="Cannot remove map mod">
          <Lock className="w-4 h-4 shrink-0" style={{ color: "var(--neon-cyan)", opacity: 0.5 }} />
        </span>
      ) : (
        <button
          type="button"
          onClick={onRemove}
          title="Remove mod"
          className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ color: "var(--neon-red)" }}
        >
          <Trash2 className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}
