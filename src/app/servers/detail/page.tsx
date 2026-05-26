"use client";

import { useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft, Server, LayoutDashboard, Settings2, Terminal,
  ScrollText, Package, Archive, CalendarClock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ServerStatusBadge } from "@/components/server/ServerStatusBadge";
import { OverviewTab } from "@/components/server/tabs/OverviewTab";
import { ConfigTab } from "@/components/server/tabs/ConfigTab";
import { RconTab } from "@/components/server/tabs/RconTab";
import { LogsTab } from "@/components/server/tabs/LogsTab";
import { ModsTab } from "@/components/server/tabs/ModsTab";
import { BackupsTab } from "@/components/server/tabs/BackupsTab";
import { AutomationTab } from "@/components/server/tabs/AutomationTab";
import { getServer } from "@/lib/db";
import { ARK_MAPS } from "@/data/game-data";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { useQueryClient } from "@tanstack/react-query";
import { updateServerStatus } from "@/lib/db";
import type { ServerRow } from "@/lib/db";
import type { ServerStatus } from "@/lib/tauri-commands";

const TABS = [
  { value: "overview",   label: "Overview",   icon: LayoutDashboard },
  { value: "config",     label: "Config",     icon: Settings2 },
  { value: "rcon",       label: "RCON",       icon: Terminal },
  { value: "logs",       label: "Logs",       icon: ScrollText },
  { value: "mods",       label: "Mods",       icon: Package },
  { value: "backups",    label: "Backups",     icon: Archive,         phase: 6 },
  { value: "automation", label: "Automation", icon: CalendarClock,   phase: 6 },
] as const;

type TabValue = typeof TABS[number]["value"];

function PhaseStub({ label, phase }: { label: string; phase: number }) {
  return (
    <div
      className="glass-card flex flex-col items-center justify-center gap-4 py-20 text-center rounded-2xl"
      style={{ borderColor: "rgba(191,0,255,0.15)" }}
    >
      <div
        className="flex items-center justify-center w-14 h-14 rounded-full"
        style={{ background: "rgba(191,0,255,0.05)", border: "1px solid rgba(191,0,255,0.2)" }}
      >
        <Package className="w-7 h-7" style={{ color: "var(--neon-purple)" }} />
      </div>
      <div>
        <h2 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>
          {label} — Phase {phase}
        </h2>
        <p className="text-sm mt-1 max-w-xs" style={{ color: "var(--text-muted)" }}>
          This section will be implemented in Phase {phase}.
        </p>
      </div>
    </div>
  );
}

/**
 * Server detail page — accessed via `/servers/detail?id={uuid}`.
 *
 * Uses query params because Next.js static export cannot pre-render runtime UUIDs.
 * Tab state is kept in a `?tab=` query param so the URL stays bookmarkable.
 */
export default function ServerDetailPage() {
  const params = useSearchParams();
  const router = useRouter();
  const queryClient = useQueryClient();

  const serverId = params.get("id") ?? "";
  const tabParam = (params.get("tab") as TabValue | null) ?? "overview";

  const [server, setServer] = useState<ServerRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [activeTab, setActiveTab] = useState<TabValue>(tabParam);

  // ── Load server row ──────────────────────────────────────────────────────
  const reload = async () => {
    if (!serverId) return;
    try {
      const s = await getServer(serverId);
      if (!s) { setNotFound(true); } else { setServer(s); }
    } catch { setNotFound(true); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    if (!serverId) { router.replace("/"); return; }
    reload();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  // ── Live status updates from backend ────────────────────────────────────
  useTauriEvent<ServerStatus>(`server://status/${serverId}`, async (payload) => {
    if (!serverId) return;
    // Sync status + pid to SQLite then reload the row so UI reflects the change
    await updateServerStatus(serverId, payload.status, payload.pid ?? null);
    queryClient.invalidateQueries({ queryKey: ["servers"] });
    const updated = await getServer(serverId);
    if (updated) setServer(updated);
  });

  // ── Tab change: keep ?tab= in sync ──────────────────────────────────────
  const handleTabChange = (value: string) => {
    const tab = value as TabValue;
    setActiveTab(tab);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    window.history.replaceState(null, "", url.toString());
  };

  // ── Loading / error states ───────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-4 w-48" />
        <div className="flex gap-2 mt-2">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-8 w-24 rounded-lg" />)}
        </div>
        <Skeleton className="h-64 w-full rounded-2xl mt-2" />
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

  const mapDisplay = ARK_MAPS.find((m) => m.id === server.map_id)?.displayName ?? server.map_id;

  return (
    <div className="flex flex-col gap-6">
      {/* ── Header ── */}
      <div className="flex items-start gap-3">
        <Button
          asChild
          variant="ghost"
          size="icon"
          className="shrink-0 mt-0.5"
          style={{ color: "var(--text-muted)" }}
        >
          <Link href="/">
            <ArrowLeft className="w-4 h-4" />
          </Link>
        </Button>
        <div className="min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h1
              className="text-2xl font-bold truncate"
              style={{ color: "var(--neon-purple)", textShadow: "var(--glow-purple)" }}
            >
              {server.name}
            </h1>
            <ServerStatusBadge status={server.status} large />
          </div>
          <p className="text-sm mt-0.5" style={{ color: "var(--text-muted)" }}>
            {mapDisplay} · Port {server.port} · RCON {server.rcon_port} · ID{" "}
            <span className="font-mono">{server.id.slice(0, 8)}</span>
          </p>
        </div>
      </div>

      {/* ── Tab bar ── */}
      <div
        className="flex gap-1 p-1 rounded-xl flex-wrap"
        style={{
          background: "rgba(0,0,0,0.4)",
          border: "1px solid rgba(191,0,255,0.15)",
        }}
      >
        {TABS.map(({ value, label, icon: Icon }) => {
          const active = activeTab === value;
          return (
            <button
              key={value}
              type="button"
              onClick={() => handleTabChange(value)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg transition-all cursor-pointer"
              style={{
                color: active ? "var(--neon-purple)" : "var(--text-muted)",
                background: active ? "rgba(191,0,255,0.12)" : "transparent",
                border: active ? "1px solid rgba(191,0,255,0.3)" : "1px solid transparent",
                fontWeight: active ? 600 : 400,
                textShadow: active ? "var(--glow-purple)" : "none",
              }}
            >
              <Icon className="w-3.5 h-3.5 shrink-0" />
              {label}
            </button>
          );
        })}
      </div>

      {/* ── Tab content ── */}
      <div className="mt-2">
        {activeTab === "overview"   && <OverviewTab server={server} />}
        {activeTab === "config"     && <ConfigTab   server={server} />}
        {activeTab === "rcon"       && <RconTab      server={server} />}
        {activeTab === "logs"       && <LogsTab      server={server} />}
        {activeTab === "mods"       && <ModsTab server={server} />}
        {activeTab === "backups"    && <BackupsTab    server={server} />}
        {activeTab === "automation" && <AutomationTab server={server} />}
      </div>
    </div>
  );
}
