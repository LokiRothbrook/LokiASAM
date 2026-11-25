"use client";

/**
 * AccessListsCard — edit the player ID lists ASA reads from the server folder:
 * auto-admins, the exclusive-join whitelist, and the join no-check list.
 * Files are written immediately on Save (separate from the INI config save).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Users, Plus, X, Save, Info, ToggleLeft, ToggleRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useOnMount } from "@/hooks/useOnMount";
import { useSavedFlash } from "@/hooks/useSavedFlash";
import { tauriCmd, type AccessListId } from "@/lib/tauri-commands";
import type { ServerRow } from "@/lib/db";
import { ACCESS_LISTS_CHANGED_EVENT, notifyAccessListsChanged } from "@/lib/access-lists";

const LISTS: { id: AccessListId; title: string; description: string }[] = [
  { id: "admins",         title: "Admins",         description: "Players who are admins automatically, without entering the admin password (AllowedCheaterAccountIDs.txt)." },
  { id: "exclusive_join", title: "Whitelist",      description: "Only these players can join while exclusive join is on (PlayersExclusiveJoinList.txt)." },
  { id: "join_no_check",  title: "Bypass Checks",  description: "Players allowed to skip the server's join checks, e.g. when it's full (PlayersJoinNoCheckList.txt)." },
];

/** EOS product user IDs are 32 hex characters. */
const EOS_ID = /^[0-9a-f]{32}$/i;

const parse = (text: string) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

export function AccessListsCard({
  server,
  exclusiveJoin,
  onExclusiveJoinChange,
}: {
  server: ServerRow;
  /** Current -exclusivejoin launch flag (saved with the config). */
  exclusiveJoin: boolean;
  onExclusiveJoinChange: (on: boolean) => void;
}) {
  const [active, setActive] = useState<AccessListId>("admins");
  const [lists, setLists] = useState<Record<AccessListId, string[]> | null>(null);
  const [saved, setSavedLists] = useState<Record<AccessListId, string[]> | null>(null);
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedFlash, triggerSaved] = useSavedFlash();

  const installPath = server.install_path;
  const load = useCallback(async () => {
    const entries = await Promise.all(
      LISTS.map(async (l) => [l.id, parse(await tauriCmd.readAccessList(installPath, l.id).catch(() => ""))] as const),
    );
    const loaded = Object.fromEntries(entries) as Record<AccessListId, string[]>;
    setLists(loaded);
    setSavedLists(loaded);
  }, [installPath]);
  useOnMount(load);

  // The RCON console's ban/whitelist panels edit the same files — reload when
  // they change something, unless there are unsaved edits here to protect.
  const dirtyRef = useRef(false);
  useEffect(() => {
    dirtyRef.current = !!lists && !!saved && JSON.stringify(lists) !== JSON.stringify(saved);
  }, [lists, saved]);
  const serverId = server.id;
  useEffect(() => {
    const onChange = (e: Event) => {
      if ((e as CustomEvent<string>).detail === serverId && !dirtyRef.current) load();
    };
    window.addEventListener(ACCESS_LISTS_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(ACCESS_LISTS_CHANGED_EVENT, onChange);
  }, [serverId, load]);

  if (!lists || !saved) return null;
  const current = lists[active];
  const dirty = JSON.stringify(lists) !== JSON.stringify(saved);
  const meta = LISTS.find((l) => l.id === active)!;

  const add = () => {
    const ids = input.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) return;
    const bad = ids.filter((id) => !EOS_ID.test(id));
    if (bad.length > 0) {
      toast.error(`Not an EOS ID: ${bad.join(", ")}`, { description: "EOS IDs are 32 characters of 0-9 and a-f." });
      return;
    }
    const next = [...current];
    for (const id of ids.map((i) => i.toLowerCase())) if (!next.includes(id)) next.push(id);
    setLists({ ...lists, [active]: next });
    setInput("");
  };

  const remove = (id: string) => setLists({ ...lists, [active]: current.filter((x) => x !== id) });

  async function handleSave() {
    setSaving(true);
    try {
      for (const l of LISTS) {
        if (JSON.stringify(lists![l.id]) !== JSON.stringify(saved![l.id])) {
          const body = lists![l.id].join("\n");
          await tauriCmd.writeAccessList(installPath, l.id, body ? `${body}\n` : "");
        }
      }
      setSavedLists(lists);
      triggerSaved();
      notifyAccessListsChanged(server.id);
      toast.success(server.status === "stopped" ? "Player lists saved." : "Player lists saved — ASA reads them on the next restart.");
    } catch (e) {
      toast.error(`Failed to save player lists: ${e}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="glass-card rounded-xl p-4 space-y-3" style={{ border: "1px solid rgba(var(--neon-purple-rgb),0.2)" }}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4 shrink-0" style={{ color: "var(--neon-purple)" }} />
          <div>
            <h3 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Admins &amp; Whitelist</h3>
            <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>Player ID lists stored in the server folder.</p>
          </div>
        </div>
        <Button size="sm" className={savedFlash ? "btn-neon-green" : "btn-neon-purple"} disabled={!dirty || saving} onClick={handleSave}>
          <Save className="w-3.5 h-3.5 mr-1.5" />
          {saving ? "Saving…" : savedFlash ? "Saved!" : "Save Lists"}
        </Button>
      </div>

      <div className="flex gap-1">
        {LISTS.map((l) => (
          <button
            key={l.id}
            type="button"
            onClick={() => { setActive(l.id); setInput(""); }}
            className="text-xs px-3 py-1.5 rounded-lg transition-colors"
            style={active === l.id
              ? { background: "rgba(var(--neon-purple-rgb),0.15)", color: "var(--neon-purple)", border: "1px solid rgba(var(--neon-purple-rgb),0.4)" }
              : { color: "var(--text-muted)", border: "1px solid transparent" }}
          >
            {l.title} <span className="opacity-60">({lists[l.id].length})</span>
          </button>
        ))}
      </div>

      <p className="text-xs" style={{ color: "var(--text-muted)" }}>{meta.description}</p>

      {active === "exclusive_join" && (
        <div className="flex items-center justify-between gap-3 px-1 py-2 rounded-lg"
          style={{ background: "rgba(var(--neon-orange-rgb),0.06)", border: "1px solid rgba(var(--neon-orange-rgb),0.15)" }}>
          <div className="px-2">
            <p className="text-sm" style={{ color: "var(--text-primary)" }}>Enforce whitelist (<code>-exclusivejoin</code>)</p>
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>Saved with the config — use the Save button at the top of this tab.</p>
          </div>
          <button type="button" onClick={() => onExclusiveJoinChange(!exclusiveJoin)} className="shrink-0 pr-2"
            aria-label={exclusiveJoin ? "Disable exclusive join" : "Enable exclusive join"}>
            {exclusiveJoin
              ? <ToggleRight className="w-8 h-8" style={{ color: "var(--neon-purple)" }} />
              : <ToggleLeft className="w-8 h-8" style={{ color: "var(--text-subtle)" }} />}
          </button>
        </div>
      )}

      <div className="flex gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") add(); }}
          placeholder="EOS ID (32 characters) — separate several with commas"
          className="h-8 text-xs font-mono"
          style={{ background: "var(--surface)", borderColor: "rgba(var(--neon-purple-rgb),0.25)", color: "var(--text-primary)" }}
        />
        <Button size="sm" variant="outline" onClick={add} disabled={!input.trim()}
          style={{ borderColor: "rgba(var(--neon-purple-rgb),0.4)", color: "var(--neon-purple)" }}>
          <Plus className="w-3.5 h-3.5" />
        </Button>
      </div>

      {current.length === 0 ? (
        <p className="text-xs text-center py-3 rounded-lg" style={{ color: "var(--text-muted)", border: "1px dashed rgba(var(--neon-purple-rgb),0.2)" }}>
          No players in this list.
        </p>
      ) : (
        <div className="space-y-1 max-h-48 overflow-y-auto">
          {current.map((id) => (
            <div key={id} className="flex items-center justify-between px-3 py-1.5 rounded-lg"
              style={{ background: "var(--surface)", border: "1px solid rgba(var(--neon-purple-rgb),0.1)" }}>
              <span className="text-xs font-mono" style={{ color: "var(--text-primary)" }}>{id}</span>
              <button type="button" onClick={() => remove(id)} aria-label={`Remove ${id}`} style={{ color: "var(--text-muted)" }}>
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <p className="text-xs flex items-start gap-1.5" style={{ color: "var(--text-subtle)" }}>
        <Info className="w-3 h-3 shrink-0 mt-0.5" />
        A player can find their EOS ID by typing <code>whoami</code> in the in-game console.
      </p>
    </div>
  );
}
