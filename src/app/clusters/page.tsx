"use client";

import { useState, useCallback, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import {
  Network, Plus, Trash2, ChevronRight, Server, Folder, ToggleLeft, ToggleRight,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { tauriCmd } from "@/lib/tauri-commands";
import {
  getClustersWithServerCount,
  createClusterRecord,
  deleteClusterRecord,
  getServersInCluster,
  setServerCluster,
  getAppSetting,
  type ClusterRow,
} from "@/lib/db";

// ---------------------------------------------------------------------------
// New Cluster Dialog
// ---------------------------------------------------------------------------

interface NewClusterDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

function NewClusterDialog({ open, onClose, onCreated }: NewClusterDialogProps) {
  const [name, setName] = useState("");
  const [customDir, setCustomDir] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleCreate() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const baseDir = (await getAppSetting("base_dir")) ?? "";
      const id = await tauriCmd.createCluster(
        name.trim(),
        baseDir,
        customDir.trim() || undefined
      );
      await createClusterRecord(id, name.trim(), customDir.trim() || null);
      toast.success(`Cluster "${name.trim()}" created.`);
      setName("");
      setCustomDir("");
      onCreated();
      onClose();
    } catch (e) {
      toast.error(`Failed to create cluster: ${e}`);
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
            New Cluster
          </DialogTitle>
          <DialogDescription className="sr-only">Create a new server cluster.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-1.5">
            <Label style={{ color: "var(--text-primary)" }}>Cluster Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Cluster"
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              style={{ background: "var(--surface)", borderColor: "var(--border)" }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label style={{ color: "var(--text-primary)" }}>
              Custom Cluster Directory{" "}
              <span style={{ color: "var(--text-subtle)", fontWeight: 400 }}>
                (optional)
              </span>
            </Label>
            <Input
              value={customDir}
              onChange={(e) => setCustomDir(e.target.value)}
              placeholder="Leave blank to auto-generate"
              style={{ background: "var(--surface)", borderColor: "var(--border)" }}
            />
            <p className="text-xs" style={{ color: "var(--text-subtle)" }}>
              If left blank, the cluster directory will be created inside your
              base install directory at <code>clusters/&#123;id&#125;/</code>.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy} className="hover:bg-(--surface-elevated)" style={{ color: "var(--neon-purple)", borderColor: "rgba(var(--neon-purple-rgb),0.25)" }}>
            Cancel
          </Button>
          <Button
            variant="outline"
            onClick={handleCreate}
            disabled={busy || !name.trim()}
            className="gap-2"
            style={{ borderColor: "rgba(var(--neon-purple-rgb),0.4)", color: "var(--neon-purple)" }}
          >
            {busy ? "Creating…" : "Create Cluster"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Delete Confirm Dialog
// ---------------------------------------------------------------------------

interface DeleteDialogProps {
  cluster: ClusterRow | null;
  onClose: () => void;
  onDeleted: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "empty";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function DeleteDialog({ cluster, onClose, onDeleted }: DeleteDialogProps) {
  const [busy, setBusy]               = useState(false);
  const [deleteFiles, setDeleteFiles] = useState(true);
  const [clusterDir, setClusterDir]   = useState("");
  const [dirBytes, setDirBytes]       = useState<number | null>(null);

  useEffect(() => {
    if (!cluster) return;
    setDeleteFiles(true);
    setDirBytes(null);

    // Resolve actual cluster directory
    getAppSetting("base_dir").then((baseDir) => {
      const dir = cluster.cluster_dir_override?.trim()
        ? cluster.cluster_dir_override
        : `${(baseDir ?? "").replace(/[/\\]$/, "")}/clusters/${cluster.id}`;
      setClusterDir(dir);

        return tauriCmd.getDirSize(dir).then((bytes) => setDirBytes(bytes)).catch(() => setDirBytes(-1));
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cluster?.id]);

  async function handleDelete() {
    if (!cluster) return;
    setBusy(true);
    try {
      const members = await getServersInCluster(cluster.id);
      for (const s of members) {
        await setServerCluster(s.id, null);
      }
      await tauriCmd.deleteCluster(clusterDir, deleteFiles);
      await deleteClusterRecord(cluster.id);
      toast.success(`Cluster "${cluster.name}" deleted.`);
      onDeleted();
      onClose();
    } catch (e) {
      toast.error(`Failed to delete cluster: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!cluster} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        style={{
          background: "var(--surface-elevated)",
          border: "1px solid var(--border)",
        }}
      >
        <DialogHeader>
          <DialogTitle style={{ color: "var(--neon-red)" }}>
            Delete Cluster
          </DialogTitle>
          <DialogDescription className="sr-only">Confirm cluster deletion.</DialogDescription>
        </DialogHeader>

        <p className="text-sm mb-3" style={{ color: "var(--text-muted)" }}>
          All member servers will be detached. Server files are not affected.
        </p>

        <div
          className="flex items-center justify-between px-1 py-2 rounded-lg"
          style={{ background: "rgba(255,0,85,0.05)", border: "1px solid rgba(255,0,85,0.15)" }}
        >
          <div className="min-w-0 pr-3">
            <p className="text-sm" style={{ color: "var(--text-primary)" }}>
              Delete cluster directory{dirBytes !== null && dirBytes >= 0 ? ` (${formatBytes(dirBytes)})` : dirBytes === null ? " (scanning…)" : ""}
            </p>
            <p className="text-xs mt-0.5 break-all" style={{ color: "var(--text-muted)" }}>{clusterDir || "…"}</p>
          </div>
          <button
            type="button"
            onClick={() => setDeleteFiles((v) => !v)}
            className="shrink-0 flex items-center focus:outline-none"
          >
            {deleteFiles
              ? <ToggleRight className="w-8 h-8" style={{ color: "var(--neon-red)" }} />
              : <ToggleLeft className="w-8 h-8" style={{ color: "var(--text-muted)" }} />}
          </button>
        </div>

        <DialogFooter className="mt-2">
          <Button
            variant="outline"
            onClick={onClose}
            disabled={busy}
            className="hover:bg-(--surface-elevated)"
            style={{ color: "var(--neon-purple)", borderColor: "rgba(var(--neon-purple-rgb),0.25)" }}
          >
            Cancel
          </Button>
          <Button
            variant="outline"
            onClick={handleDelete}
            disabled={busy}
            className="gap-2 bg-[rgba(255,0,85,0.08)]! hover:bg-[rgba(255,0,85,0.2)]!"
            style={{ borderColor: "rgba(255,0,85,0.3)", color: "var(--neon-red)" }}
          >
            {busy ? "Deleting…" : "Delete Cluster"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Cluster Card
// ---------------------------------------------------------------------------

interface ClusterCardProps {
  cluster: ClusterRow & { server_count: number };
  onDelete: (c: ClusterRow) => void;
}

function ClusterCard({ cluster, onDelete }: ClusterCardProps) {
  const router = useRouter();

  return (
    <div
      className="glass-card flex flex-col gap-4 p-5 cursor-pointer transition-all duration-200 hover:border-(--neon-purple)"
      onClick={() => router.push(`/clusters/detail?id=${cluster.id}`)}
      style={{
        border: "1px solid var(--border)",
        borderRadius: "0.75rem",
      }}
    >
      <div className="flex items-start justify-between gap-4">
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
            <h3 className="font-semibold text-sm" style={{ color: "var(--text-primary)" }}>
              {cluster.name}
            </h3>
            <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
              ID: <span className="font-mono">{cluster.id.slice(0, 8)}…</span>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="w-7 h-7"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(cluster);
            }}
            style={{ color: "var(--neon-red)" }}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
          <ChevronRight className="w-4 h-4" style={{ color: "var(--text-subtle)" }} />
        </div>
      </div>

      <div className="flex items-center gap-5">
        <div className="flex items-center gap-1.5">
          <Server className="w-3.5 h-3.5" style={{ color: "var(--text-subtle)" }} />
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>
            {cluster.server_count} server{cluster.server_count !== 1 ? "s" : ""}
          </span>
        </div>
        {cluster.cluster_dir_override && (
          <div className="flex items-center gap-1.5 min-w-0">
            <Folder className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--text-subtle)" }} />
            <span
              className="text-xs truncate font-mono"
              style={{ color: "var(--text-subtle)" }}
              title={cluster.cluster_dir_override}
            >
              {cluster.cluster_dir_override}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ClustersPage() {
  const queryClient = useQueryClient();
  const [showNew, setShowNew] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ClusterRow | null>(null);

  const { data: clusters = [], isLoading } = useQuery({
    queryKey: ["clusters"],
    queryFn: getClustersWithServerCount,
  });

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["clusters"] });
  }, [queryClient]);

  return (
    <div className="h-full overflow-hidden flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-start justify-between shrink-0">
        <div>
          <div className="flex items-center gap-3">
            <Network className="w-6 h-6 shrink-0" style={{ color: "var(--neon-purple)" }} />
            <h1
              className="text-2xl font-bold"
              style={{ color: "var(--neon-purple)", textShadow: "var(--glow-purple)" }}
            >
              Clusters
            </h1>
          </div>
          <p className="text-sm mt-1" style={{ color: "var(--text-muted)" }}>
            Group servers for cross-ARK travel and shared data.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => setShowNew(true)}
          className="gap-2"
          style={{ borderColor: "rgba(var(--neon-purple-rgb),0.3)", color: "var(--neon-purple)" }}
        >
          <Plus className="w-4 h-4" />
          New Cluster
        </Button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto pr-6">
      {/* Cluster Grid */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[1, 2].map((i) => (
            <div key={i} className="glass-card h-28 animate-pulse rounded-xl" />
          ))}
        </div>
      ) : clusters.length === 0 ? (
        <div className="glass-card flex flex-col items-center justify-center gap-4 py-24 text-center rounded-2xl">
          <div
            className="flex items-center justify-center w-16 h-16 rounded-full"
            style={{ background: "rgba(var(--neon-purple-rgb),0.05)", border: "1px solid rgba(var(--neon-purple-rgb),0.15)" }}
          >
            <Network className="w-8 h-8" style={{ color: "var(--neon-purple)" }} />
          </div>
          <div>
            <h2 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>No clusters yet</h2>
            <p className="text-sm mt-1 max-w-sm" style={{ color: "var(--text-muted)" }}>
              Create a cluster to enable cross-ARK travel between servers.
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() => setShowNew(true)}
            className="mt-2 gap-2"
            style={{ borderColor: "rgba(var(--neon-purple-rgb),0.3)", color: "var(--neon-purple)" }}
          >
            <Plus className="w-4 h-4" /> New Cluster
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {clusters.map((c) => (
            <ClusterCard key={c.id} cluster={c} onDelete={setDeleteTarget} />
          ))}
        </div>
      )}

      {/* Dialogs */}
      <NewClusterDialog
        open={showNew}
        onClose={() => setShowNew(false)}
        onCreated={refresh}
      />
      <DeleteDialog
        cluster={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onDeleted={refresh}
      />
      </div>
    </div>
  );
}
