"use client";

import { useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Server, Construction } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ServerStatusBadge } from "@/components/server/ServerStatusBadge";
import { getServer } from "@/lib/db";
import { ARK_MAPS } from "@/data/game-data";
import type { ServerRow } from "@/lib/db";

/**
 * Server detail page — accessed via `/servers/detail?id={uuid}`.
 *
 * Next.js static export cannot generate pages for runtime UUIDs, so this
 * single page reads `?id=` client-side.  Sub-tabs (Config, Mods, RCON,
 * Backups, Automation, Logs) are implemented in Phase 4 onward.
 */
export default function ServerDetailPage() {
  const params = useSearchParams();
  const router = useRouter();
  const serverId = params.get("id");

  const [server, setServer] = useState<ServerRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!serverId) {
      router.replace("/");
      return;
    }
    (async () => {
      try {
        const s = await getServer(serverId);
        if (!s) {
          setNotFound(true);
        } else {
          setServer(s);
        }
      } catch {
        setNotFound(true);
      } finally {
        setLoading(false);
      }
    })();
  }, [serverId, router]);

  const mapDisplay =
    server ? (ARK_MAPS.find((m) => m.id === server.map_id)?.displayName ?? server.map_id) : "";

  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-40" />
        <div className="grid grid-cols-2 gap-4 mt-4">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  if (notFound || !server) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-24 text-center">
        <Server className="w-12 h-12" style={{ color: "var(--text-muted)" }} />
        <p className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>
          Server not found
        </p>
        <Button asChild variant="outline" className="btn-neon-purple">
          <Link href="/">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Dashboard
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* ── Breadcrumb + header ── */}
      <div className="flex items-center gap-3">
        <Button
          asChild
          variant="ghost"
          size="icon"
          className="shrink-0"
          style={{ color: "var(--text-muted)" }}
        >
          <Link href="/">
            <ArrowLeft className="w-4 h-4" />
          </Link>
        </Button>
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <h1
              className="text-2xl font-bold"
              style={{ color: "var(--neon-purple)", textShadow: "var(--glow-purple)" }}
            >
              {server.name}
            </h1>
            <ServerStatusBadge status={server.status} large />
          </div>
          <p className="text-sm mt-0.5" style={{ color: "var(--text-muted)" }}>
            {mapDisplay} · Port {server.port} · RCON {server.rcon_port}
          </p>
        </div>
      </div>

      {/* ── Phase 4 placeholder ── */}
      <div
        className="glass-card flex flex-col items-center justify-center gap-4 py-20 text-center rounded-2xl"
        style={{ borderColor: "rgba(191,0,255,0.15)" }}
      >
        <div
          className="flex items-center justify-center w-16 h-16 rounded-full"
          style={{
            background: "rgba(191,0,255,0.05)",
            border: "1px solid rgba(191,0,255,0.2)",
          }}
        >
          <Construction className="w-8 h-8" style={{ color: "var(--neon-purple)" }} />
        </div>
        <div>
          <h2 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>
            Detail tabs coming in Phase 4
          </h2>
          <p
            className="text-sm mt-1 max-w-md"
            style={{ color: "var(--text-muted)" }}
          >
            Config editor, RCON console, live log viewer, mods, backups, and
            automation will all live here. The server is fully functional — use
            the dashboard cards to start, stop, and restart it.
          </p>
        </div>
        <div
          className="text-xs font-mono px-3 py-1 rounded-full"
          style={{
            color: "var(--neon-cyan)",
            background: "rgba(0,255,255,0.06)",
            border: "1px solid rgba(0,255,255,0.15)",
          }}
        >
          ID: {server.id}
        </div>
      </div>
    </div>
  );
}
