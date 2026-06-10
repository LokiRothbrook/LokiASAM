"use client";

import { Suspense, useState, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Network, Server, ArrowLeft, UserPlus, UserMinus,
  Play, Square, Folder, Copy, ChevronDown,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { tauriCmd } from "@/lib/tauri-commands";
import {
  getCluster,
  getServersInCluster,
  getServers,
  setServerCluster,
  getAppSetting,
  type ClusterRow,
  type ServerRow,
} from "@/lib/db";
import { ARK_MAPS } from "@/data/game-data";
import { ServerStatusBadge } from "@/components/server/ServerStatusBadge";

// ---------------------------------------------------------------------------
// Add Server Dialog
// ---------------------------------------------------------------------------

interface AddServerDialogProps {
  cluster: ClusterRow;
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
}

function AddServerDialog({ cluster, open, onClose, onAdded }: AddServerDialogProps) {
  const [selectedId, setSelectedId] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const { data: allServers = [] } = useQuery({
    queryKey: ["servers"],
    queryFn: getServers,
    enabled: open,
  });

  // Only show servers not already in a cluster
  const eligible = allServers.filter((s) => !s.cluster_id);

  async function handleAdd() {
    if (!selectedId) return;
    setBusy(true);
    try {
      await tauriCmd.addServerToCluster(selectedId, cluster.id);
      await setServerCluster(selectedId, cluster.id);
      const server = allServers.find((s) => s.id === selectedId);
      toast.success(`${server?.name ?? selectedId} added to ${cluster.name}.`);
      setSelectedId("");
      onAdded();
      onClose();
    } catch (e) {
      toast.error(`Failed to add server: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        style={{
          background: "var(--surface-elevated)",
          border: "1px solid var(--border)",
        }}
      >
        <DialogHeader>
          <DialogTitle style={{ color: "var(--neon-purple)" }}>
            Add Server to {cluster.name}
          </DialogTitle>
          <DialogDescription className="sr-only">Select a server to add to this cluster.</DialogDescription>
        </DialogHeader>

        {eligible.length === 0 ? (
          <p className="text-sm py-2" style={{ color: "var(--text-muted)" }}>
            All servers are already in a cluster. Remove a server from its current
            cluster first.
          </p>
        ) : (
          <div className="py-2">
            <Select value={selectedId} onValueChange={setSelectedId}>
              <SelectTrigger
                style={{ background: "var(--surface)", borderColor: "var(--border)" }}
              >
                <SelectValue placeholder="Select a server…" />
              </SelectTrigger>
              <SelectContent style={{ background: "var(--surface-elevated)", borderColor: "var(--border)" }}>
                {eligible.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={handleAdd}
            disabled={busy || !selectedId || eligible.length === 0}
            style={{
              background: "transparent",
              border: "1px solid var(--neon-purple)",
              color: "var(--neon-purple)",
            }}
          >
            {busy ? "Adding…" : "Add Server"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Member Server Row
// ---------------------------------------------------------------------------

interface MemberRowProps {
  server: ServerRow;
  onRemove: (s: ServerRow) => void;
}

function MemberRow({ server, onRemove }: MemberRowProps) {
  const router = useRouter();
  const map = ARK_MAPS.find((m) => m.id === server.map_id);

  return (
    <div
      className="flex items-center gap-3 px-4 py-3 rounded-lg transition-colors"
      style={{ background: "rgba(255,255,255,0.03)", border: "1px solid var(--border)" }}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
            {server.name}
          </span>
          <ServerStatusBadge status={server.status as never} />
        </div>
        <p className="text-xs mt-0.5 truncate" style={{ color: "var(--text-muted)" }}>
          {map?.displayName ?? server.map_id} · :{server.port}
        </p>
      </div>

      <div className="flex items-center gap-1.5">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => router.push(`/servers/detail?id=${server.id}`)}
          style={{ color: "var(--text-muted)" }}
        >
          Open
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="w-7 h-7"
          onClick={() => onRemove(server)}
          style={{ color: "var(--text-muted)" }}
          title="Remove from cluster"
        >
          <UserMinus className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail inner content
// ---------------------------------------------------------------------------

function ClusterDetailContent() {
  const router = useRouter();
  const params = useSearchParams();
  const id = params.get("id") ?? "";
  const queryClient = useQueryClient();

  const [showAdd, setShowAdd] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<ServerRow | null>(null);
  const [removing, setRemoving] = useState(false);

  const { data: cluster, isLoading: loadingCluster } = useQuery({
    queryKey: ["cluster", id],
    queryFn: () => getCluster(id),
    enabled: !!id,
  });

  const { data: members = [], isLoading: loadingMembers } = useQuery({
    queryKey: ["cluster-members", id],
    queryFn: () => getServersInCluster(id),
    enabled: !!id,
  });

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["cluster", id] });
    queryClient.invalidateQueries({ queryKey: ["cluster-members", id] });
    queryClient.invalidateQueries({ queryKey: ["clusters"] });
    queryClient.invalidateQueries({ queryKey: ["servers"] });
  }, [queryClient, id]);

  const baseDir = cluster?.cluster_dir_override
    ? null
    : null; // shown as note

  async function handleRemove(server: ServerRow) {
    setRemoving(true);
    try {
      await tauriCmd.removeServerFromCluster(server.id);
      await setServerCluster(server.id, null);
      toast.success(`${server.name} removed from cluster.`);
      refresh();
    } catch (e) {
      toast.error(`Failed to remove server: ${e}`);
    } finally {
      setRemoving(false);
      setRemoveTarget(null);
    }
  }

  async function copyToClipboard(text: string) {
    await navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard.");
  }

  if (!id) {
    return (
      <div className="flex items-center justify-center h-64">
        <p style={{ color: "var(--text-muted)" }}>No cluster ID specified.</p>
      </div>
    );
  }

  if (loadingCluster) {
    return (
      <div className="flex flex-col gap-4">
        <div className="h-8 w-48 rounded animate-pulse" style={{ background: "var(--surface)" }} />
        <div className="h-32 rounded-xl animate-pulse" style={{ background: "var(--surface)" }} />
      </div>
    );
  }

  if (!cluster) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 h-64">
        <Network className="w-10 h-10" style={{ color: "var(--text-subtle)" }} />
        <p style={{ color: "var(--text-muted)" }}>Cluster not found.</p>
        <Button variant="ghost" onClick={() => router.push("/clusters")}>
          <ArrowLeft className="w-4 h-4 mr-2" /> Back to Clusters
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => router.push("/clusters")}
          style={{ color: "var(--text-muted)" }}
        >
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="flex items-center gap-3">
          <div
            className="flex items-center justify-center w-10 h-10 rounded-lg"
            style={{
              background: "rgba(var(--neon-purple-rgb),0.1)",
              border: "1px solid rgba(var(--neon-purple-rgb),0.3)",
            }}
          >
            <Network className="w-5 h-5" style={{ color: "var(--neon-purple)" }} />
          </div>
          <div>
            <h1
              className="text-2xl font-bold"
              style={{ color: "var(--neon-purple)", textShadow: "var(--glow-purple)" }}
            >
              {cluster.name}
            </h1>
            <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
              {members.length} member server{members.length !== 1 ? "s" : ""}
            </p>
          </div>
        </div>
      </div>

      {/* Cluster Info Card */}
      <div
        className="glass-card p-5 rounded-xl flex flex-col gap-3"
        style={{ border: "1px solid var(--border)" }}
      >
        <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          Cluster Settings
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>Cluster ID</p>
            <div className="flex items-center gap-2 mt-1">
              <code
                className="text-xs font-mono px-2 py-1 rounded"
                style={{
                  background: "rgba(0,0,0,0.3)",
                  color: "var(--neon-cyan)",
                  border: "1px solid rgba(var(--neon-purple-rgb),0.15)",
                }}
              >
                {cluster.id}
              </code>
              <Button
                variant="ghost"
                size="icon"
                className="w-6 h-6"
                onClick={() => copyToClipboard(cluster.id)}
                title="Copy cluster ID"
              >
                <Copy className="w-3 h-3" />
              </Button>
            </div>
          </div>
          <div>
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>Cluster Directory</p>
            <p
              className="text-xs font-mono mt-1 truncate"
              style={{ color: cluster.cluster_dir_override ? "var(--text-primary)" : "var(--text-subtle)" }}
              title={cluster.cluster_dir_override ?? undefined}
            >
              {cluster.cluster_dir_override ?? "Auto (base_dir/clusters/" + cluster.id.slice(0, 8) + "…)"}
            </p>
          </div>
        </div>
        <p className="text-xs" style={{ color: "var(--text-subtle)" }}>
          This Cluster ID is passed as{" "}
          <code className="font-mono">-ClusterID={cluster.id}</code> to each member server's
          launch arguments so they can share player and tribe data.
        </p>
      </div>

      {/* Member Servers */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            Member Servers
          </h2>
          <Button
            size="sm"
            onClick={() => setShowAdd(true)}
            style={{
              background: "transparent",
              border: "1px solid var(--neon-purple)",
              color: "var(--neon-purple)",
              height: "1.75rem",
              fontSize: "0.75rem",
            }}
          >
            <UserPlus className="w-3 h-3 mr-1.5" />
            Add Server
          </Button>
        </div>

        {loadingMembers ? (
          <div className="flex flex-col gap-2">
            {[1, 2].map((i) => (
              <div
                key={i}
                className="h-14 rounded-lg animate-pulse"
                style={{ background: "var(--surface)" }}
              />
            ))}
          </div>
        ) : members.length === 0 ? (
          <div
            className="glass-card flex flex-col items-center gap-3 py-12 text-center rounded-xl"
            style={{ border: "1px solid var(--border)" }}
          >
            <Server className="w-8 h-8" style={{ color: "var(--text-subtle)" }} />
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>
              No servers in this cluster yet.
            </p>
            <Button
              size="sm"
              onClick={() => setShowAdd(true)}
              style={{
                background: "transparent",
                border: "1px solid var(--neon-purple)",
                color: "var(--neon-purple)",
              }}
            >
              <UserPlus className="w-3.5 h-3.5 mr-1.5" />
              Add First Server
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {members.map((s) => (
              <MemberRow key={s.id} server={s} onRemove={setRemoveTarget} />
            ))}
          </div>
        )}
      </div>

      {/* Add Server Dialog */}
      <AddServerDialog
        cluster={cluster}
        open={showAdd}
        onClose={() => setShowAdd(false)}
        onAdded={refresh}
      />

      {/* Remove Confirm Dialog */}
      <Dialog
        open={!!removeTarget}
        onOpenChange={(v) => !v && setRemoveTarget(null)}
      >
        <DialogContent
          style={{
            background: "var(--surface-elevated)",
            border: "1px solid var(--border)",
          }}
        >
          <DialogHeader>
            <DialogTitle style={{ color: "var(--neon-red)" }}>
              Remove from Cluster
            </DialogTitle>
            <DialogDescription className="sr-only">Confirm removing this server from the cluster.</DialogDescription>
          </DialogHeader>
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>
            Remove{" "}
            <span className="font-semibold" style={{ color: "var(--text-primary)" }}>
              {removeTarget?.name}
            </span>{" "}
            from this cluster? The server will continue running as a standalone server.
          </p>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setRemoveTarget(null)}
              disabled={removing}
            >
              Cancel
            </Button>
            <Button
              onClick={() => removeTarget && handleRemove(removeTarget)}
              disabled={removing}
              style={{
                background: "transparent",
                border: "1px solid var(--neon-red)",
                color: "var(--neon-red)",
              }}
            >
              {removing ? "Removing…" : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page export — wraps with Suspense for useSearchParams
// ---------------------------------------------------------------------------

export default function ClusterDetailPage() {
  return (
    <Suspense
      fallback={
        <div className="flex flex-col gap-4">
          <div className="h-8 w-48 rounded animate-pulse" style={{ background: "var(--surface)" }} />
        </div>
      }
    >
      <ClusterDetailContent />
    </Suspense>
  );
}
