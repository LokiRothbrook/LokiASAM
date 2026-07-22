"use client";

/**
 * ServerScopedTabPage — shared page shell for the standalone Backups and Logs
 * pages (also usable by any future top-level page that's just "pick a server,
 * show one of its tabs"). Handles the server picker, the ?server= URL param,
 * and the empty/no-servers state; the caller only supplies the page-specific
 * chrome (icon/title/description) and which tab component to render.
 */

import { useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { ChevronDown, Plus, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/store/useAppStore";
import { useServers } from "@/hooks/useServers";
import { ServerStatusBadge } from "@/components/server/ServerStatusBadge";
import type { ServerRow } from "@/lib/db";

interface ServerScopedTabPageProps {
  icon: LucideIcon;
  title: string;
  description: string;
  emptyStateDescription: string;
  /** Tailwind class(es) for the content wrapper — tabs differ in whether they scroll internally. */
  contentClassName: string;
  TabComponent: React.ComponentType<{ server: ServerRow }>;
}

export function ServerScopedTabPage({
  icon: Icon,
  title,
  description,
  emptyStateDescription,
  contentClassName,
  TabComponent,
}: ServerScopedTabPageProps) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { data: servers = [], isLoading } = useServers();
  const { setShowNewServerWizard } = useAppStore();

  const [rawSelectedId, setSelectedId] = useState<string>(
    searchParams.get("server") ?? ""
  );
  // Defaults to the first server once the list loads, without needing a
  // separate effect+state just to mirror that default back into state.
  const selectedId = rawSelectedId || servers[0]?.id || "";

  const selectedServer: ServerRow | undefined = servers.find(
    (s) => s.id === selectedId
  );

  const handleSelect = (id: string) => {
    setSelectedId(id);
    const url = new URL(window.location.href);
    url.searchParams.set("server", id);
    router.replace(url.pathname + url.search);
  };

  return (
    <div className="h-full overflow-hidden flex flex-col gap-4">
      {/* Page header */}
      <div className="shrink-0">
        <div className="flex items-center gap-3">
          <Icon className="w-6 h-6 shrink-0" style={{ color: "var(--neon-purple)" }} />
          <h1
            className="text-2xl font-bold"
            style={{ color: "var(--neon-purple)", textShadow: "var(--glow-purple)" }}
          >
            {title}
          </h1>
        </div>
        <p className="text-sm mt-1" style={{ color: "var(--text-muted)" }}>
          {description}
        </p>
      </div>

      {/* Server selector */}
      <div
        className="glass-card rounded-xl p-3 flex items-center gap-3 flex-wrap shrink-0"
        style={{ borderColor: "rgba(var(--neon-purple-rgb),0.2)" }}
      >
        <span className="text-sm font-medium shrink-0" style={{ color: "var(--text-muted)" }}>
          Server:
        </span>

        {isLoading ? (
          <div className="h-8 w-48 rounded bg-[rgba(255,255,255,0.05)] animate-pulse" />
        ) : servers.length === 0 ? (
          <span className="text-sm" style={{ color: "var(--text-muted)" }}>
            No servers configured
          </span>
        ) : (
          <div className="relative flex-1 max-w-xs">
            <select
              value={selectedId}
              onChange={(e) => handleSelect(e.target.value)}
              className="w-full h-9 pl-3 pr-8 text-sm rounded-lg appearance-none cursor-pointer"
              style={{
                background: "rgba(0,0,0,0.4)",
                border: "1px solid rgba(var(--neon-purple-rgb),0.25)",
                color: "var(--text-primary)",
              }}
            >
              {servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <ChevronDown
              className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 pointer-events-none"
              style={{ color: "var(--text-muted)" }}
            />
          </div>
        )}

        {selectedServer && (
          <div className="flex items-center gap-2 ml-auto">
            <ServerStatusBadge status={selectedServer.status} />
            <span className="text-xs font-mono" style={{ color: "var(--text-muted)" }}>
              Port {selectedServer.port}
            </span>
          </div>
        )}
      </div>

      {/* Tab content */}
      {selectedServer ? (
        <div className={`flex-1 min-h-0 ${contentClassName}`}>
          <TabComponent server={selectedServer} />
        </div>
      ) : !isLoading && servers.length === 0 ? (
        <div className="glass-card flex flex-col items-center justify-center gap-4 py-24 text-center rounded-2xl">
          <div
            className="flex items-center justify-center w-16 h-16 rounded-full"
            style={{ background: "rgba(var(--neon-purple-rgb),0.05)", border: "1px solid rgba(var(--neon-purple-rgb),0.15)" }}
          >
            <Icon className="w-8 h-8" style={{ color: "var(--neon-purple)" }} />
          </div>
          <div>
            <h2 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>No servers yet</h2>
            <p className="text-sm mt-1 max-w-sm" style={{ color: "var(--text-muted)" }}>
              {emptyStateDescription}
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() => setShowNewServerWizard(true)}
            className="mt-2 gap-2"
            style={{ borderColor: "rgba(var(--neon-purple-rgb),0.3)", color: "var(--neon-purple)" }}
          >
            <Plus className="w-4 h-4" /> Create Server
          </Button>
        </div>
      ) : null}
    </div>
  );
}
