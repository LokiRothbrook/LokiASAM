"use client";

import { useState, useEffect, useCallback } from "react";
import { Map, Plus, Trash2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { getCustomMaps, insertCustomMap, deleteCustomMap, type CustomMapRow } from "@/lib/db";
import { ARK_MAPS } from "@/data/game-data";

export default function ModMapsPage() {
  const [customMaps, setCustomMaps]   = useState<CustomMapRow[]>([]);
  const [loading, setLoading]         = useState(true);
  const [showAdd, setShowAdd]         = useState(false);
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

  useEffect(() => { load(); }, [load]);

  const handleAdd = async () => {
    const name = displayName.trim();
    const id   = modId.trim();
    const path = mapPath.trim();
    if (!name || !id || !path) { toast.error("All fields are required."); return; }
    if (!/^\d+$/.test(id)) { toast.error("Mod ID must be numeric."); return; }
    setSaving(true);
    try {
      await insertCustomMap(crypto.randomUUID(), name, id, path);
      setDisplayName(""); setModId(""); setMapPath("");
      setShowAdd(false);
      await load();
      toast.success(`Custom map "${name}" added.`);
    } catch (e) {
      toast.error(`Failed to add map: ${e}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (map: CustomMapRow) => {
    try {
      await deleteCustomMap(map.id);
      await load();
      toast.success(`"${map.display_name}" removed.`);
    } catch (e) {
      toast.error(`Failed to delete map: ${e}`);
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
          onClick={() => setShowAdd((v) => !v)}
          className="gap-2"
          style={{ borderColor: "rgba(var(--neon-purple-rgb),0.3)", color: "var(--neon-purple)" }}
        >
          <Plus className="w-4 h-4" />
          Add Map
        </Button>
      </div>

      {/* Add form */}
      {showAdd && (
        <div
          className="glass-card rounded-xl p-4 space-y-3"
          style={{ border: "1px solid rgba(var(--neon-purple-rgb),0.25)" }}
        >
          <h3 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>New Custom Map</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label style={{ color: "var(--text-primary)" }}>Display Name</Label>
              <Input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="e.g. Fjordur Reborn"
                style={{ background: "var(--surface)", borderColor: "rgba(var(--neon-purple-rgb),0.3)", color: "var(--text-primary)" }}
              />
            </div>
            <div className="space-y-1.5">
              <Label style={{ color: "var(--text-primary)" }}>CurseForge Mod ID</Label>
              <Input
                value={modId}
                onChange={(e) => setModId(e.target.value)}
                placeholder="e.g. 965379"
                style={{ background: "var(--surface)", borderColor: "rgba(var(--neon-purple-rgb),0.3)", color: "var(--text-primary)" }}
              />
            </div>
            <div className="space-y-1.5">
              <Label style={{ color: "var(--text-primary)" }}>Map Launch Parameter</Label>
              <Input
                value={mapPath}
                onChange={(e) => setMapPath(e.target.value)}
                placeholder="e.g. MyMap_WP"
                style={{ background: "var(--surface)", borderColor: "rgba(var(--neon-purple-rgb),0.3)", color: "var(--text-primary)" }}
              />
              <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                The exact map path string passed at server launch (e.g. <span className="font-mono">TheIsland_WP</span>).
              </p>
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            <Button size="sm" variant="outline" onClick={() => setShowAdd(false)} disabled={saving} style={{ color: "var(--text-primary)" }}>Cancel</Button>
            <Button
              size="sm" onClick={handleAdd} disabled={saving || !displayName.trim() || !modId.trim() || !mapPath.trim()}
              style={{ background: "rgba(var(--neon-purple-rgb),0.15)", borderColor: "rgba(var(--neon-purple-rgb),0.5)", color: "var(--neon-purple)" }}
            >
              {saving ? <><Loader2 className="w-3 h-3 animate-spin mr-1.5" />Saving…</> : "Save Map"}
            </Button>
          </div>
        </div>
      )}

      {/* Built-in mod maps reference */}
      {ARK_MAPS.filter((m) => m.isMod && m.released).length > 0 && (
        <div className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-subtle)" }}>
            Built-in Mod Maps (read-only reference)
          </h2>
          <div className="glass-card rounded-xl overflow-hidden" style={{ border: "1px solid rgba(var(--neon-purple-rgb),0.12)" }}>
            {ARK_MAPS.filter((m) => m.isMod && m.released).map((m, i, arr) => (
              <div
                key={m.id}
                className="flex items-center justify-between px-4 py-2.5 text-sm"
                style={{
                  borderBottom: i < arr.length - 1 ? "1px solid rgba(var(--neon-purple-rgb),0.07)" : undefined,
                }}
              >
                <div>
                  <span style={{ color: "var(--text-primary)" }}>{m.displayName}</span>
                  {m.requiredModId && (
                    <span className="ml-2 text-xs font-mono" style={{ color: "var(--text-muted)" }}>mod {m.requiredModId}</span>
                  )}
                </div>
                <span className="font-mono text-xs" style={{ color: "var(--text-muted)" }}>{m.mapPath}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Custom maps */}
      <div className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-subtle)" }}>
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
            {customMaps.map((m, i) => (
              <div
                key={m.id}
                className="flex items-center justify-between px-4 py-3"
                style={{
                  borderBottom: i < customMaps.length - 1 ? "1px solid rgba(var(--neon-purple-rgb),0.08)" : undefined,
                }}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>{m.display_name}</p>
                  <p className="text-xs font-mono" style={{ color: "var(--text-muted)" }}>
                    mod {m.mod_id} · {m.map_path}
                  </p>
                </div>
                <button
                  onClick={() => handleDelete(m)}
                  className="ml-4 p-1.5 rounded-lg transition-colors hover:bg-red-500/10"
                  style={{ color: "rgba(255,0,85,0.6)" }}
                  title={`Remove ${m.display_name}`}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
