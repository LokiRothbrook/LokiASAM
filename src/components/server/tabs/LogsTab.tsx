"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Copy, Trash2, Search, X, FileText, FolderOpen,
  MessageSquare, AlertTriangle, RefreshCw, Archive, ChevronRight, ChevronDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { tauriCmd } from "@/lib/tauri-commands";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import type { ServerRow } from "@/lib/db";
import type {
  ArchivedLogInfo, CrashInfo, CrashReport, ChatLogInfo, OtherLogInfo,
} from "@/lib/tauri-commands";

interface Props {
  server: ServerRow;
}

interface LogLine {
  id: number;
  line: string;
  level: "info" | "warning" | "error";
}

type LevelFilter = "all" | "info" | "warning" | "error";
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

function classifyLine(line: string): LogLine["level"] {
  const lower = line.toLowerCase();
  if (lower.includes("error") || lower.includes("fatal") || lower.includes("critical")) return "error";
  if (lower.includes("warning") || lower.includes("warn")) return "warning";
  return "info";
}

function matchesFilter(level: LogLine["level"], filter: LevelFilter): boolean {
  if (filter === "all") return true;
  return level === filter;
}

// ---------------------------------------------------------------------------
// Level filter buttons (shared)
// ---------------------------------------------------------------------------

function LevelFilterBar({
  filter,
  setFilter,
}: {
  filter: LevelFilter;
  setFilter: (f: LevelFilter) => void;
}) {
  const options: { value: LevelFilter; label: string; activeColor: string }[] = [
    { value: "all",     label: "All",   activeColor: "var(--neon-cyan)" },
    { value: "info",    label: "Info",  activeColor: "var(--neon-cyan)" },
    { value: "warning", label: "Warn",  activeColor: "#ffcc44" },
    { value: "error",   label: "Error", activeColor: "#ff6688" },
  ];
  return (
    <>
      {options.map(({ value, label, activeColor }) => (
        <Button
          key={value}
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          style={{
            color: filter === value ? activeColor : "var(--text-muted)",
            border: filter === value ? `1px solid ${activeColor}40` : "1px solid transparent",
          }}
          onClick={() => setFilter(value)}
        >
          {label}
        </Button>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Scroll-to-bottom banner
// ---------------------------------------------------------------------------

function ScrollBanner({ onClick }: { onClick: () => void }) {
  return (
    <div
      className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-2 px-4 py-2 rounded-full cursor-pointer text-xs font-medium select-none z-10"
      style={{
        background: "rgba(0,0,0,0.85)",
        border: "1px solid rgba(var(--neon-purple-rgb),0.3)",
        color: "var(--neon-cyan)",
        backdropFilter: "blur(8px)",
        boxShadow: "0 0 12px rgba(var(--neon-purple-rgb),0.15)",
      }}
      onClick={onClick}
    >
      <ChevronDown className="w-3.5 h-3.5 animate-bounce" />
      Live tail paused — click to scroll to bottom
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live log panel
// ---------------------------------------------------------------------------

function LivePanel({ server }: { server: ServerRow }) {
  const isActive = server.status === "running" || server.status === "starting";

  const [lines, setLines] = useState<LogLine[]>([]);
  const [filter, setFilter] = useState<LevelFilter>("all");
  const [search, setSearch] = useState("");
  const [ready, setReady] = useState(false);
  const [scrolledUp, setScrolledUp] = useState(false);
  const [lastSessionFilename, setLastSessionFilename] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const loadLastSession = useCallback(async () => {
    try {
      const archives = await tauriCmd.listArchivedLogs(server.id);
      if (archives.length === 0) {
        setLastSessionFilename(null);
        setLines([]);
        return;
      }
      const latest = archives[archives.length - 1];
      setLastSessionFilename(latest.filename);
      const content = await tauriCmd.readArchivedLog(server.id, latest.filename, 0, 0);
      setLines(content.map((line) => ({ id: ++_id, line, level: classifyLine(line) })));
    } catch {
      setLastSessionFilename(null);
      setLines([]);
    }
  }, [server.id]);

  useTauriEvent<{ line: string; level: string }[]>(`log://backfill/${server.id}`, (payload) => {
    const newLines = payload.map((item) => ({
      id: ++_id,
      line: item.line,
      level: (item.level as LogLine["level"]) ?? "info",
    }));
    setLines(newLines.slice(-4000));
    setReady(true);
  });

  useTauriEvent<{ line: string; level: string }>(`log://line/${server.id}`, (payload) => {
    setReady(true);
    setLines((prev) => [
      ...prev.slice(-3999),
      { id: ++_id, line: payload.line, level: (payload.level as LogLine["level"]) ?? "info" },
    ]);
  });

  // Manage watcher vs last-session display based on whether the server is active.
  useEffect(() => {
    if (isActive) {
      setLastSessionFilename(null);
      setLines([]);
      setReady(false);
      tauriCmd.watchServerLog(server.id, logPath(server.install_path)).catch(() => null);
      return () => { tauriCmd.stopLogWatch(server.id).catch(() => null); };
    } else {
      tauriCmd.stopLogWatch(server.id).catch(() => null);
      loadLastSession();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id, isActive]);

  // Auto-scroll on new live lines and when last-session content is first loaded.
  useEffect(() => {
    if (!scrolledUp && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [lines, scrolledUp]);

  const handleScroll = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    setScrolledUp(!atBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    setScrolledUp(false);
  }, []);

  const visibleLines = lines.filter((l) => {
    if (!matchesFilter(l.level, filter)) return false;
    if (search && !l.line.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const openLogsFolder = useCallback(async () => {
    const root = await tauriCmd.getLogStorageRoot().catch(() => "");
    if (root) tauriCmd.openFolder(`${root}/${server.id}`).catch(() => null);
  }, [server.id]);

  // Derive toolbar appearance from server state
  const toolbarBorder = isActive
    ? (ready ? "rgba(0,255,136,0.3)" : "rgba(var(--neon-purple-rgb),0.15)")
    : "rgba(255,170,68,0.2)";
  const dotStyle = isActive
    ? (ready
        ? { background: "var(--neon-green)", boxShadow: "0 0 6px var(--neon-green)", animation: "pulse 2s infinite" }
        : { background: "var(--text-muted)" as string })
    : { background: "#ffaa44" };
  const statusLabel = isActive
    ? (ready ? "Live" : (server.status === "starting" ? "Starting…" : "Connecting…"))
    : (lastSessionFilename ? "Last Session" : "No Previous Sessions");

  return (
    <div className="flex flex-col gap-2 h-full">
      {/* Toolbar */}
      <div
        className="glass-card rounded-xl p-2.5 flex items-center gap-2 flex-wrap shrink-0"
        style={{ borderColor: toolbarBorder }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-2 h-2 rounded-full shrink-0" style={dotStyle} />
          <span className="text-xs font-medium shrink-0" style={{ color: "var(--text-primary)" }}>
            {statusLabel}
          </span>
          {!isActive && lastSessionFilename && (
            <span className="text-xs truncate hidden sm:block" style={{ color: "var(--text-muted)" }}>
              · {lastSessionFilename}
            </span>
          )}
        </div>

        <div className="w-px h-4 shrink-0" style={{ background: "rgba(255,255,255,0.08)" }} />
        <LevelFilterBar filter={filter} setFilter={setFilter} />

        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => { const t = visibleLines.map((l) => l.line).join("\n"); navigator.clipboard.writeText(t).catch(() => null); }} title="Copy visible lines" style={{ color: "var(--text-muted)" }}>
            <Copy className="w-3.5 h-3.5" />
          </Button>
          {isActive && (
            <Button size="sm" variant="ghost" onClick={() => setLines([])} title="Clear display" style={{ color: "var(--text-muted)" }}>
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={openLogsFolder} title="Open log storage folder" style={{ color: "var(--text-muted)" }}>
            <FolderOpen className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {/* Search */}
      <div className="relative shrink-0">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 pointer-events-none" style={{ color: "var(--text-muted)" }} />
        <Input
          placeholder="Filter lines…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9 h-8 text-sm"
          style={{ background: "rgba(0,0,0,0.3)", borderColor: "rgba(var(--neon-purple-rgb),0.2)", color: "var(--text-primary)" }}
        />
        {search && (
          <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2">
            <X className="w-3.5 h-3.5" style={{ color: "var(--text-muted)" }} />
          </button>
        )}
      </div>

      {/* Log output — fills remaining height */}
      <div className="relative flex-1 min-h-0">
        <div
          ref={logRef}
          onScroll={handleScroll}
          className="h-full overflow-y-auto font-mono text-xs leading-relaxed rounded-xl p-3"
          style={{ background: "#000008", border: "1px solid rgba(var(--neon-purple-rgb),0.1)" }}
        >
          {visibleLines.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 gap-2">
              <FileText className="w-6 h-6" style={{ color: "var(--text-muted)" }} />
              <p className="text-sm" style={{ color: "var(--text-muted)" }}>
                {isActive
                  ? "Waiting for ShooterGame.log…"
                  : lastSessionFilename
                  ? "No lines match the current filter"
                  : "No previous session logs found"}
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
        {scrolledUp && <ScrollBanner onClick={scrollToBottom} />}
      </div>

      <p className="text-xs shrink-0" style={{ color: "var(--text-muted)" }}>
        {visibleLines.length} of {lines.length} lines
        {search ? ` matching "${search}"` : ""}
        {filter !== "all" ? ` · ${filter} only` : ""}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Archive panel (ShooterGame archives + other logs)
// ---------------------------------------------------------------------------

function ArchivePanel({ server }: { server: ServerRow }) {
  const [archives, setArchives] = useState<ArchivedLogInfo[]>([]);
  const [otherLogs, setOtherLogs] = useState<OtherLogInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<{ filename: string; type: "shootergame" | "other" } | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [loadingFile, setLoadingFile] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<LevelFilter>("all");
  const [cleanupDays, setCleanupDays] = useState(30);
  const [cleanupPending, setCleanupPending] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [sg, other] = await Promise.all([
        tauriCmd.listArchivedLogs(server.id),
        tauriCmd.listOtherLogs(server.id),
      ]);
      setArchives(sg);
      setOtherLogs(other);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [server.id]);

  useEffect(() => { load(); }, [load]);

  const openFile = useCallback(async (filename: string, type: "shootergame" | "other") => {
    setSelected({ filename, type });
    setLoadingFile(true);
    setLines([]);
    try {
      const content = type === "shootergame"
        ? await tauriCmd.readArchivedLog(server.id, filename, 0, 0)
        : await tauriCmd.readOtherLog(server.id, filename, 0, 0);
      setLines(content);
    } catch { setLines(["[Failed to read file]"]); }
    finally { setLoadingFile(false); }
  }, [server.id]);

  const deleteFile = useCallback(async (filename: string, type: "shootergame" | "other") => {
    if (type === "shootergame") await tauriCmd.deleteArchivedLog(server.id, filename).catch(() => null);
    // other logs don't have a delete command yet — leave them (or add one later)
    if (selected?.filename === filename) { setSelected(null); setLines([]); }
    load();
  }, [server.id, selected, load]);

  const doCleanup = useCallback(async () => {
    setCleanupPending(true);
    await tauriCmd.cleanupLogs(server.id, cleanupDays).catch(() => null);
    setCleanupPending(false);
    setSelected(null); setLines([]);
    load();
  }, [server.id, cleanupDays, load]);

  const openLogsFolder = useCallback(async () => {
    const root = await tauriCmd.getLogStorageRoot().catch(() => "");
    if (root) tauriCmd.openFolder(`${root}/${server.id}`).catch(() => null);
  }, [server.id]);

  // Apply level filter to archive lines
  const visibleLines = lines.filter((l) => {
    const level = classifyLine(l);
    if (!matchesFilter(level, filter)) return false;
    if (search && !l.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  if (selected) {
    return (
      <div className="flex flex-col gap-2 h-full">
        <div className="flex items-center gap-2 shrink-0">
          <Button size="sm" variant="ghost" onClick={() => { setSelected(null); setLines([]); setSearch(""); setFilter("all"); }} style={{ color: "var(--text-muted)" }}>
            <ChevronRight className="w-4 h-4 rotate-180" />
          </Button>
          <span className="text-sm font-mono truncate" style={{ color: "var(--neon-cyan)" }}>{selected.filename}</span>
          <div className="ml-auto flex items-center gap-1">
            <LevelFilterBar filter={filter} setFilter={setFilter} />
            <div className="w-px h-4 shrink-0 mx-1" style={{ background: "rgba(255,255,255,0.08)" }} />
            <Button size="sm" variant="ghost" onClick={() => navigator.clipboard.writeText(visibleLines.join("\n")).catch(() => null)} title="Copy" style={{ color: "var(--text-muted)" }}>
              <Copy className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
        <div className="relative shrink-0">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 pointer-events-none" style={{ color: "var(--text-muted)" }} />
          <Input placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9 h-8 text-sm" style={{ background: "rgba(0,0,0,0.3)", borderColor: "rgba(var(--neon-purple-rgb),0.2)", color: "var(--text-primary)" }} />
          {search && <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2"><X className="w-3.5 h-3.5" style={{ color: "var(--text-muted)" }} /></button>}
        </div>
        <div className="relative flex-1 min-h-0">
          <div className="h-full overflow-y-auto font-mono text-xs leading-relaxed rounded-xl p-3" style={{ background: "#000008", border: "1px solid rgba(var(--neon-purple-rgb),0.1)" }}>
            {loadingFile ? (
              <div className="flex items-center justify-center h-40"><RefreshCw className="w-5 h-5 animate-spin" style={{ color: "var(--text-muted)" }} /></div>
            ) : visibleLines.length === 0 ? (
              <p className="text-sm text-center mt-16" style={{ color: "var(--text-muted)" }}>No lines match</p>
            ) : (
              visibleLines.map((l, i) => {
                const level = classifyLine(l);
                return (
                  <div key={i} className="px-1 py-0.5 rounded" style={{ background: levelBg(level) }}>
                    <span style={{ color: levelColor(level), wordBreak: "break-all" }}>{l}</span>
                  </div>
                );
              })
            )}
          </div>
        </div>
        <p className="text-xs shrink-0" style={{ color: "var(--text-muted)" }}>
          {search || filter !== "all" ? `${visibleLines.length} of ${lines.length} lines` : `${lines.length} lines`}
        </p>
      </div>
    );
  }

  const totalFiles = archives.length + otherLogs.length;

  return (
    <div className="flex flex-col gap-3 h-full">
      <div className="flex items-center gap-3 flex-wrap shrink-0">
        <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
          {totalFiles} file{totalFiles !== 1 ? "s" : ""}
        </span>
        <Button size="sm" variant="ghost" onClick={load} title="Refresh" style={{ color: "var(--text-muted)" }}>
          <RefreshCw className="w-3.5 h-3.5" />
        </Button>
        <Button size="sm" variant="ghost" onClick={openLogsFolder} title="Open folder" style={{ color: "var(--text-muted)" }}>
          <FolderOpen className="w-3.5 h-3.5" />
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>Delete older than</span>
          <select value={cleanupDays} onChange={(e) => setCleanupDays(Number(e.target.value))} className="h-7 text-xs rounded px-2" style={{ background: "rgba(0,0,0,0.4)", border: "1px solid rgba(var(--neon-purple-rgb),0.2)", color: "var(--text-primary)" }}>
            {[7, 14, 30, 60, 90].map((d) => <option key={d} value={d}>{d} days</option>)}
          </select>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={doCleanup} disabled={cleanupPending} style={{ borderColor: "rgba(255,100,50,0.4)", color: "#ff8866" }}>
            {cleanupPending ? <RefreshCw className="w-3 h-3 animate-spin mr-1" /> : <Trash2 className="w-3 h-3 mr-1" />}
            Cleanup
          </Button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-4">
        {loading ? (
          <div className="flex items-center justify-center h-40"><RefreshCw className="w-5 h-5 animate-spin" style={{ color: "var(--text-muted)" }} /></div>
        ) : totalFiles === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 gap-2">
            <Archive className="w-6 h-6" style={{ color: "var(--text-muted)" }} />
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>No archived logs yet</p>
            <p className="text-xs" style={{ color: "var(--text-subtle)" }}>Archives are created each time the server starts</p>
          </div>
        ) : (
          <>
            {/* ShooterGame archives */}
            {archives.length > 0 && (
              <div className="flex flex-col gap-1">
                <p className="text-xs font-medium px-1 mb-1" style={{ color: "var(--text-muted)" }}>ShooterGame Sessions</p>
                {archives.map((a) => (
                  <div key={a.filename} className="glass-card rounded-lg px-3 py-2.5 flex items-center gap-3 cursor-pointer hover:border-[rgba(var(--neon-purple-rgb),0.3)] transition-colors group" style={{ borderColor: "rgba(var(--neon-purple-rgb),0.15)" }} onClick={() => openFile(a.filename, "shootergame")}>
                    <FileText className="w-4 h-4 shrink-0" style={{ color: "var(--neon-cyan)" }} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-mono truncate" style={{ color: "var(--text-primary)" }}>{a.filename}</p>
                      <p className="text-xs" style={{ color: "var(--text-muted)" }}>{a.timestamp} · {formatBytes(a.sizeBytes)}</p>
                    </div>
                    <Button size="sm" variant="ghost" className="shrink-0 opacity-0 group-hover:opacity-100" onClick={(e) => { e.stopPropagation(); deleteFile(a.filename, "shootergame"); }} style={{ color: "var(--text-muted)" }} title="Delete">
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {/* Other logs */}
            {otherLogs.length > 0 && (
              <div className="flex flex-col gap-1">
                <p className="text-xs font-medium px-1 mb-1" style={{ color: "var(--text-muted)" }}>Other Server Logs</p>
                {otherLogs.map((o) => (
                  <div key={o.filename} className="glass-card rounded-lg px-3 py-2.5 flex items-center gap-3 cursor-pointer hover:border-[rgba(var(--neon-purple-rgb),0.3)] transition-colors" style={{ borderColor: "rgba(var(--neon-purple-rgb),0.1)" }} onClick={() => openFile(o.filename, "other")}>
                    <FileText className="w-4 h-4 shrink-0" style={{ color: "var(--neon-purple)" }} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-mono truncate" style={{ color: "var(--text-primary)" }}>{o.filename}</p>
                      <p className="text-xs" style={{ color: "var(--text-muted)" }}>{o.timestamp} · {formatBytes(o.sizeBytes)}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
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
      const list = await tauriCmd.listCrashes(server.id);
      setCrashes(list);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [server.id]);

  useEffect(() => { load(); }, [load]);

  const openCrash = useCallback(async (crash: CrashInfo) => {
    setSelected(crash);
    setReport(null);
    setActiveFile(null);
    setLoadingReport(true);
    try {
      const r = await tauriCmd.readCrashReport(server.id, crash.folderName);
      setReport(r);
      if (r.files.length > 0) setActiveFile(r.files[0].name);
    } catch { /* ignore */ }
    finally { setLoadingReport(false); }
  }, [server.id]);

  const deleteCrash = useCallback(async (crash: CrashInfo) => {
    await tauriCmd.deleteCrashReport(server.id, crash.folderName).catch(() => null);
    if (selected?.folderName === crash.folderName) { setSelected(null); setReport(null); }
    load();
  }, [server.id, selected, load]);

  const openCrashFolder = useCallback(async () => {
    const root = await tauriCmd.getLogStorageRoot().catch(() => "");
    if (root) tauriCmd.openFolder(`${root}/${server.id}/crashes`).catch(() => null);
  }, [server.id]);

  if (selected) {
    const fileContent = report?.files.find((f) => f.name === activeFile)?.content ?? "";
    return (
      <div className="flex flex-col gap-3 h-full">
        <div className="flex items-center gap-2 shrink-0">
          <Button size="sm" variant="ghost" onClick={() => { setSelected(null); setReport(null); }} style={{ color: "var(--text-muted)" }}>
            <ChevronRight className="w-4 h-4 rotate-180" />
          </Button>
          <span className="text-sm font-medium truncate" style={{ color: "#ff6688" }}>{selected.folderName}</span>
          <Button size="sm" variant="ghost" className="ml-auto shrink-0" onClick={() => deleteCrash(selected)} title="Delete crash report" style={{ color: "var(--text-muted)" }}>
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </div>
        {loadingReport ? (
          <div className="flex items-center justify-center h-40 flex-1">
            <RefreshCw className="w-5 h-5 animate-spin" style={{ color: "var(--text-muted)" }} />
          </div>
        ) : report ? (
          <div className="flex flex-col gap-2 flex-1 min-h-0">
            <div className="flex gap-1 flex-wrap shrink-0">
              {report.files.map((f) => (
                <button key={f.name} onClick={() => setActiveFile(f.name)} className="px-2.5 py-1 text-xs rounded-lg transition-all" style={{ background: activeFile === f.name ? "rgba(255,100,136,0.15)" : "rgba(0,0,0,0.3)", border: activeFile === f.name ? "1px solid rgba(255,100,136,0.4)" : "1px solid rgba(255,255,255,0.06)", color: activeFile === f.name ? "#ff6688" : "var(--text-muted)" }}>
                  {f.name}
                </button>
              ))}
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto rounded-xl p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap" style={{ background: "#000008", border: "1px solid rgba(255,100,136,0.15)" }}>
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
    <div className="flex flex-col gap-3 h-full">
      <div className="flex items-center gap-3 shrink-0">
        <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
          {crashes.length} crash report{crashes.length !== 1 ? "s" : ""}
        </span>
        <Button size="sm" variant="ghost" onClick={load} title="Refresh" style={{ color: "var(--text-muted)" }}>
          <RefreshCw className="w-3.5 h-3.5" />
        </Button>
        <Button size="sm" variant="ghost" onClick={openCrashFolder} title="Open crashes folder" style={{ color: "var(--text-muted)" }}>
          <FolderOpen className="w-3.5 h-3.5" />
        </Button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-40"><RefreshCw className="w-5 h-5 animate-spin" style={{ color: "var(--text-muted)" }} /></div>
        ) : crashes.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 gap-2">
            <AlertTriangle className="w-6 h-6" style={{ color: "var(--text-muted)" }} />
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>No crash reports found</p>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {crashes.map((c) => (
              <div key={c.folderName} className="glass-card rounded-lg px-3 py-2.5 flex items-center gap-3 cursor-pointer hover:border-[rgba(255,100,136,0.4)] transition-colors group" style={{ borderColor: "rgba(255,100,136,0.2)" }} onClick={() => openCrash(c)}>
                <AlertTriangle className="w-4 h-4 shrink-0" style={{ color: "#ff6688" }} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-mono truncate" style={{ color: "var(--text-primary)" }}>{c.folderName}</p>
                  <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                    {c.timestamp}
                    {c.hasCallStack && <span className="ml-2 text-[#ffcc44]">· has call stack</span>}
                    · {c.files.length} file{c.files.length !== 1 ? "s" : ""}
                  </p>
                </div>
                <Button size="sm" variant="ghost" className="shrink-0 opacity-0 group-hover:opacity-100" onClick={(e) => { e.stopPropagation(); deleteCrash(c); }} style={{ color: "var(--text-muted)" }} title="Delete">
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
                <ChevronRight className="w-4 h-4 shrink-0" style={{ color: "var(--text-muted)" }} />
              </div>
            ))}
          </div>
        )}
      </div>
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

  useEffect(() => {
    if (chatLogs.length > 0 && !selected) openFile(chatLogs[0]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatLogs]);

  const visibleLines = search
    ? lines.filter((l) => l.toLowerCase().includes(search.toLowerCase()))
    : lines;

  return (
    <div className="flex flex-col gap-3 h-full">
      <div className="flex items-center gap-2 flex-wrap shrink-0">
        {loading ? (
          <RefreshCw className="w-4 h-4 animate-spin" style={{ color: "var(--text-muted)" }} />
        ) : chatLogs.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>No chat logs yet — captured when RCON is connected</p>
        ) : (
          chatLogs.map((cl) => (
            <button key={cl.filename} onClick={() => openFile(cl)} className="px-2.5 py-1 text-xs rounded-lg transition-all" style={{ background: selected?.filename === cl.filename ? "rgba(var(--neon-purple-rgb),0.12)" : "rgba(0,0,0,0.3)", border: selected?.filename === cl.filename ? "1px solid rgba(var(--neon-purple-rgb),0.3)" : "1px solid rgba(255,255,255,0.06)", color: selected?.filename === cl.filename ? "var(--neon-cyan)" : "var(--text-muted)" }}>
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
          <div className="relative shrink-0">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 pointer-events-none" style={{ color: "var(--text-muted)" }} />
            <Input placeholder="Search chat…" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9 h-8 text-sm" style={{ background: "rgba(0,0,0,0.3)", borderColor: "rgba(var(--neon-purple-rgb),0.2)", color: "var(--text-primary)" }} />
            {search && <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2"><X className="w-3.5 h-3.5" style={{ color: "var(--text-muted)" }} /></button>}
          </div>
          <div className="relative flex-1 min-h-0">
            <div className="h-full overflow-y-auto font-mono text-xs leading-relaxed rounded-xl p-3" style={{ background: "#000008", border: "1px solid rgba(0,255,136,0.1)" }}>
              {loadingFile ? (
                <div className="flex items-center justify-center h-40"><RefreshCw className="w-5 h-5 animate-spin" style={{ color: "var(--text-muted)" }} /></div>
              ) : visibleLines.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-40 gap-2">
                  <MessageSquare className="w-6 h-6" style={{ color: "var(--text-muted)" }} />
                  <p className="text-sm" style={{ color: "var(--text-muted)" }}>{search ? "No lines match" : "No chat messages recorded yet"}</p>
                </div>
              ) : (
                visibleLines.map((l, i) => (
                  <div key={i} className="px-1 py-0.5">
                    <span style={{ color: "#c0ffcc", wordBreak: "break-all" }}>{l}</span>
                  </div>
                ))
              )}
            </div>
          </div>
          <p className="text-xs shrink-0" style={{ color: "var(--text-muted)" }}>
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
    <div className="flex flex-col gap-3 h-full">
      {/* Sub-tab bar */}
      <div
        className="flex gap-1 p-1 rounded-xl flex-wrap shrink-0"
        style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(var(--neon-purple-rgb),0.12)" }}
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
                color: active ? "var(--neon-purple)" : "var(--text-muted)",
                background: active ? "rgba(var(--neon-purple-rgb),0.08)" : "transparent",
                border: active ? "1px solid rgba(var(--neon-purple-rgb),0.25)" : "1px solid transparent",
                fontWeight: active ? 600 : 400,
              }}
            >
              <Icon className="w-3.5 h-3.5 shrink-0" />
              {label}
            </button>
          );
        })}
      </div>

      {/* Active panel — fills remaining height */}
      <div className="flex-1 min-h-0">
        {view === "live"    && <LivePanel    server={server} />}
        {view === "archive" && <ArchivePanel server={server} />}
        {view === "crashes" && <CrashesPanel server={server} />}
        {view === "chat"    && <ChatPanel    server={server} />}
      </div>
    </div>
  );
}
