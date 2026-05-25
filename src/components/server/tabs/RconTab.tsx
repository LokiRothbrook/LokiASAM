"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Terminal, Send, Plug, PlugZap, Trash2, Copy,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { tauriCmd } from "@/lib/tauri-commands";
import type { ServerRow } from "@/lib/db";

interface Props {
  server: ServerRow;
}

interface ConsoleLine {
  id: number;
  timestamp: string;
  text: string;
  kind: "command" | "response" | "error" | "system";
}

// Common RCON preset commands for ASA
const PRESETS = [
  { label: "Save World", cmd: "saveworld" },
  { label: "Destroy Wild Dinos", cmd: "cheat destroywilddinos" },
  { label: "List Players", cmd: "listplayers" },
  { label: "Kick All", cmd: "kickall" },
] as const;

function lineColor(kind: ConsoleLine["kind"]): string {
  switch (kind) {
    case "command":  return "var(--neon-cyan)";
    case "response": return "var(--text-primary)";
    case "error":    return "var(--neon-red)";
    case "system":   return "var(--text-muted)";
  }
}

let _lineId = 0;
function mkLine(text: string, kind: ConsoleLine["kind"]): ConsoleLine {
  const now = new Date();
  return {
    id: ++_lineId,
    timestamp: `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}:${now.getSeconds().toString().padStart(2, "0")}`,
    text,
    kind,
  };
}

export function RconTab({ server }: Props) {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [lines, setLines] = useState<ConsoleLine[]>([
    mkLine("RCON console ready. Click Connect to authenticate.", "system"),
  ]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [broadcastMsg, setBroadcastMsg] = useState("");
  const [showBroadcast, setShowBroadcast] = useState(false);

  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const addLine = useCallback((text: string, kind: ConsoleLine["kind"]) => {
    setLines((prev) => [...prev.slice(-499), mkLine(text, kind)]);
  }, []);

  // Auto-scroll to bottom when lines change
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const connect = async () => {
    setConnecting(true);
    try {
      await tauriCmd.rconConnect(server.id, "127.0.0.1", server.rcon_port, server.rcon_password);
      setConnected(true);
      addLine(`Connected to RCON at 127.0.0.1:${server.rcon_port}`, "system");
    } catch (e) {
      addLine(`Connection failed: ${e}`, "error");
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    await tauriCmd.rconDisconnect(server.id).catch(() => null);
    setConnected(false);
    addLine("Disconnected from RCON.", "system");
  };

  const sendCommand = async (cmd: string) => {
    if (!cmd.trim() || !connected || sending) return;
    const trimmed = cmd.trim();
    addLine(`> ${trimmed}`, "command");
    setHistory((h) => [trimmed, ...h.slice(0, 49)]);
    setHistoryIdx(-1);
    setInput("");
    setSending(true);
    try {
      const response = await tauriCmd.rconSend(server.id, trimmed);
      const resp = response.trim();
      if (resp) {
        for (const line of resp.split("\n")) {
          addLine(line, "response");
        }
      } else {
        addLine("(no response)", "system");
      }
    } catch (e) {
      addLine(`Error: ${e}`, "error");
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      sendCommand(input);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.min(historyIdx + 1, history.length - 1);
      setHistoryIdx(next);
      setInput(history[next] ?? "");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = Math.max(historyIdx - 1, -1);
      setHistoryIdx(next);
      setInput(next === -1 ? "" : history[next] ?? "");
    }
  };

  const copyLog = () => {
    const text = lines.map((l) => `[${l.timestamp}] ${l.text}`).join("\n");
    navigator.clipboard.writeText(text).catch(() => null);
  };

  const sendBroadcast = () => {
    if (broadcastMsg.trim()) {
      sendCommand(`broadcast ${broadcastMsg}`);
      setBroadcastMsg("");
      setShowBroadcast(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 h-full">
      {/* ── Connection bar ── */}
      <div
        className="glass-card rounded-xl p-3 flex items-center gap-3 flex-wrap"
        style={{ borderColor: connected ? "rgba(0,255,136,0.3)" : "rgba(191,0,255,0.15)" }}
      >
        <div className="flex items-center gap-2">
          <div
            className="w-2 h-2 rounded-full"
            style={{
              background: connected ? "var(--neon-green)" : connecting ? "var(--neon-cyan)" : "var(--text-muted)",
              boxShadow: connected ? "0 0 6px var(--neon-green)" : connecting ? "0 0 6px var(--neon-cyan)" : "none",
            }}
          />
          <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
            {connected ? `Connected — 127.0.0.1:${server.rcon_port}` : connecting ? "Connecting…" : "Disconnected"}
          </span>
        </div>
        <div className="flex items-center gap-2 ml-auto flex-wrap">
          {!connected ? (
            <Button
              size="sm"
              className="btn-neon-green"
              onClick={connect}
              disabled={connecting || server.status !== "running"}
            >
              <Plug className="w-3.5 h-3.5 mr-1.5" />
              {server.status !== "running" ? "Server not running" : "Connect"}
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={disconnect}>
              <PlugZap className="w-3.5 h-3.5 mr-1.5" />
              Disconnect
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={copyLog} title="Copy log to clipboard">
            <Copy className="w-3.5 h-3.5" />
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setLines([])} title="Clear log">
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {/* ── Preset commands ── */}
      {connected && (
        <div className="flex items-center gap-2 flex-wrap">
          {PRESETS.map((p) => (
            <Button
              key={p.label}
              size="sm"
              variant="ghost"
              className="text-xs h-7"
              style={{
                color: "var(--neon-cyan)",
                border: "1px solid rgba(0,255,255,0.2)",
                background: "rgba(0,255,255,0.04)",
              }}
              onClick={() => sendCommand(p.cmd)}
              disabled={sending}
            >
              {p.label}
            </Button>
          ))}
          <Button
            size="sm"
            variant="ghost"
            className="text-xs h-7"
            style={{
              color: "var(--neon-purple)",
              border: "1px solid rgba(191,0,255,0.2)",
              background: "rgba(191,0,255,0.04)",
            }}
            onClick={() => setShowBroadcast((v) => !v)}
          >
            Broadcast…
          </Button>
        </div>
      )}

      {/* ── Broadcast sub-input ── */}
      {showBroadcast && connected && (
        <div className="flex items-center gap-2">
          <Input
            placeholder="Message to broadcast to all players…"
            value={broadcastMsg}
            onChange={(e) => setBroadcastMsg(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && sendBroadcast()}
            className="h-8 text-sm"
            style={{
              background: "rgba(0,0,0,0.3)",
              borderColor: "rgba(191,0,255,0.3)",
              color: "var(--text-primary)",
            }}
          />
          <Button size="sm" className="btn-neon-purple shrink-0" onClick={sendBroadcast}>
            Send Broadcast
          </Button>
        </div>
      )}

      {/* ── Terminal output ── */}
      <div
        ref={logRef}
        className="flex-1 rounded-xl p-4 overflow-y-auto font-mono text-xs leading-relaxed"
        style={{
          background: "#000008",
          border: "1px solid rgba(0,255,255,0.1)",
          minHeight: "360px",
          maxHeight: "480px",
        }}
      >
        {lines.map((l) => (
          <div key={l.id} className="flex gap-2 items-start mb-0.5">
            <span className="shrink-0 select-none" style={{ color: "var(--text-muted)" }}>
              {l.timestamp}
            </span>
            <span style={{ color: lineColor(l.kind), wordBreak: "break-all" }}>
              {l.text}
            </span>
          </div>
        ))}
        {sending && (
          <div className="flex gap-2 items-center" style={{ color: "var(--text-muted)" }}>
            <Terminal className="w-3 h-3 animate-pulse" />
            <span>Waiting for response…</span>
          </div>
        )}
      </div>

      {/* ── Command input ── */}
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm shrink-0" style={{ color: "var(--neon-cyan)" }}>
          &gt;
        </span>
        <Input
          ref={inputRef}
          className="font-mono text-sm h-9"
          placeholder={connected ? "Enter RCON command… (↑↓ for history)" : "Connect first to send commands"}
          value={input}
          onChange={(e) => { setInput(e.target.value); setHistoryIdx(-1); }}
          onKeyDown={handleKeyDown}
          disabled={!connected || sending}
          style={{
            background: "#000010",
            borderColor: connected ? "rgba(0,255,255,0.3)" : "rgba(255,255,255,0.1)",
            color: "var(--text-primary)",
          }}
        />
        <Button
          size="sm"
          className="btn-neon-cyan shrink-0"
          onClick={() => sendCommand(input)}
          disabled={!connected || sending || !input.trim()}
        >
          <Send className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  );
}
