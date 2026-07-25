"use client";

import React, { useState, useCallback } from "react";
import { useOnMount } from "@/hooks/useOnMount";
import { Map, Plus, Trash2, Loader2, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { getCustomMaps, insertCustomMap, updateCustomMap, deleteCustomMap, type CustomMapRow } from "@/lib/db";
import { ARK_MAPS } from "@/data/game-data";

const TH = ({ children }: { children: React.ReactNode }) => (
  <th className="px-4 py-2 text-left text-xs font-medium" style={{ color: "var(--text-muted)" }}>
    {children}
  </th>
);

export default function ModMapsPage() {
  const [customMaps, setCustomMaps]   = useState<CustomMapRow[]>([]);
  const [loading, setLoading]         = useState(true);
  const [showAdd, setShowAdd]         = useState(false);
  const [editTarget, setEditTarget]   = useState<CustomMapRow | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [modId, setModId]             = useState("");
  const [mapPath, setMapPath]         = useState("");
  const [saving, setSaving]           = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setCustomMaps(await getCustomMaps());
    } catch (e) {
      toast.error(`Failed to load custom maps: ${e}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useOnMount(load);

  const closeDialog = () => {
    if (saving) return;
    setShowAdd(false);
    setEditTarget(null);
    setDisplayName(""); setModId(""); setMapPath("");
  };

  const openEdit = (map: CustomMapRow) => {
    setEditTarget(map);
    setDisplayName(map.display_name);
    setModId(map.mod_id);
    setMapPath(map.map_path);
  };

  const handleSave = async () => {
    const name = displayName.trim();
    const id   = modId.trim();
    const path = mapPath.trim();
    if (!name || !id || !path) { toast.error("All fields are required."); return; }
    if (!/^\d+$/.test(id)) { toast.error("Mod ID must be numeric."); return; }
    setSaving(true);
    try {
      if (editTarget) {
        await updateCustomMap(editTarget.id, name, id, path);
        toast.success(`"${name}" updated.`);
      } else {
        await insertCustomMap(crypto.randomUUID(), name, id, path);
        toast.success(`Custom map "${name}" added.`);
      }
      closeDialog();
      await load();
    } catch (e) {
      toast.error(`Failed to ${editTarget ? "update" : "add"} map: ${e}`);
    } finally {
      setSaving(false);
    }
  };

  const [deleteTarget, setDeleteTarget] = useState<CustomMapRow | null>(null);

  const handleDelete = async (map: CustomMapRow) => {
    try {
      await deleteCustomMap(map.id);
      await load();
      toast.success(`"${map.display_name}" removed.`);
    } catch (e) {
      toast.error(`Failed to delete map: ${e}`);
    } finally {
      setDeleteTarget(null);
    }
  };

  return (
    <div className="h-full overflow-hidden flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-start justify-between shrink-0">
        <div>
          <div className="flex items-center gap-3">
            <Map className="w-6 h-6 shrink-0" style={{ color: "var(--neon-purple)" }} />
            <h1 className="text-2xl font-bold" style={{ color: "var(--neon-purple)", textShadow: "var(--glow-purple)" }}>
              Mod Maps
            </h1>
          </div>
          <p className="text-sm mt-1" style={{ color: "var(--text-muted)" }}>
            Add community mod maps so they appear in the server map dropdown.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => setShowAdd(true)}
          className="gap-2"
          style={{ borderColor: "rgba(var(--neon-purple-rgb),0.3)", color: "var(--neon-purple)" }}
        >
          <Plus className="w-4 h-4" />
          Add Map
        </Button>
      </div>

      {/* Add / Edit dialog */}
      <Dialog open={showAdd || editTarget !== null} onOpenChange={(open) => { if (!open) closeDialog(); }}>
        <DialogContent className="max-w-lg" style={{ background: "var(--popover)", border: "1px solid rgba(var(--neon-purple-rgb),0.3)" }}>
          <DialogHeader>
            <DialogTitle style={{ color: "var(--neon-purple)" }}>
              {editTarget ? "Edit Custom Map" : "New Custom Map"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-1">
            <div className="space-y-1.5">
              <Label style={{ color: "var(--text-primary)" }}>Display Name</Label>
              <Input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="e.g. Fjordur Reborn"
                disabled={saving}
                style={{ background: "var(--surface)", borderColor: "rgba(var(--neon-purple-rgb),0.3)", color: "var(--text-primary)" }}
              />
            </div>
            <div className="space-y-1.5">
              <Label style={{ color: "var(--text-primary)" }}>CurseForge Mod ID</Label>
              <Input
                value={modId}
                onChange={(e) => setModId(e.target.value.replace(/\D/g, ""))}
                placeholder="e.g. 965379"
                inputMode="numeric"
                disabled={saving}
                style={{ background: "var(--surface)", borderColor: "rgba(var(--neon-purple-rgb),0.3)", color: "var(--text-primary)" }}
              />
            </div>
            <div className="space-y-1.5">
              <Label style={{ color: "var(--text-primary)" }}>Map Launch Parameter</Label>
              <Input
                value={mapPath}
                onChange={(e) => setMapPath(e.target.value)}
                placeholder="e.g. MyMap_WP"
                disabled={saving}
                style={{ background: "var(--surface)", borderColor: "rgba(var(--neon-purple-rgb),0.3)", color: "var(--text-primary)" }}
              />
              <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                The exact map path string passed at server launch (e.g. <span className="font-mono">TheIsland_WP</span>).
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={closeDialog}
              disabled={saving}
              style={{ color: "var(--text-primary)" }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving || !displayName.trim() || !modId.trim() || !mapPath.trim()}
              style={{ background: "rgba(var(--neon-purple-rgb),0.15)", borderColor: "rgba(var(--neon-purple-rgb),0.5)", color: "var(--neon-purple)" }}
            >
              {saving ? <><Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />Saving…</> : editTarget ? "Save Changes" : "Save Map"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Built-in mod maps reference */}
      {ARK_MAPS.filter((m) => m.isMod && m.released).length > 0 && (
        <div className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--neon-purple)" }}>
            Built-in Mod Maps (read-only reference)
          </h2>
          <div className="glass-card rounded-xl overflow-hidden" style={{ border: "1px solid rgba(var(--neon-purple-rgb),0.12)" }}>
            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderBottom: "1px solid rgba(var(--neon-purple-rgb),0.12)" }}>
                  <TH>Display Name</TH>
                  <TH>Map Launch Parameter</TH>
                  <TH>CurseForge Mod ID</TH>
                  <th className="w-20" />
                </tr>
              </thead>
              <tbody>
                {ARK_MAPS.filter((m) => m.isMod && m.released).map((m, i, arr) => (
                  <tr
                    key={m.id}
                    style={{ borderBottom: i < arr.length - 1 ? "1px solid rgba(var(--neon-purple-rgb),0.07)" : undefined }}
                  >
                    <td className="px-4 py-2.5 font-medium" style={{ color: "var(--text-primary)" }}>{m.displayName}</td>
                    <td className="px-4 py-2.5 font-mono text-xs" style={{ color: "var(--text-primary)" }}>{m.mapPath}</td>
                    <td className="px-4 py-2.5 font-mono text-xs" style={{ color: "var(--text-primary)" }}>{m.requiredModId ?? "—"}</td>
                    <td className="px-2 py-2.5 w-20" />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Custom maps */}
      <div className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--neon-purple)" }}>
          Your Custom Maps
        </h2>
        {loading ? (
          <div className="h-12 rounded-xl animate-pulse" style={{ background: "rgba(255,255,255,0.04)" }} />
        ) : customMaps.length === 0 ? (
          <div className="glass-card flex flex-col items-center justify-center gap-4 py-24 text-center rounded-2xl">
            <div
              className="flex items-center justify-center w-16 h-16 rounded-full"
              style={{ background: "rgba(var(--neon-purple-rgb),0.05)", border: "1px solid rgba(var(--neon-purple-rgb),0.15)" }}
            >
              <Map className="w-8 h-8" style={{ color: "var(--neon-purple)" }} />
            </div>
            <div>
              <h2 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>No custom maps yet</h2>
              <p className="text-sm mt-1 max-w-sm" style={{ color: "var(--text-muted)" }}>
                Register a community mod map so it appears in the server map dropdown.
              </p>
            </div>
            <Button
              variant="outline"
              onClick={() => setShowAdd(true)}
              className="mt-2 gap-2"
              style={{ borderColor: "rgba(var(--neon-purple-rgb),0.3)", color: "var(--neon-purple)" }}
            >
              <Plus className="w-4 h-4" /> Add Map
            </Button>
          </div>
        ) : (
          <div className="glass-card rounded-xl overflow-hidden" style={{ border: "1px solid rgba(var(--neon-purple-rgb),0.2)" }}>
            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderBottom: "1px solid rgba(var(--neon-purple-rgb),0.12)" }}>
                  <TH>Display Name</TH>
                  <TH>Map Launch Parameter</TH>
                  <TH>CurseForge Mod ID</TH>
                  <th className="w-20" />
                </tr>
              </thead>
              <tbody>
                {customMaps.map((m, i) => (
                  <tr
                    key={m.id}
                    style={{ borderBottom: i < customMaps.length - 1 ? "1px solid rgba(var(--neon-purple-rgb),0.08)" : undefined }}
                  >
                    <td className="px-4 py-3 font-medium" style={{ color: "var(--text-primary)" }}>{m.display_name}</td>
                    <td className="px-4 py-3 font-mono text-xs" style={{ color: "var(--text-primary)" }}>{m.map_path}</td>
                    <td className="px-4 py-3 font-mono text-xs" style={{ color: "var(--text-primary)" }}>{m.mod_id}</td>
                    <td className="px-2 py-3">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => openEdit(m)}
                          className="p-1.5 rounded-lg transition-colors hover:bg-(--surface-elevated)"
                          style={{ color: "var(--neon-purple)" }}
                          title={`Edit ${m.display_name}`}
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => setDeleteTarget(m)}
                          className="p-1.5 rounded-lg transition-colors hover:bg-red-500/10"
                          style={{ color: "rgba(255,0,85,0.6)" }}
                          title={`Remove ${m.display_name}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Delete confirmation ── */}
      <Dialog open={!!deleteTarget} onOpenChange={(v) => !v && setDeleteTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove Mod Map?</DialogTitle>
          </DialogHeader>
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>
            Remove &quot;{deleteTarget?.display_name}&quot; from the mod maps list? This does not uninstall the mod itself.
          </p>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDeleteTarget(null)}
              style={{ borderColor: "rgba(var(--neon-purple-rgb),0.3)", color: "var(--text-muted)" }}>
              Cancel
            </Button>
            <Button
              onClick={() => deleteTarget && handleDelete(deleteTarget)}
              className="gap-2 bg-[rgba(255,0,85,0.08)]! hover:bg-[rgba(255,0,85,0.2)]!"
              style={{ borderColor: "rgba(255,0,85,0.3)", color: "var(--neon-red)" }}
            >
              <Trash2 className="w-3.5 h-3.5" /> Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
