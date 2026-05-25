"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Eye, EyeOff, Copy, Trash2, Search, X, ChevronDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { tauriCmd } from "@/lib/tauri-commands";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import type { ServerRow } from "@/lib/db";

interface Props {
  server: ServerRow;
}

interface LogLine {
  id: number;
  line: string;
  level: "info" | "warning" | "error";
}

type LevelFilter = "all" | "warning" | "error";

let _id = 0;

function levelColor(level: LogLine["level"]): string {
  switch (level) {
    case "error":   return "#ff6688";
    case "warning": return "#ffcc44";
    default:        return "#c0c0e8";
  }
}

function levelBg(level: LogLine["level"]): string {
  switch (level) {
    case "error":   return "rgba(255,0,85,0.06)";
    case "warning": return "rgba(255,204,68,0.06)";
    default:        return "transparent";
  }
}

/** Derive the ASA ShooterGame.log path from the server install path. */
function logPath(installPath: string): string {
  // Works on both Linux and Windows because path.join isn't available here.
  // installPath already ends without a slash in practice.
  const sep = installPath.includes("\\") ? "\\" : "/";
  return `${installPath}${sep}ShooterGame${sep}Saved${sep}Logs${sep}ShooterGame.log`;
}

export function LogsTab({ server }: Props) {
  const [watching, setWatching] = useState(false);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [filter, setFilter] = useState<LevelFilter>("all");
  const [search, setSearch] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);

  const logRef = useRef<HTMLDivElement>(null);
  const eventName = `log://line/${server.id}`;

  // Tauri event subscription — fires whenever Rust emits a new log line
  useTauriEvent<{ line: string; level: string }>(eventName, (payload) => {
    setLines((prev) => [
      ...prev.slice(-999),
      {
        id: ++_id,
        line: payload.line,
        level: (payload.level as LogLine["level"]) ?? "info",
      },
    ]);
  });

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [lines, autoScroll]);

  const startWatching = useCallback(async () => {
    const path = logPath(server.install_path);
    try {
      await tauriCmd.watchServerLog(server.id, path);
      setWatching(true);
      setLines((prev) => [
        ...prev,
        { id: ++_id, line: `── Watching: ${path} ──`, level: "info" },
      ]);
    } catch (e) {
      setLines((prev) => [
        ...prev,
        { id: ++_id, line: `Failed to start watcher: ${e}`, level: "error" },
      ]);
    }
  }, [server.id, server.install_path]);

  const stopWatching = useCallback(async () => {
    await tauriCmd.stopLogWatch(server.id).catch(() => null);
    setWatching(false);
    setLines((prev) => [
      ...prev,
      { id: ++_id, line: "── Log watch stopped ──", level: "info" },
    ]);
  }, [server.id]);

  // Stop the watcher when the component unmounts
  useEffect(() => {
    return () => {
      if (watching) {
        tauriCmd.stopLogWatch(server.id).catch(() => null);
      }
    };
  }, [watching, server.id]);

  const copyLog = () => {
    const text = visibleLines.map((l) => l.line).join("\n");
    navigator.clipboard.writeText(text).catch(() => null);
  };

  const visibleLines = lines.filter((l) => {
    if (filter === "warning" && l.level === "info") return false;
    if (filter === "error" && l.level !== "error") return false;
    if (search && !l.line.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="flex flex-col gap-4">
      {/* ── Toolbar ── */}
      <div
        className="glass-card rounded-xl p-3 flex items-center gap-3 flex-wrap"
        style={{ borderColor: watching ? "rgba(0,255,136,0.3)" : "rgba(191,0,255,0.15)" }}
      >
        <div className="flex items-center gap-2">
          <div
            className="w-2 h-2 rounded-full"
            style={{
              background: watching ? "var(--neon-green)" : "var(--text-muted)",
              boxShadow: watching ? "0 0 6px var(--neon-green)" : "none",
              animation: watching ? "pulse 2s infinite" : "none",
            }}
          />
          <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
            {watching ? "Live" : "Idle"}
          </span>
        </div>

        <div className="flex items-center gap-2 ml-auto flex-wrap">
          {/* Level filter */}
          {(["all", "warning", "error"] as LevelFilter[]).map((lvl) => (
            <Button
              key={lvl}
              size="sm"
              variant="ghost"
              className="h-7 text-xs capitalize"
              style={{
                color: filter === lvl ? "var(--neon-cyan)" : "var(--text-muted)",
                borderColor: filter === lvl ? "rgba(0,255,255,0.3)" : "transparent",
                border: filter === lvl ? "1px solid rgba(0,255,255,0.3)" : "1px solid transparent",
              }}
              onClick={() => setFilter(lvl)}
            >
              {lvl}
            </Button>
          ))}

          {!watching ? (
            <Button size="sm" className="btn-neon-green" onClick={startWatching}>
              <Eye className="w-3.5 h-3.5 mr-1.5" />
              Watch Log
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={stopWatching}>
              <EyeOff className="w-3.5 h-3.5 mr-1.5" />
              Stop
            </Button>
          )}

          <Button
            size="sm"
            variant="ghost"
            onClick={() => setAutoScroll((v) => !v)}
            title={autoScroll ? "Auto-scroll: on" : "Auto-scroll: off"}
            style={{ color: autoScroll ? "var(--neon-cyan)" : "var(--text-muted)" }}
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </Button>
          <Button size="sm" variant="ghost" onClick={copyLog} title="Copy visible lines">
            <Copy className="w-3.5 h-3.5" />
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setLines([])} title="Clear">
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {/* ── Search ── */}
      <div className="relative">
        <Search
          className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 pointer-events-none"
          style={{ color: "var(--text-muted)" }}
        />
        <Input
          placeholder="Filter log lines…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9 h-8 text-sm"
          style={{
            background: "rgba(0,0,0,0.3)",
            borderColor: "rgba(191,0,255,0.2)",
            color: "var(--text-primary)",
          }}
        />
        {search && (
          <button
            onClick={() => setSearch("")}
            className="absolute right-3 top-1/2 -translate-y-1/2"
          >
            <X className="w-3.5 h-3.5" style={{ color: "var(--text-muted)" }} />
          </button>
        )}
      </div>

      {/* ── Log output ── */}
      <div
        ref={logRef}
        className="rounded-xl p-3 overflow-y-auto font-mono text-xs leading-relaxed"
        style={{
          background: "#000008",
          border: "1px solid rgba(0,255,255,0.1)",
          minHeight: "400px",
          maxHeight: "560px",
        }}
      >
        {visibleLines.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 gap-2">
            <Eye className="w-6 h-6" style={{ color: "var(--text-muted)" }} />
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>
              {watching
                ? "Waiting for new log lines…"
                : "Click \"Watch Log\" to start tailing ShooterGame.log"}
            </p>
          </div>
        ) : (
          visibleLines.map((l) => (
            <div
              key={l.id}
              className="px-1 py-0.5 rounded"
              style={{ background: levelBg(l.level) }}
            >
              <span style={{ color: levelColor(l.level), wordBreak: "break-all" }}>
                {l.line}
              </span>
            </div>
          ))
        )}
      </div>

      <p className="text-xs" style={{ color: "var(--text-muted)" }}>
        Showing {visibleLines.length} of {lines.length} lines
        {search ? ` matching "${search}"` : ""}
        {filter !== "all" ? ` (${filter}+)` : ""}
      </p>
    </div>
  );
}
