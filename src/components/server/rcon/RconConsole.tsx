"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Terminal, Send, RefreshCw, Trash2, Copy, AlertCircle,
  Users, ShieldX, Shield, ChevronDown, ChevronUp, Clock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { tauriCmd, type RconLogLine, type ArkPlayer, type RconStatusPayload } from "@/lib/tauri-commands";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import type { ServerRow } from "@/lib/db";

interface Props {
  server: ServerRow;
}

// ── Time of day presets ───────────────────────────────────────────────────────
const TIME_PRESETS = [
  { label: "Morning",  time: "06:00:00" },
  { label: "Noon",     time: "12:00:00" },
  { label: "Evening",  time: "18:00:00" },
  { label: "Midnight", time: "00:00:00" },
] as const;

// ServerChat is the only working global message command on ASA.
const SEND_CMD = "ServerChat";

// ── Line color ────────────────────────────────────────────────────────────────
function lineColor(kind: RconLogLine["kind"]): string {
  switch (kind) {
    case "command":  return "var(--neon-cyan)";
    case "response": return "var(--text-primary)";
    case "chat":     return "#ffd700";
    case "error":    return "var(--neon-red)";
    case "system":   return "var(--text-muted)";
  }
}

function fmtTs(ms: number): string {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

// ── Player context-menu actions ───────────────────────────────────────────────
interface PlayerAction {
  label: string;
  cmd: (p: ArkPlayer) => string;
  danger?: boolean;
}

const PLAYER_ACTIONS: PlayerAction[] = [
  { label: "Kick",               cmd: (p) => `kickplayer ${p.playerId}`,            danger: true },
  { label: "Ban",                cmd: (p) => `banplayer ${p.playerId}`,             danger: true },
  { label: "Whitelist",          cmd: (p) => `allowplayertojoinnocheck ${p.playerId}` },
  { label: "Make Tribe Admin",   cmd: (p) => `maketribeadmin ${p.playerId}` },
  { label: "Make Tribe Founder", cmd: (p) => `maketribefounders ${p.playerId}` },
  { label: "Remove Tribe Admin", cmd: (p) => `removetribeadmin ${p.playerId}`,      danger: true },
];

// ── Component ─────────────────────────────────────────────────────────────────
export function RconConsole({ server }: Props) {
  const [connected, setConnected]     = useState(false);
  const [connecting, setConnecting]   = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [lines, setLines]             = useState<RconLogLine[]>([]);
  const [cmdInput, setCmdInput]       = useState("");
  const [msgInput, setMsgInput]       = useState("");
  const [sending, setSending]         = useState(false);
  const [cmdHistory, setCmdHistory]   = useState<string[]>([]);
  const [historyIdx, setHistoryIdx]   = useState(-1);
  const [players, setPlayers]         = useState<ArkPlayer[]>([]);
  const [banList, setBanList]         = useState<string[]>([]);
  const [whitelist, setWhitelist]     = useState<string[]>([]);
  const [banOpen, setBanOpen]         = useState(true);
  const [wlOpen, setWlOpen]           = useState(false);
  const [showTimeMenu, setShowTimeMenu] = useState(false);
  const [selectedPlayer, setSelectedPlayer] = useState<ArkPlayer | null>(null);
  const [playerMenuPos, setPlayerMenuPos]   = useState({ x: 0, y: 0 });

  const logRef      = useRef<HTMLDivElement>(null);
  const cmdInputRef = useRef<HTMLInputElement>(null);
  const timeMenuRef     = useRef<HTMLDivElement>(null);
  const playerMenuRef   = useRef<HTMLDivElement>(null);

  // ── Auto-scroll log ────────────────────────────────────────────────────────
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  // ── Close floating menus on outside click ─────────────────────────────────
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (timeMenuRef.current && !timeMenuRef.current.contains(e.target as Node)) {
        setShowTimeMenu(false);
      }
      if (playerMenuRef.current && !playerMenuRef.current.contains(e.target as Node)) {
        setSelectedPlayer(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // ── Subscribe to backend log events ───────────────────────────────────────
  useTauriEvent<RconLogLine>(`rcon://log/${server.id}`, (line) => {
    setLines((prev) => [...prev.slice(-499), line]);
  });

  // ── Subscribe to player list updates ──────────────────────────────────────
  useTauriEvent<ArkPlayer[]>(`rcon://players/${server.id}`, (list) => {
    setPlayers(list);
  });

  // ── Drive connected/disconnected state from Rust manager events ────────────
  // This is the authoritative source of truth — no more inferring connection
  // state from command errors.
  useTauriEvent<RconStatusPayload>(`rcon://status/${server.id}`, (payload) => {
    if (payload.status === "connected") {
      setConnected(true);
      setError(null);
    } else if (payload.status === "connecting") {
      setConnecting(true);
    } else if (payload.status === "disconnected") {
      setConnected(false);
      setConnecting(false);
      if (payload.error) setError(payload.error);
    }
  });

  // ── Load initial log buffer on mount ──────────────────────────────────────
  useEffect(() => {
    tauriCmd.rconGetLog(server.id).then((buf) => {
      if (buf.length > 0) setLines(buf);
    }).catch(() => null);
  }, [server.id]);

  // ── Load players, ban list, whitelist ────────────────────────────────────
  const refreshPlayers = useCallback(async () => {
    if (!connected) return;
    try {
      const list = await tauriCmd.rconGetPlayers(server.id);
      setPlayers(list);
    } catch { /* connection may have dropped */ }
  }, [connected, server.id]);

  const refreshLists = useCallback(async () => {
    try {
      const [bans, wl] = await Promise.all([
        tauriCmd.rconReadBanList(server.install_path),
        tauriCmd.rconReadWhitelist(server.install_path),
      ]);
      setBanList(bans);
      setWhitelist(wl);
    } catch { /* ignore */ }
  }, [server.install_path]);

  // ── Manual reconnect (user presses "Reconnect" button) ───────────────────
  // RconManager handles auto-connect; this is only needed for the manual button.
  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      await tauriCmd.rconConnect(server.id, "127.0.0.1", server.rcon_port, server.rcon_password);
      // State update comes via rcon://status/{id} event — no need to set here.
    } catch (e) {
      setError(String(e));
      setConnecting(false);
    }
  }, [server.id, server.rcon_port, server.rcon_password]);

  // Sync initial connected state from Rust on mount (covers the case where
  // RconManager already connected before this tab was opened).
  useEffect(() => {
    if (server.status !== "running") {
      setLines([{
        timestampMs: Date.now(),
        text: "Server is not running — start the server to use RCON.",
        kind: "system",
      }]);
      return;
    }
    tauriCmd.rconIsConnected(server.id).then((live) => {
      setConnected(live);
      if (!live) setError(null);
    }).catch(() => null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Seed player list from cache (no RCON command) and load file-based lists once connected.
  // Subsequent updates come from rcon://players/{id} events via RconManager's 30 s tick.
  useEffect(() => {
    if (!connected) return;
    tauriCmd.rconGetCachedPlayers(server.id).then((p) => { if (p !== null) setPlayers(p); }).catch(() => null);
    refreshLists();
  }, [connected]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Send a raw RCON command ───────────────────────────────────────────────
  const sendCommand = useCallback(async (cmd: string) => {
    if (!cmd.trim() || !connected || sending) return;
    const trimmed = cmd.trim();
    setCmdHistory((h) => [trimmed, ...h.slice(0, 49)]);
    setHistoryIdx(-1);
    setCmdInput("");
    setSending(true);
    try {
      await tauriCmd.rconSend(server.id, trimmed);
    } catch {
      // Connection state update comes via rcon://status/{id} event from Rust.
    } finally {
      setSending(false);
      cmdInputRef.current?.focus();
    }
  }, [connected, sending, server.id]);

  const handleCmdKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      sendCommand(cmdInput);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.min(historyIdx + 1, cmdHistory.length - 1);
      setHistoryIdx(next);
      setCmdInput(cmdHistory[next] ?? "");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = Math.max(historyIdx - 1, -1);
      setHistoryIdx(next);
      setCmdInput(next === -1 ? "" : cmdHistory[next] ?? "");
    }
  };

  // ── Send global chat / broadcast ──────────────────────────────────────────
  const sendMessage = useCallback(async () => {
    if (!msgInput.trim() || !connected || sending) return;
    await sendCommand(`${SEND_CMD} ${msgInput.trim()}`);
    setMsgInput("");
  }, [msgInput, connected, sending, sendCommand]);

  // ── Player context menu ───────────────────────────────────────────────────
  const openPlayerMenu = (e: React.MouseEvent, player: ArkPlayer) => {
    e.preventDefault();
    setPlayerMenuPos({ x: e.clientX, y: e.clientY });
    setSelectedPlayer(player);
  };

  const handlePlayerAction = async (action: PlayerAction) => {
    if (!selectedPlayer) return;
    const cmd = action.cmd(selectedPlayer);
    setSelectedPlayer(null);
    await sendCommand(cmd);
    if (action.label === "Ban" || action.label === "Whitelist") {
      setTimeout(refreshLists, 500);
    }
  };

  const copyLog = () => {
    const text = lines.map((l) => `[${fmtTs(l.timestampMs)}] ${l.text}`).join("\n");
    navigator.clipboard.writeText(text).catch(() => null);
  };

  // ── Status labels ─────────────────────────────────────────────────────────
  const statusColor = connected
    ? "var(--neon-green)"
    : error ? "var(--neon-red)"
    : connecting ? "var(--neon-cyan)"
    : "var(--text-muted)";

  const statusLabel = connected
    ? `Connected — 127.0.0.1:${server.rcon_port}`
    : connecting ? "Connecting…"
    : error ? "Disconnected"
    : server.status !== "running" ? "Server not running"
    : "Disconnected";

  // ── Accordion helpers ─────────────────────────────────────────────────────
  const toggleBan = () => { setBanOpen((v) => !v); if (!banOpen) setWlOpen(false); };
  const toggleWl  = () => { setWlOpen((v) => !v);  if (!wlOpen)  setBanOpen(false); };

  const unban = async (id: string) => {
    await sendCommand(`unbanplayer ${id}`);
    setTimeout(refreshLists, 500);
  };

  const unwhitelist = async (id: string) => {
    await sendCommand(`disallowplayertojoinnocheck ${id}`);
    setTimeout(refreshLists, 500);
  };

  // ── Layout ────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-2 overflow-hidden" style={{ height: "100%", minHeight: 0 }}>

      {/* ── Status bar ── */}
      <div
        className="glass-card rounded-xl px-3 py-2 flex items-center gap-3 flex-wrap shrink-0"
        style={{ borderColor: connected ? "rgba(0,255,136,0.3)" : error ? "rgba(255,50,50,0.25)" : "rgba(var(--neon-purple-rgb),0.15)" }}
      >
        <div className="flex items-center gap-2">
          <div
            className="w-2 h-2 rounded-full shrink-0"
            style={{ background: statusColor, boxShadow: (connected || connecting) ? `0 0 6px ${statusColor}` : "none" }}
          />
          <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>{statusLabel}</span>
        </div>
        <div className="flex items-center gap-1.5 ml-auto">
          {!connected && !connecting && server.status === "running" && (
            <Button size="sm" className="btn-neon-green h-7 text-xs" onClick={connect}>
              <RefreshCw className="w-3 h-3 mr-1" /> Reconnect
            </Button>
          )}
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={copyLog} title="Copy log">
            <Copy className="w-3.5 h-3.5" />
          </Button>
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="Clear log"
            onClick={() => { setLines([]); tauriCmd.rconClearLog(server.id).catch(() => null); }}>
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {/* ── Error banner ── */}
      {error && !connected && (
        <div className="rounded-lg px-3 py-2 flex items-center gap-2 text-xs shrink-0"
          style={{ background: "rgba(255,50,50,0.08)", border: "1px solid rgba(255,50,50,0.2)" }}>
          <AlertCircle className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--neon-red)" }} />
          <span style={{ color: "var(--neon-red)" }}>{error}</span>
        </div>
      )}

      {/* ── Main two-column body ── */}
      <div className="flex gap-2 flex-1 min-h-0">

        {/* LEFT — player management */}
        <div className="flex flex-col gap-2 w-52 shrink-0">

          {/* Online players */}
          <div className="glass-card rounded-xl flex flex-col" style={{ border: "1px solid rgba(var(--neon-purple-rgb),0.15)", flex: "1 1 0", minHeight: 0 }}>
            <div className="flex items-center gap-1.5 px-3 py-2 border-b shrink-0" style={{ borderColor: "rgba(var(--neon-purple-rgb),0.1)" }}>
              <Users className="w-3.5 h-3.5" style={{ color: "var(--neon-cyan)" }} />
              <span className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>
                Online ({players.length})
              </span>
              <Button size="sm" variant="ghost" className="h-5 w-5 p-0 ml-auto" title="Refresh" onClick={refreshPlayers}>
                <RefreshCw className="w-3 h-3" style={{ color: "var(--text-muted)" }} />
              </Button>
            </div>
            <div className="overflow-y-auto flex-1 px-2 py-1.5" style={{ minHeight: 0 }}>
              {players.length === 0 ? (
                <p className="text-xs text-center py-2" style={{ color: "var(--text-muted)" }}>No players online</p>
              ) : (
                players.map((p) => (
                  <button
                    key={p.playerId}
                    type="button"
                    className="w-full text-left text-xs px-2 py-1.5 rounded-lg transition-colors hover:bg-white/5 cursor-pointer"
                    style={{ color: "var(--text-primary)" }}
                    onClick={(e) => openPlayerMenu(e, p)}
                    title="Click for actions"
                  >
                    {p.name}
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Banned Players accordion */}
          <div className="glass-card rounded-xl shrink-0" style={{ border: "1px solid rgba(255,50,50,0.15)" }}>
            <button
              type="button"
              className="w-full flex items-center gap-1.5 px-3 py-2"
              onClick={toggleBan}
            >
              <ShieldX className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--neon-red)" }} />
              <span className="text-xs font-semibold flex-1 text-left" style={{ color: "var(--text-primary)" }}>
                Banned ({banList.length})
              </span>
              {banOpen
                ? <ChevronUp className="w-3 h-3" style={{ color: "var(--text-muted)" }} />
                : <ChevronDown className="w-3 h-3" style={{ color: "var(--text-muted)" }} />}
            </button>
            {banOpen && (
              <div className="border-t px-2 pb-2 max-h-32 overflow-y-auto" style={{ borderColor: "rgba(255,50,50,0.1)" }}>
                {banList.length === 0 ? (
                  <p className="text-xs py-1.5 text-center" style={{ color: "var(--text-muted)" }}>No banned players</p>
                ) : banList.map((id) => (
                  <div key={id} className="flex items-center gap-1 py-1">
                    <span className="text-xs font-mono flex-1 truncate" style={{ color: "var(--text-muted)", fontSize: "10px" }}>{id}</span>
                    <button
                      type="button"
                      className="text-xs shrink-0 hover:text-green-400 transition-colors"
                      style={{ color: "var(--neon-green)", fontSize: "10px" }}
                      onClick={() => unban(id)}
                      title="Unban"
                    >
                      Unban
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Whitelist accordion */}
          <div className="glass-card rounded-xl shrink-0" style={{ border: "1px solid rgba(0,255,136,0.15)" }}>
            <button
              type="button"
              className="w-full flex items-center gap-1.5 px-3 py-2"
              onClick={toggleWl}
            >
              <Shield className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--neon-green)" }} />
              <span className="text-xs font-semibold flex-1 text-left" style={{ color: "var(--text-primary)" }}>
                Whitelist ({whitelist.length})
              </span>
              {wlOpen
                ? <ChevronUp className="w-3 h-3" style={{ color: "var(--text-muted)" }} />
                : <ChevronDown className="w-3 h-3" style={{ color: "var(--text-muted)" }} />}
            </button>
            {wlOpen && (
              <div className="border-t px-2 pb-2 max-h-32 overflow-y-auto" style={{ borderColor: "rgba(0,255,136,0.1)" }}>
                {whitelist.length === 0 ? (
                  <p className="text-xs py-1.5 text-center" style={{ color: "var(--text-muted)" }}>Whitelist is empty</p>
                ) : whitelist.map((id) => (
                  <div key={id} className="flex items-center gap-1 py-1">
                    <span className="text-xs font-mono flex-1 truncate" style={{ color: "var(--text-muted)", fontSize: "10px" }}>{id}</span>
                    <button
                      type="button"
                      className="text-xs shrink-0 transition-colors"
                      style={{ color: "var(--neon-red)", fontSize: "10px" }}
                      onClick={() => unwhitelist(id)}
                      title="Remove from whitelist"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* RIGHT — console + controls */}
        <div className="flex flex-col gap-2 flex-1 min-w-0 min-h-0">

          {/* Terminal — fills remaining height, scrolls internally */}
          <div
            ref={logRef}
            className="rounded-xl p-3 overflow-y-auto font-mono text-xs leading-relaxed"
            style={{ background: "#000008", border: "1px solid rgba(var(--neon-purple-rgb),0.1)", flex: "1 1 0", minHeight: 0 }}
          >
            {lines.map((l, i) => (
              <div key={i} className="flex gap-2 items-start mb-0.5">
                <span className="shrink-0 select-none" style={{ color: "var(--text-muted)" }}>{fmtTs(l.timestampMs)}</span>
                <span style={{ color: lineColor(l.kind), wordBreak: "break-all" }}>{l.text}</span>
              </div>
            ))}
            {sending && (
              <div className="flex gap-2 items-center" style={{ color: "var(--text-muted)" }}>
                <Terminal className="w-3 h-3 animate-pulse" />
                <span>Waiting…</span>
              </div>
            )}
          </div>

          {/* Quick actions row */}
          {connected && (
            <div className="flex items-center gap-1.5 flex-wrap shrink-0">
              <Button size="sm" variant="ghost" className="text-xs h-7"
                style={{ color: "var(--neon-cyan)", border: "1px solid rgba(var(--neon-purple-rgb),0.2)", background: "rgba(var(--neon-purple-rgb),0.04)" }}
                onClick={() => sendCommand("saveworld")} disabled={sending}>
                Save World
              </Button>
              <Button size="sm" variant="ghost" className="text-xs h-7"
                style={{ color: "var(--neon-cyan)", border: "1px solid rgba(var(--neon-purple-rgb),0.2)", background: "rgba(var(--neon-purple-rgb),0.04)" }}
                onClick={() => sendCommand("destroywilddinos")} disabled={sending}>
                Wild Dinos
              </Button>

              {/* SetTimeOfDay dropdown */}
              <div className="relative" ref={timeMenuRef}>
                <Button size="sm" variant="ghost" className="text-xs h-7 flex items-center gap-1"
                  style={{ color: "var(--neon-cyan)", border: "1px solid rgba(var(--neon-purple-rgb),0.2)", background: "rgba(var(--neon-purple-rgb),0.04)" }}
                  onClick={() => setShowTimeMenu((v) => !v)} disabled={sending}>
                  <Clock className="w-3 h-3" />
                  Time
                  <ChevronDown className="w-3 h-3" />
                </Button>
                {showTimeMenu && (
                  <div className="absolute top-full left-0 mt-1 z-50 rounded-lg overflow-hidden py-1"
                    style={{ background: "rgba(5,5,16,0.98)", border: "1px solid rgba(var(--neon-purple-rgb),0.2)", minWidth: "110px" }}>
                    {TIME_PRESETS.map((p) => (
                      <button key={p.label} type="button"
                        className="w-full text-left text-xs px-3 py-1.5 hover:bg-white/5 transition-colors"
                        style={{ color: "var(--text-primary)" }}
                        onClick={() => { sendCommand(`settimeofday ${p.time}`); setShowTimeMenu(false); }}>
                        {p.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Global chat input */}
          {connected && (
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="text-xs shrink-0 px-2 py-1.5 rounded-lg"
                style={{ background: "rgba(var(--neon-purple-rgb),0.08)", border: "1px solid rgba(var(--neon-purple-rgb),0.2)", color: "var(--neon-purple)" }}>
                Global Chat
              </span>
              <Input
                className="h-8 text-xs flex-1"
                placeholder="Send message to all players…"
                value={msgInput}
                onChange={(e) => setMsgInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendMessage()}
                disabled={!connected || sending}
                style={{ background: "rgba(0,0,0,0.3)", borderColor: "rgba(var(--neon-purple-rgb),0.25)", color: "var(--text-primary)" }}
              />
              <Button size="sm" className="btn-neon-purple h-8 shrink-0" onClick={sendMessage} disabled={!msgInput.trim() || sending}>
                <Send className="w-3.5 h-3.5" />
              </Button>
            </div>
          )}

          {/* Raw command input */}
          <div className="flex items-center gap-2 shrink-0">
            <span className="font-mono text-sm shrink-0" style={{ color: "var(--neon-cyan)" }}>&gt;</span>
            <Input
              ref={cmdInputRef}
              className="font-mono text-sm h-9 flex-1"
              placeholder={connected ? "RCON command… (↑↓ history)" : "Not connected"}
              value={cmdInput}
              onChange={(e) => { setCmdInput(e.target.value); setHistoryIdx(-1); }}
              onKeyDown={handleCmdKeyDown}
              disabled={!connected || sending}
              style={{ background: "#000010", borderColor: connected ? "rgba(var(--neon-purple-rgb),0.3)" : "rgba(255,255,255,0.1)", color: "var(--text-primary)" }}
            />
            <Button size="sm" className="btn-neon-cyan h-9 shrink-0"
              onClick={() => sendCommand(cmdInput)}
              disabled={!connected || sending || !cmdInput.trim()}>
              <Send className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </div>

      {/* ── Player context menu (floating) ── */}
      {selectedPlayer && (
        <div
          ref={playerMenuRef}
          className="fixed z-50 rounded-xl overflow-hidden py-1 shadow-xl"
          style={{
            left: playerMenuPos.x,
            top: playerMenuPos.y,
            background: "rgba(5,5,16,0.98)",
            border: "1px solid rgba(var(--neon-purple-rgb),0.3)",
            minWidth: "160px",
          }}
        >
          <div className="px-3 py-1.5 border-b" style={{ borderColor: "rgba(var(--neon-purple-rgb),0.15)" }}>
            <p className="text-xs font-semibold" style={{ color: "var(--neon-purple)" }}>{selectedPlayer.name}</p>
            <p className="text-xs font-mono truncate" style={{ color: "var(--text-muted)", fontSize: "10px" }}>{selectedPlayer.playerId}</p>
          </div>
          {PLAYER_ACTIONS.map((action) => (
            <button
              key={action.label}
              type="button"
              className="w-full text-left text-xs px-3 py-1.5 hover:bg-white/5 transition-colors"
              style={{ color: action.danger ? "var(--neon-red)" : "var(--text-primary)" }}
              onClick={() => handlePlayerAction(action)}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
