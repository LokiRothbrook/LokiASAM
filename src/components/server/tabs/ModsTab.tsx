"use client";

import { useState, useEffect, useRef } from "react";
import {
  Package, Plus, Trash2, ChevronUp, ChevronDown, Globe,
  AlertCircle, RefreshCw, ToggleLeft, ToggleRight, Info,
  Loader2, XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  getServerMods,
  addServerMod,
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
  const [mods, setMods]       = useState<ModRow[]>([]);
  const [loading, setLoading] = useState(true);

  // Add-by-ID form state
  const [addInput, setAddInput]   = useState("");
  const [addError, setAddError]   = useState("");
  const [addLoading, setAddLoading] = useState(false);

  const addInputRef = useRef<HTMLInputElement>(null);

  const modBrowserOpen      = useAppStore((s) => s.modBrowserOpen);
  const setModBrowserOpen   = useAppStore((s) => s.setModBrowserOpen);
  const setModBrowserParams = useAppStore((s) => s.setModBrowserParams);
  const modBrowserJustClosed    = useAppStore((s) => s.modBrowserJustClosed);
  const setModBrowserJustClosed = useAppStore((s) => s.setModBrowserJustClosed);
  const modAddedCount = useAppStore((s) => s.modAddedCount);

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

  useEffect(() => { loadMods(); }, [server.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Real-time update: a mod was added via the browser window
  useEffect(() => {
    if (modAddedCount > 0) loadMods();
  }, [modAddedCount]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reload when the browser window is closed (safety net for any missed events)
  useEffect(() => {
    if (modBrowserJustClosed) {
      loadMods();
      setModBrowserJustClosed(false);
    }
  }, [modBrowserJustClosed]); // eslint-disable-line react-hooks/exhaustive-deps

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
        console.error("openModBrowser failed:", e);
        setModBrowserParams(null);
      }
    }
  };

  // ── Add mods by ID (comma-separated, verified) ─────────────────────────
  const handleAddFromForm = async () => {
    const raw = addInput.trim();
    if (!raw) { setAddError("Enter at least one mod ID."); return; }

    // Split on commas, strip whitespace, remove empty entries
    const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);

    // Check for non-numeric entries before making any network calls
    const invalid = ids.filter((id) => !/^\d+$/.test(id));
    if (invalid.length > 0) {
      setAddError(`Invalid ID${invalid.length > 1 ? "s" : ""}: ${invalid.join(", ")} — IDs must be numbers.`);
      return;
    }

    // Dedupe against already-added mods
    const duplicates = ids.filter((id) => mods.some((m) => m.mod_id === id));
    const toVerify   = ids.filter((id) => !mods.some((m) => m.mod_id === id));

    if (toVerify.length === 0) {
      setAddError("All entered IDs are already in the mod list.");
      return;
    }

    setAddError("");
    setAddLoading(true);

    try {
      const results = await tauriCmd.verifyMods(toVerify);

      const succeeded = results.filter((r) => r.verified);
      const failed    = results.filter((r) => !r.verified);

      // Add all verified mods to SQLite
      for (const r of succeeded) {
        try {
          await addServerMod(server.id, r.modId, r.name ?? `Mod ${r.modId}`);
        } catch (e) {
          console.error(`addServerMod(${r.modId}) failed:`, e);
        }
      }

      await loadMods();
      if (succeeded.length > 0) setAddInput("");

      // Build a summary of any problems
      const problems: string[] = [];
      if (duplicates.length > 0) {
        problems.push(`Already in list: ${duplicates.join(", ")}`);
      }
      if (failed.length > 0) {
        const lines = failed.map((r) => `${r.modId} — ${r.error ?? "unknown error"}`);
        toast.error(
          `${failed.length} mod${failed.length > 1 ? "s" : ""} could not be verified`,
          {
            description: lines.join("\n"),
            duration: 8000,
          },
        );
      }
      if (duplicates.length > 0) {
        toast.warning(`${duplicates.length} ID${duplicates.length > 1 ? "s were" : " was"} already in the list`, {
          description: duplicates.join(", "),
          duration: 5000,
        });
      }
      if (succeeded.length > 0 && failed.length === 0 && duplicates.length === 0) {
        toast.success(
          `Added ${succeeded.length} mod${succeeded.length > 1 ? "s" : ""}`,
          { duration: 3000 },
        );
      }
    } catch (e) {
      setAddError(String(e));
    } finally {
      setAddLoading(false);
    }
  };

  // ── Mod CRUD ──────────────────────────────────────────────────────────
  const handleRemoveMod = async (modId: string) => {
    try {
      await removeServerMod(server.id, modId);
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
              style={{ background: "rgba(0,0,0,0.4)", borderColor: "rgba(191,0,255,0.2)" }}
              disabled={addLoading}
            />
            <Button
              onClick={handleAddFromForm}
              disabled={addLoading || !addInput.trim()}
              className="shrink-0 btn-neon-purple"
              size="sm"
            >
              {addLoading ? (
                <Loader2 className="w-4 h-4 mr-1 animate-spin" />
              ) : (
                <Plus className="w-4 h-4 mr-1" />
              )}
              {addLoading ? "Verifying…" : "Add"}
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

        {/* Apply note */}
        <div
          className="flex items-start gap-2 rounded-xl px-3 py-2.5"
          style={{
            background: "rgba(0,255,255,0.04)",
            border: "1px solid rgba(0,255,255,0.12)",
          }}
        >
          <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: "var(--neon-cyan)" }} />
          <p className="text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
            Mod changes apply on the next server start or restart — no manual install needed.
            ARK: Survival Ascended downloads mods automatically.
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
            {modBrowserOpen && (
              <span
                className="ml-auto text-xs px-1.5 py-0.5 rounded-full"
                style={{
                  background: "rgba(191,0,255,0.15)",
                  color: "var(--neon-purple)",
                  border: "1px solid rgba(191,0,255,0.3)",
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
            <li>• Add mods by ID or via the browser</li>
            <li>• Reorder using ↑↓ — order matters for ASA</li>
            <li>• Toggle the switch to disable without removing</li>
            <li>• Mods apply automatically on next server start</li>
            <li>• ASA downloads mods itself — no manual install</li>
          </ul>
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
