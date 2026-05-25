import { Network } from "lucide-react";

/** Cluster list page — implemented in Phase 7. */
export default function ClustersPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-glow-purple" style={{ color: "var(--neon-purple)" }}>
          Clusters
        </h1>
        <p className="text-sm mt-1" style={{ color: "var(--text-muted)" }}>
          Group servers for cross-ARK travel.
        </p>
      </div>
      <div className="glass-card flex flex-col items-center justify-center gap-4 py-24 text-center">
        <Network className="w-10 h-10" style={{ color: "var(--text-subtle)" }} />
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          Cluster management — coming in Phase 7.
        </p>
      </div>
    </div>
  );
}
