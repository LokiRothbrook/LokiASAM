"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Copy, Trash2, Search, X, ChevronDown, FileText, FolderOpen,
  MessageSquare, AlertTriangle, RefreshCw, Archive, ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { tauriCmd } from "@/lib/tauri-commands";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import type { ServerRow } from "@/lib/db";
import type {
  ArchivedLogInfo, CrashInfo, CrashReport, ChatLogInfo,
} from "@/lib/tauri-commands";

interface Props {
  server: ServerRow;
}

interface LogLine {
  id: number;
  line: string;
  level: "info" | "warning" | "error";
}

type LevelFilter = "all" | "warning" | "error";
type LogView = "live" | "archive" | "crashes" | "chat";

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

function logPath(installPath: string): string {
  const sep = installPath.includes("\\") ? "\\" : "/";
  return `${installPath}${sep}ShooterGame${sep}Saved${sep}Logs${sep}ShooterGame.log`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Live log panel
// ---------------------------------------------------------------------------

function LivePanel({ server }: { server: ServerRow }) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [filter, setFilter] = useState<LevelFilter>("all");
  const [search, setSearch] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [ready, setReady] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const backfillEvent = `log://backfill/${server.id}`;
  const lineEvent = `log://line/${server.id}`;

  // Receive batch of existing lines (backfill on watcher start)
  useTauriEvent<{ line: string; level: string }[]>(backfillEvent, (payload) => {
    const newLines = payload.map((item) => ({
      id: ++_id,
      line: item.line,
      level: (item.level as LogLine["level"]) ?? "info",
    }));
    setLines(newLines.slice(-4000));
    setReady(true);
  });

  // Receive individual new lines while tailing
  useTauriEvent<{ line: string; level: string }>(lineEvent, (payload) => {
    setReady(true);
    setLines((prev) => [
      ...prev.slice(-3999),
      {
        id: ++_id,
        line: payload.line,
        level: (payload.level as LogLine["level"]) ?? "info",
      },
    ]);
  });

  // Auto-start watcher on mount
  useEffect(() => {
    const path = logPath(server.install_path);
    tauriCmd.watchServerLog(server.id, path).catch(() => null);
    return () => {
      tauriCmd.stopLogWatch(server.id).catch(() => null);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id, server.install_path]);

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [lines, autoScroll]);

  const visibleLines = lines.filter((l) => {
    if (filter === "warning" && l.level === "info") return false;
    if (filter === "error" && l.level !== "error") return false;
    if (search && !l.line.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const copyLog = () => {
    const text = visibleLines.map((l) => l.line).join("\n");
    navigator.clipboard.writeText(text).catch(() => null);
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Toolbar */}
      <div
        className="glass-card rounded-xl p-3 flex items-center gap-3 flex-wrap"
        style={{ borderColor: ready ? "rgba(0,255,136,0.3)" : "rgba(191,0,255,0.15)" }}
      >
        <div className="flex items-center gap-2">
          <div
            className="w-2 h-2 rounded-full"
            style={{
              background: ready ? "var(--neon-green)" : "var(--text-muted)",
              boxShadow: ready ? "0 0 6px var(--neon-green)" : "none",
              animation: ready ? "pulse 2s infinite" : "none",
            }}
          />
          <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
            {ready ? "Live" : "Connecting…"}
          </span>
        </div>

        <div className="flex items-center gap-2 ml-auto flex-wrap">
          {(["all", "warning", "error"] as LevelFilter[]).map((lvl) => (
            <Button
              key={lvl}
              size="sm"
              variant="ghost"
              className="h-7 text-xs capitalize"
              style={{
                color: filter === lvl ? "var(--neon-cyan)" : "var(--text-muted)",
                border: filter === lvl ? "1px solid rgba(0,255,255,0.3)" : "1px solid transparent",
              }}
              onClick={() => setFilter(lvl)}
            >
              {lvl}
            </Button>
          ))}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setAutoScroll((v) => !v)}
            title={autoScroll ? "Auto-scroll on" : "Auto-scroll off"}
            style={{ color: autoScroll ? "var(--neon-cyan)" : "var(--text-muted)" }}
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </Button>
          <Button size="sm" variant="ghost" onClick={copyLog} title="Copy visible lines">
            <Copy className="w-3.5 h-3.5" />
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setLines([])} title="Clear display">
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 pointer-events-none" style={{ color: "var(--text-muted)" }} />
        <Input
          placeholder="Filter lines…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9 h-8 text-sm"
          style={{ background: "rgba(0,0,0,0.3)", borderColor: "rgba(191,0,255,0.2)", color: "var(--text-primary)" }}
        />
        {search && (
          <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2">
            <X className="w-3.5 h-3.5" style={{ color: "var(--text-muted)" }} />
          </button>
        )}
      </div>

      {/* Log output */}
      <div
        ref={logRef}
        className="rounded-xl p-3 overflow-y-auto font-mono text-xs leading-relaxed"
        style={{ background: "#000008", border: "1px solid rgba(0,255,255,0.1)", minHeight: "400px", maxHeight: "560px" }}
      >
        {visibleLines.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 gap-2">
            <FileText className="w-6 h-6" style={{ color: "var(--text-muted)" }} />
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>
              {ready ? "No lines match the current filter" : "Waiting for ShooterGame.log…"}
            </p>
          </div>
        ) : (
          visibleLines.map((l) => (
            <div key={l.id} className="px-1 py-0.5 rounded" style={{ background: levelBg(l.level) }}>
              <span style={{ color: levelColor(l.level), wordBreak: "break-all" }}>{l.line}</span>
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

// ---------------------------------------------------------------------------
// Archive panel
// ---------------------------------------------------------------------------

function ArchivePanel({ server }: { server: ServerRow }) {
  const [archives, setArchives] = useState<ArchivedLogInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<ArchivedLogInfo | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [loadingFile, setLoadingFile] = useState(false);
  const [search, setSearch] = useState("");
  const [cleanupDays, setCleanupDays] = useState(30);
  const [cleanupPending, setCleanupPending] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await tauriCmd.listArchivedLogs(server.id);
      setArchives(list);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [server.id]);

  useEffect(() => { load(); }, [load]);

  const openFile = useCallback(async (info: ArchivedLogInfo) => {
    setSelected(info);
    setLoadingFile(true);
    setLines([]);
    try {
      const content = await tauriCmd.readArchivedLog(server.id, info.filename, 0, 0);
      setLines(content);
    } catch { setLines(["[Failed to read file]"]); }
    finally { setLoadingFile(false); }
  }, [server.id]);

  const deleteFile = useCallback(async (info: ArchivedLogInfo) => {
    await tauriCmd.deleteArchivedLog(server.id, info.filename).catch(() => null);
    if (selected?.filename === info.filename) {
      setSelected(null);
      setLines([]);
    }
    load();
  }, [server.id, selected, load]);

  const doCleanup = useCallback(async () => {
    setCleanupPending(true);
    await tauriCmd.cleanupLogs(server.id, cleanupDays).catch(() => null);
    setCleanupPending(false);
    if (selected) { setSelected(null); setLines([]); }
    load();
  }, [server.id, cleanupDays, selected, load]);

  const visibleLines = search
    ? lines.filter((l) => l.toLowerCase().includes(search.toLowerCase()))
    : lines;

  if (selected) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => { setSelected(null); setLines([]); }} style={{ color: "var(--text-muted)" }}>
            <ChevronRight className="w-4 h-4 rotate-180" />
          </Button>
          <span className="text-sm font-medium font-mono" style={{ color: "var(--neon-cyan)" }}>{selected.filename}</span>
          <span className="text-xs ml-1" style={{ color: "var(--text-muted)" }}>({formatBytes(selected.sizeBytes)})</span>
          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 pointer-events-none" style={{ color: "var(--text-muted)" }} />
              <Input
                placeholder="Search…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-7 h-7 text-xs w-36"
                style={{ background: "rgba(0,0,0,0.3)", borderColor: "rgba(191,0,255,0.2)", color: "var(--text-primary)" }}
              />
            </div>
            <Button size="sm" variant="ghost" onClick={() => { const t = visibleLines.join("\n"); navigator.clipboard.writeText(t).catch(() => null); }} title="Copy">
              <Copy className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
        <div
          className="rounded-xl p-3 overflow-y-auto font-mono text-xs leading-relaxed"
          style={{ background: "#000008", border: "1px solid rgba(0,255,255,0.1)", minHeight: "400px", maxHeight: "560px" }}
        >
          {loadingFile ? (
            <div className="flex items-center justify-center h-40">
              <RefreshCw className="w-5 h-5 animate-spin" style={{ color: "var(--text-muted)" }} />
            </div>
          ) : visibleLines.length === 0 ? (
            <p className="text-sm text-center mt-16" style={{ color: "var(--text-muted)" }}>No lines match</p>
          ) : (
            visibleLines.map((l, i) => (
              <div key={i} className="px-1 py-0.5">
                <span style={{ color: "#c0c0e8", wordBreak: "break-all" }}>{l}</span>
              </div>
            ))
          )}
        </div>
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          {search ? `${visibleLines.length} of ${lines.length} lines` : `${lines.length} lines`}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
          {archives.length} archived session{archives.length !== 1 ? "s" : ""}
        </span>
        <Button size="sm" variant="ghost" onClick={load} title="Refresh" style={{ color: "var(--text-muted)" }}>
          <RefreshCw className="w-3.5 h-3.5" />
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>Delete older than</span>
          <select
            value={cleanupDays}
            onChange={(e) => setCleanupDays(Number(e.target.value))}
            className="h-7 text-xs rounded px-2"
            style={{ background: "rgba(0,0,0,0.4)", border: "1px solid rgba(191,0,255,0.2)", color: "var(--text-primary)" }}
          >
            {[7, 14, 30, 60, 90].map((d) => <option key={d} value={d}>{d} days</option>)}
          </select>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={doCleanup}
            disabled={cleanupPending}
            style={{ borderColor: "rgba(255,100,50,0.4)", color: "#ff8866" }}
          >
            {cleanupPending ? <RefreshCw className="w-3 h-3 animate-spin mr-1" /> : <Trash2 className="w-3 h-3 mr-1" />}
            Cleanup
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-40">
          <RefreshCw className="w-5 h-5 animate-spin" style={{ color: "var(--text-muted)" }} />
        </div>
      ) : archives.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-40 gap-2">
          <Archive className="w-6 h-6" style={{ color: "var(--text-muted)" }} />
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>No archived logs yet</p>
          <p className="text-xs" style={{ color: "var(--text-subtle)" }}>Archives are created automatically each time the server starts</p>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {archives.map((a) => (
            <div
              key={a.filename}
              className="glass-card rounded-lg px-3 py-2.5 flex items-center gap-3 cursor-pointer hover:border-[rgba(0,255,255,0.3)] transition-colors"
              style={{ borderColor: "rgba(191,0,255,0.15)" }}
              onClick={() => openFile(a)}
            >
              <FileText className="w-4 h-4 shrink-0" style={{ color: "var(--neon-cyan)" }} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-mono truncate" style={{ color: "var(--text-primary)" }}>{a.filename}</p>
                <p className="text-xs" style={{ color: "var(--text-muted)" }}>{a.timestamp} · {formatBytes(a.sizeBytes)}</p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="shrink-0 opacity-0 group-hover:opacity-100"
                onClick={(e) => { e.stopPropagation(); deleteFile(a); }}
                style={{ color: "var(--text-muted)" }}
                title="Delete"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Crashes panel
// ---------------------------------------------------------------------------

function CrashesPanel({ server }: { server: ServerRow }) {
  const [crashes, setCrashes] = useState<CrashInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<CrashInfo | null>(null);
  const [report, setReport] = useState<CrashReport | null>(null);
  const [loadingReport, setLoadingReport] = useState(false);
  const [activeFile, setActiveFile] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await tauriCmd.listCrashes(server.install_path);
      setCrashes(list);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [server.install_path]);

  useEffect(() => { load(); }, [load]);

  const openCrash = useCallback(async (crash: CrashInfo) => {
    setSelected(crash);
    setReport(null);
    setActiveFile(null);
    setLoadingReport(true);
    try {
      const r = await tauriCmd.readCrashReport(server.install_path, crash.folderName);
      setReport(r);
      if (r.files.length > 0) setActiveFile(r.files[0].name);
    } catch { /* ignore */ }
    finally { setLoadingReport(false); }
  }, [server.install_path]);

  if (selected) {
    const fileContent = report?.files.find((f) => f.name === activeFile)?.content ?? "";
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => { setSelected(null); setReport(null); }} style={{ color: "var(--text-muted)" }}>
            <ChevronRight className="w-4 h-4 rotate-180" />
          </Button>
          <span className="text-sm font-medium" style={{ color: "#ff6688" }}>{selected.folderName}</span>
        </div>
        {loadingReport ? (
          <div className="flex items-center justify-center h-40">
            <RefreshCw className="w-5 h-5 animate-spin" style={{ color: "var(--text-muted)" }} />
          </div>
        ) : report ? (
          <div className="flex flex-col gap-3">
            {/* File tabs */}
            <div className="flex gap-1 flex-wrap">
              {report.files.map((f) => (
                <button
                  key={f.name}
                  onClick={() => setActiveFile(f.name)}
                  className="px-2.5 py-1 text-xs rounded-lg transition-all"
                  style={{
                    background: activeFile === f.name ? "rgba(255,100,136,0.15)" : "rgba(0,0,0,0.3)",
                    border: activeFile === f.name ? "1px solid rgba(255,100,136,0.4)" : "1px solid rgba(255,255,255,0.06)",
                    color: activeFile === f.name ? "#ff6688" : "var(--text-muted)",
                  }}
                >
                  {f.name}
                </button>
              ))}
            </div>
            <div
              className="rounded-xl p-3 overflow-y-auto font-mono text-xs leading-relaxed whitespace-pre-wrap"
              style={{ background: "#000008", border: "1px solid rgba(255,100,136,0.15)", minHeight: "300px", maxHeight: "520px" }}
            >
              <span style={{ color: "#c0c0e8" }}>{fileContent}</span>
            </div>
          </div>
        ) : (
          <p className="text-sm text-center mt-8" style={{ color: "var(--text-muted)" }}>Failed to load crash report</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
          {crashes.length} crash report{crashes.length !== 1 ? "s" : ""}
        </span>
        <Button size="sm" variant="ghost" onClick={load} title="Refresh" style={{ color: "var(--text-muted)" }}>
          <RefreshCw className="w-3.5 h-3.5" />
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-40">
          <RefreshCw className="w-5 h-5 animate-spin" style={{ color: "var(--text-muted)" }} />
        </div>
      ) : crashes.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-40 gap-2">
          <AlertTriangle className="w-6 h-6" style={{ color: "var(--text-muted)" }} />
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>No crash reports found</p>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {crashes.map((c) => (
            <div
              key={c.folderName}
              className="glass-card rounded-lg px-3 py-2.5 flex items-center gap-3 cursor-pointer hover:border-[rgba(255,100,136,0.4)] transition-colors"
              style={{ borderColor: "rgba(255,100,136,0.2)" }}
              onClick={() => openCrash(c)}
            >
              <AlertTriangle className="w-4 h-4 shrink-0" style={{ color: "#ff6688" }} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-mono truncate" style={{ color: "var(--text-primary)" }}>{c.folderName}</p>
                <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                  {c.timestamp}
                  {c.hasCallStack && <span className="ml-2 text-[#ffcc44]">· has call stack</span>}
                  · {c.files.length} file{c.files.length !== 1 ? "s" : ""}
                </p>
              </div>
              <ChevronRight className="w-4 h-4 shrink-0" style={{ color: "var(--text-muted)" }} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chat panel
// ---------------------------------------------------------------------------

function ChatPanel({ server }: { server: ServerRow }) {
  const [chatLogs, setChatLogs] = useState<ChatLogInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<ChatLogInfo | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [loadingFile, setLoadingFile] = useState(false);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await tauriCmd.listChatLogs(server.id);
      setChatLogs(list);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [server.id]);

  useEffect(() => { load(); }, [load]);

  const openFile = useCallback(async (info: ChatLogInfo) => {
    setSelected(info);
    setLoadingFile(true);
    setLines([]);
    try {
      const content = await tauriCmd.readChatLog(server.id, info.filename, 0, 0);
      setLines(content);
    } catch { setLines(["[Failed to read file]"]); }
    finally { setLoadingFile(false); }
  }, [server.id]);

  // Auto-open today's log if available
  useEffect(() => {
    if (chatLogs.length > 0 && !selected) {
      openFile(chatLogs[0]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatLogs]);

  const visibleLines = search
    ? lines.filter((l) => l.toLowerCase().includes(search.toLowerCase()))
    : lines;

  return (
    <div className="flex flex-col gap-3">
      {/* Day selector */}
      <div className="flex items-center gap-2 flex-wrap">
        {loading ? (
          <RefreshCw className="w-4 h-4 animate-spin" style={{ color: "var(--text-muted)" }} />
        ) : chatLogs.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>No chat logs yet — chat is captured when RCON is connected</p>
        ) : (
          chatLogs.map((cl) => (
            <button
              key={cl.filename}
              onClick={() => openFile(cl)}
              className="px-2.5 py-1 text-xs rounded-lg transition-all"
              style={{
                background: selected?.filename === cl.filename ? "rgba(0,255,255,0.12)" : "rgba(0,0,0,0.3)",
                border: selected?.filename === cl.filename ? "1px solid rgba(0,255,255,0.3)" : "1px solid rgba(255,255,255,0.06)",
                color: selected?.filename === cl.filename ? "var(--neon-cyan)" : "var(--text-muted)",
              }}
            >
              {cl.date}
              <span className="ml-1.5 opacity-60">{formatBytes(cl.sizeBytes)}</span>
            </button>
          ))
        )}
        <Button size="sm" variant="ghost" onClick={load} title="Refresh" style={{ color: "var(--text-muted)", marginLeft: "auto" }}>
          <RefreshCw className="w-3.5 h-3.5" />
        </Button>
      </div>

      {selected && (
        <>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 pointer-events-none" style={{ color: "var(--text-muted)" }} />
            <Input
              placeholder="Search chat…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 h-8 text-sm"
              style={{ background: "rgba(0,0,0,0.3)", borderColor: "rgba(191,0,255,0.2)", color: "var(--text-primary)" }}
            />
            {search && (
              <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2">
                <X className="w-3.5 h-3.5" style={{ color: "var(--text-muted)" }} />
              </button>
            )}
          </div>

          <div
            className="rounded-xl p-3 overflow-y-auto font-mono text-xs leading-relaxed"
            style={{ background: "#000008", border: "1px solid rgba(0,255,136,0.1)", minHeight: "360px", maxHeight: "540px" }}
          >
            {loadingFile ? (
              <div className="flex items-center justify-center h-40">
                <RefreshCw className="w-5 h-5 animate-spin" style={{ color: "var(--text-muted)" }} />
              </div>
            ) : visibleLines.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-40 gap-2">
                <MessageSquare className="w-6 h-6" style={{ color: "var(--text-muted)" }} />
                <p className="text-sm" style={{ color: "var(--text-muted)" }}>
                  {search ? "No lines match" : "No chat messages recorded yet"}
                </p>
              </div>
            ) : (
              visibleLines.map((l, i) => (
                <div key={i} className="px-1 py-0.5">
                  <span style={{ color: "#c0ffcc", wordBreak: "break-all" }}>{l}</span>
                </div>
              ))
            )}
          </div>

          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            {search ? `${visibleLines.length} of ${lines.length} messages` : `${lines.length} messages`}
          </p>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main LogsTab
// ---------------------------------------------------------------------------

const VIEW_TABS: { value: LogView; label: string; icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }> }[] = [
  { value: "live",    label: "Live",    icon: FileText },
  { value: "archive", label: "Archive", icon: Archive },
  { value: "crashes", label: "Crashes", icon: AlertTriangle },
  { value: "chat",    label: "Chat",    icon: MessageSquare },
];

export function LogsTab({ server }: Props) {
  const [view, setView] = useState<LogView>("live");

  return (
    <div className="flex flex-col gap-4">
      {/* Sub-tab bar */}
      <div
        className="flex gap-1 p-1 rounded-xl flex-wrap"
        style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(191,0,255,0.12)" }}
      >
        {VIEW_TABS.map(({ value, label, icon: Icon }) => {
          const active = view === value;
          return (
            <button
              key={value}
              type="button"
              onClick={() => setView(value)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg transition-all cursor-pointer"
              style={{
                color: active ? "var(--neon-cyan)" : "var(--text-muted)",
                background: active ? "rgba(0,255,255,0.08)" : "transparent",
                border: active ? "1px solid rgba(0,255,255,0.25)" : "1px solid transparent",
                fontWeight: active ? 600 : 400,
              }}
            >
              <Icon className="w-3.5 h-3.5 shrink-0" />
              {label}
            </button>
          );
        })}
        <div className="ml-auto flex items-center pr-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs gap-1.5"
            onClick={() => tauriCmd.getLogStorageRoot().then((p) => navigator.clipboard.writeText(p).catch(() => null)).catch(() => null)}
            title="Copy log storage path"
            style={{ color: "var(--text-muted)" }}
          >
            <FolderOpen className="w-3 h-3" />
          </Button>
        </div>
      </div>

      {/* Active panel */}
      {view === "live"    && <LivePanel    server={server} />}
      {view === "archive" && <ArchivePanel server={server} />}
      {view === "crashes" && <CrashesPanel server={server} />}
      {view === "chat"    && <ChatPanel    server={server} />}
    </div>
  );
}
