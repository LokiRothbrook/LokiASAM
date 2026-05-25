"use client";

/**
 * CommandOutputPanel — live terminal-style output panel for long-running commands.
 *
 * Subscribes to a Tauri event channel and appends lines as they arrive.
 * Used during SteamCMD install/update and other long-running operations.
 *
 * Each event payload must match: { line: string; stream: "stdout" | "stderr" }
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { cn } from "@/lib/utils";
import { Terminal, Copy, Check, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";

interface OutputLine {
  id: number;
  text: string;
  stream: "stdout" | "stderr";
  timestamp: Date;
}

interface SteamCmdLinePayload {
  line: string;
  stream: "stdout" | "stderr";
}

export interface CommandOutputPanelProps {
  /** The Tauri event channel to subscribe to, e.g. "steamcmd://output/setup". */
  eventChannel: string;
  /** Human-readable label shown in the panel header. */
  label?: string;
  /** Maximum number of lines to keep in the buffer (oldest are dropped). Default: 500. */
  maxLines?: number;
  /** Whether to start collapsed. Default: false. */
  defaultCollapsed?: boolean;
  /** CSS class name for the outer container. */
  className?: string;
}

let lineIdCounter = 0;

export function CommandOutputPanel({
  eventChannel,
  label = "Output",
  maxLines = 500,
  defaultCollapsed = false,
  className,
}: CommandOutputPanelProps) {
  const [lines, setLines] = useState<OutputLine[]>([]);
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [copied, setCopied] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const startTimeRef = useRef<Date>(new Date());
  const [elapsed, setElapsed] = useState("0s");

  // Subscribe to the Tauri event channel
  const handleLine = useCallback((payload: SteamCmdLinePayload) => {
    setLines((prev) => {
      const next = [
        ...prev,
        {
          id: lineIdCounter++,
          text: payload.line,
          stream: payload.stream,
          timestamp: new Date(),
        },
      ];
      return next.length > maxLines ? next.slice(next.length - maxLines) : next;
    });
  }, [maxLines]);

  useTauriEvent<SteamCmdLinePayload>(eventChannel, handleLine);

  // Auto-scroll to bottom when new lines arrive
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines, autoScroll]);

  // Elapsed time counter
  useEffect(() => {
    startTimeRef.current = new Date();
    const interval = setInterval(() => {
      const secs = Math.floor((Date.now() - startTimeRef.current.getTime()) / 1000);
      if (secs < 60) setElapsed(`${secs}s`);
      else setElapsed(`${Math.floor(secs / 60)}m ${secs % 60}s`);
    }, 1000);
    return () => clearInterval(interval);
  }, [eventChannel]);

  const copyAll = async () => {
    const text = lines.map((l) => l.text).join("\n");
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 40);
  };

  return (
    <div
      className={cn("rounded-lg overflow-hidden border", className)}
      style={{
        background: "var(--terminal-bg)",
        borderColor: "rgba(191,0,255,0.2)",
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-2 border-b"
        style={{ borderColor: "rgba(191,0,255,0.15)", background: "rgba(10,10,30,0.8)" }}
      >
        <div className="flex items-center gap-2">
          <Terminal className="w-3.5 h-3.5" style={{ color: "var(--neon-purple)" }} />
          <span className="text-xs font-mono font-semibold" style={{ color: "var(--neon-purple)" }}>
            {label}
          </span>
          <span className="text-xs font-mono" style={{ color: "var(--text-subtle)" }}>
            {lines.length} lines · {elapsed}
          </span>
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={copyAll}
            className="h-6 px-2 text-xs gap-1"
            style={{ color: "var(--text-muted)" }}
            title="Copy all output"
          >
            {copied ? (
              <Check className="w-3 h-3" style={{ color: "var(--neon-green)" }} />
            ) : (
              <Copy className="w-3 h-3" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setCollapsed((c) => !c)}
            className="h-6 px-2"
            style={{ color: "var(--text-muted)" }}
            title={collapsed ? "Expand" : "Collapse"}
          >
            {collapsed ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronUp className="w-3 h-3" />
            )}
          </Button>
        </div>
      </div>

      {/* Output body */}
      {!collapsed && (
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="h-64 overflow-y-auto p-3 terminal"
          style={{ scrollBehavior: "smooth" }}
        >
          {lines.length === 0 ? (
            <span style={{ color: "var(--text-subtle)" }}>
              Waiting for output...
            </span>
          ) : (
            lines.map((line) => (
              <div key={line.id} className="flex gap-2 leading-relaxed">
                <span className="shrink-0 select-none text-[10px] mt-px" style={{ color: "var(--text-subtle)" }}>
                  {line.timestamp.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                </span>
                <span
                  className="break-all"
                  style={{
                    color: line.stream === "stderr"
                      ? "var(--neon-red)"
                      : "var(--text-primary)",
                  }}
                >
                  {line.text}
                </span>
              </div>
            ))
          )}
        </div>
      )}

      {/* Auto-scroll indicator when not at bottom */}
      {!collapsed && !autoScroll && lines.length > 0 && (
        <div
          className="px-3 py-1 text-center cursor-pointer text-xs border-t"
          style={{
            borderColor: "rgba(191,0,255,0.15)",
            color: "var(--neon-purple)",
            background: "rgba(191,0,255,0.05)",
          }}
          onClick={() => {
            setAutoScroll(true);
            if (scrollRef.current) {
              scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
            }
          }}
        >
          ↓ Scroll to bottom to resume auto-scroll
        </div>
      )}
    </div>
  );
}
