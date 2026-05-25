import { Server, Plus } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

/**
 * Main dashboard — shows all managed server cards in a grid.
 * Server data and cards are implemented in Phase 3.
 */
export default function DashboardPage() {
  return (
    <div className="flex flex-col gap-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1
            className="text-2xl font-bold tracking-tight text-glow-cyan"
            style={{ color: "var(--neon-cyan)" }}
          >
            Server Dashboard
          </h1>
          <p className="text-sm mt-1" style={{ color: "var(--text-muted)" }}>
            Manage your Ark Survival Ascended dedicated servers.
          </p>
        </div>
        <Button asChild className="btn-neon-cyan gap-2">
          <Link href="/servers/new">
            <Plus className="w-4 h-4" />
            New Server
          </Link>
        </Button>
      </div>

      {/* Empty state — replaced by server grid in Phase 3 */}
      <div
        className="glass-card flex flex-col items-center justify-center gap-4 py-24 text-center"
      >
        <div
          className="flex items-center justify-center w-16 h-16 rounded-full"
          style={{ background: "rgba(0,255,255,0.05)", border: "1px solid rgba(0,255,255,0.15)" }}
        >
          <Server className="w-8 h-8" style={{ color: "var(--neon-cyan)" }} />
        </div>
        <div>
          <h2 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>
            No servers yet
          </h2>
          <p className="text-sm mt-1 max-w-sm" style={{ color: "var(--text-muted)" }}>
            Create your first Ark Survival Ascended server to get started.
            The setup wizard will guide you through installation.
          </p>
        </div>
        <Button asChild variant="outline" className="btn-neon-cyan mt-2">
          <Link href="/servers/new">
            <Plus className="w-4 h-4 mr-2" />
            Create Server
          </Link>
        </Button>
      </div>
    </div>
  );
}
