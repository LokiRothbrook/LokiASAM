"use client";

/**
 * ServerClusterCard — choose which cluster this server belongs to (or create
 * one) from the server's own Config tab. Uses the same join/leave helpers as
 * the Clusters page, so both behave identically; the cluster launch args are
 * derived at start, so changes apply on the next start.
 */

import { useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { GitBranch, Loader2, RotateCcw, Plus, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { OptionSelect } from "@/components/shared/OptionSelect";
import { BackupTiersEditor } from "@/components/shared/BackupTiersEditor";
import { getClusters, DEFAULT_BACKUP_TIERS, type BackupTierSettings, type ServerRow } from "@/lib/db";
import { createCluster, joinCluster, leaveCluster } from "@/lib/cluster-utils";
import { restartServerGracefully } from "@/lib/server-utils";

const NONE = "";
const NEW = "__new__";

export function ServerClusterCard({ server }: { server: ServerRow }) {
  const queryClient = useQueryClient();
  // Own key: ["clusters"] holds getClustersWithServerCount (Clusters page);
  // invalidating ["clusters"] still refreshes this by prefix.
  const { data: clusters = [] } = useQuery({ queryKey: ["clusters", "list"], queryFn: getClusters });
  const [busy, setBusy] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState<string | null>(null); // target value
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newBackups, setNewBackups] = useState<BackupTierSettings>(DEFAULT_BACKUP_TIERS);
  const [changedWhileRunning, setChangedWhileRunning] = useState(false);

  const current = server.cluster_id ?? NONE;
  const currentCluster = clusters.find((c) => c.id === current);
  const running = server.status === "running";

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["servers"] });
    queryClient.invalidateQueries({ queryKey: ["clusters"] });
    queryClient.invalidateQueries({ queryKey: ["cluster-members"] });
  };

  const apply = async (target: string) => {
    setBusy(true);
    try {
      if (target === NONE) await leaveCluster(server.id);
      else await joinCluster(server.id, target);
      invalidate();
      if (running) setChangedWhileRunning(true);
      toast.success(target === NONE ? "Removed from cluster." : `Joined ${clusters.find((c) => c.id === target)?.name ?? "cluster"}.`);
    } catch (e) {
      toast.error(`Failed to change cluster: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const onSelect = (value: string) => {
    if (value === current) return;
    if (value === NEW) { setCreating(true); return; }
    // Leaving (or switching away from) a cluster: confirm first.
    if (current !== NONE) { setConfirmLeave(value); return; }
    apply(value);
  };

  const createAndJoin = async () => {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      const id = await createCluster(newName.trim(), null, newBackups);
      if (current !== NONE) await leaveCluster(server.id);
      await joinCluster(server.id, id);
      invalidate();
      if (running) setChangedWhileRunning(true);
      toast.success(`Created ${newName.trim()} and joined it.`);
      setCreating(false);
      setNewName("");
      setNewBackups(DEFAULT_BACKUP_TIERS);
    } catch (e) {
      toast.error(`Failed to create cluster: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const restartNow = async () => {
    try {
      await restartServerGracefully(server, { onInvalidate: () => queryClient.invalidateQueries({ queryKey: ["servers"] }) });
      setChangedWhileRunning(false);
    } catch (e) { toast.error(`Restart failed: ${e}`); }
  };

  return (
    <div id="settings-cluster" data-tour="cfg-cluster" className="glass-card rounded-xl p-4 space-y-3" style={{ border: "1px solid rgba(var(--neon-purple-rgb),0.15)" }}>
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <GitBranch className="w-4 h-4 shrink-0" style={{ color: "var(--neon-purple)" }} />
          <div>
            <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Cluster</p>
            <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
              Servers in the same cluster let players transfer characters, dinos and items between them.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: "var(--text-muted)" }} />}
          <OptionSelect
            value={current}
            options={[
              { value: NONE, label: "Not in a cluster" },
              ...clusters.map((c) => ({ value: c.id, label: c.name })),
              { value: NEW, label: "Create new cluster…" },
            ]}
            onChange={onSelect}
            disabled={busy}
            className="w-56 text-sm"
          />
        </div>
      </div>

      {currentCluster && (
        <p className="text-xs pl-6" style={{ color: "var(--text-muted)" }}>
          <Link href={`/clusters/detail?id=${currentCluster.id}`} className="inline-flex items-center gap-1 hover:underline" style={{ color: "var(--neon-purple)" }}>
            Open {currentCluster.name} <ExternalLink className="w-3 h-3" />
          </Link>
          {" "}for its other servers and its backups.
        </p>
      )}

      {changedWhileRunning && (
        <div className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 ml-6"
          style={{ background: "rgba(var(--neon-orange-rgb),0.06)", border: "1px solid rgba(var(--neon-orange-rgb),0.2)" }}>
          <p className="text-xs" style={{ color: "var(--text-primary)" }}>The cluster change applies when the server next starts.</p>
          <Button size="sm" variant="outline" onClick={restartNow}
            style={{ borderColor: "rgba(var(--neon-orange-rgb),0.4)", color: "var(--neon-orange)" }}>
            <RotateCcw className="w-3.5 h-3.5 mr-1.5" /> Restart now
          </Button>
        </div>
      )}

      {/* Leave / switch confirmation */}
      <Dialog open={confirmLeave !== null} onOpenChange={(v) => { if (!v) setConfirmLeave(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Leave {currentCluster?.name ?? "this cluster"}?</DialogTitle>
            <DialogDescription>
              Players&apos; uploaded characters, dinos and items stay in the cluster&apos;s data, but this server
              won&apos;t be able to reach them{confirmLeave ? ` — it will use ${clusters.find((c) => c.id === confirmLeave)?.name}'s data instead` : ""}.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmLeave(null)}>Cancel</Button>
            <Button size="sm" className="btn-neon-purple" onClick={() => { const t = confirmLeave!; setConfirmLeave(null); apply(t); }}>
              {confirmLeave === NONE ? "Leave cluster" : "Switch cluster"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create a new cluster (with its backup schedule) and join it */}
      <Dialog open={creating} onOpenChange={(v) => { if (!v && !busy) setCreating(false); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New cluster</DialogTitle>
            <DialogDescription>Creates the cluster and adds this server to it.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Cluster name"
              onKeyDown={(e) => e.key === "Enter" && createAndJoin()}
              style={{ background: "var(--surface)", borderColor: "rgba(var(--neon-purple-rgb),0.3)", color: "var(--text-primary)" }} />
            <div className="space-y-1.5">
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>Cluster backups (changeable later on the cluster&apos;s page):</p>
              <BackupTiersEditor value={newBackups} onChange={setNewBackups} compact />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setCreating(false)} disabled={busy}>Cancel</Button>
            <Button size="sm" className="btn-neon-purple" onClick={createAndJoin} disabled={busy || !newName.trim()}>
              <Plus className="w-3.5 h-3.5 mr-1.5" /> Create &amp; join
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
