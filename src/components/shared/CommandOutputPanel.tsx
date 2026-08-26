"use client";

/**
 * CommandOutputPanel — live terminal-style output panel for long-running commands.
 *
 * Subscribes to a Tauri event channel and appends lines as they arrive.
 * Lines are also stored in a module-level buffer so they survive the panel being
 * unmounted (e.g. dialog closed). When the panel re-mounts it reads from the buffer
 * and picks up where it left off.
 *
 * Buffer lifecycle:
 *   - Accumulates as events arrive, regardless of dialog state.
 *   - Cleared on unmount only when both `clearBufferOnClose` is true AND the
 *     process had completed (via the `completed` prop) — by default neither
 *     condition clears it, so callers that want cleanup must opt in.
 *   - Callers may also clear a channel directly via `clearOutputBuffer(channel)`
 *     at any point they know is safe (e.g. ServerCard does this once a
 *     card — and thus its association with the channel — goes away).
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

// ── Module-level log buffer ───────────────────────────────────────────────────
// Persists output across panel mount/unmount cycles.

let lineIdCounter = 0;

const _buffers = new Map<string, OutputLine[]>();

function bufferAdd(channel: string, line: OutputLine, maxLines: number): void {
  const buf = _buffers.get(channel) ?? [];
  buf.push(line);
  if (buf.length > maxLines) buf.splice(0, buf.length - maxLines);
  _buffers.set(channel, buf);
}

export function clearOutputBuffer(channel: string): void {
  _buffers.delete(channel);
}

export function hasOutputBuffer(channel: string): boolean {
  return (_buffers.get(channel)?.length ?? 0) > 0;
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
  /** Tailwind height class for the scrollable output body. Default: "h-64". */
  bodyClassName?: string;
  /** Set to true once the process finishes. Stops the timer and shows "Completed in: Xs". */
  completed?: boolean;
  /** Set to true when the operation was explicitly canceled. Shows "Install Canceled" instead. */
  canceled?: boolean;
  /**
   * When true, clears the channel buffer on unmount only if the process is complete.
   * Use this for dialogs that should "forget" the log after the user dismisses them.
   * Default: false (wizard-embedded panels keep the buffer alive for the session).
   */
  clearBufferOnClose?: boolean;
}

export function CommandOutputPanel({
  eventChannel,
  label = "Output",
  maxLines = 500,
  defaultCollapsed = false,
  className,
  bodyClassName,
  completed = false,
  canceled = false,
  clearBufferOnClose = false,
}: CommandOutputPanelProps) {
  const [lines, setLines] = useState<OutputLine[]>(() => [...(_buffers.get(eventChannel) ?? [])]);
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [copied, setCopied] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const startTimeRef = useRef<Date>(new Date());
  const [elapsed, setElapsed] = useState("0s");
  const [finalElapsed, setFinalElapsed] = useState<string | null>(null);
  const completedRef = useRef(false);
  const completedProp = useRef(completed);

  // Keep ref in sync for the cleanup function — synced in its own effect
  // (runs after every render) rather than during render itself.
  useEffect(() => {
    completedProp.current = completed;
  });

  // On mount (or channel change): scroll to bottom if there are already
  // lines from the buffer.
  useEffect(() => {
    if (scrollRef.current && (_buffers.get(eventChannel)?.length ?? 0) > 0) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [eventChannel]);

  // On unmount: clear buffer if process is done (or clearBufferOnClose is set)
  useEffect(() => {
    return () => {
      if (clearBufferOnClose && completedProp.current) {
        clearOutputBuffer(eventChannel);
      }
    };
  }, [eventChannel, clearBufferOnClose]);

  // Subscribe to the Tauri event channel
  const handleLine = useCallback((payload: SteamCmdLinePayload) => {
    const line: OutputLine = {
      id: lineIdCounter++,
      text: payload.line,
      stream: payload.stream,
      timestamp: new Date(),
    };
    bufferAdd(eventChannel, line, maxLines);
    setLines((prev) => {
      const next = [...prev, line];
      return next.length > maxLines ? next.slice(next.length - maxLines) : next;
    });
  }, [eventChannel, maxLines]);

  useTauriEvent<SteamCmdLinePayload>(eventChannel, handleLine);

  // Auto-scroll to bottom when new lines arrive (instant, not smooth)
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines, autoScroll]);

  // Elapsed time counter — resets when the event channel changes. The
  // display resets (finalElapsed/elapsed) are compared during render rather
  // than set synchronously at the top of the effect below.
  const [prevEventChannel, setPrevEventChannel] = useState(eventChannel);
  if (eventChannel !== prevEventChannel) {
    setPrevEventChannel(eventChannel);
    setFinalElapsed(null);
    setElapsed("0s");
  }

  useEffect(() => {
    startTimeRef.current = new Date();
    completedRef.current = false;

    const interval = setInterval(() => {
      if (completedRef.current) {
        clearInterval(interval);
        return;
      }
      const secs = Math.floor((Date.now() - startTimeRef.current.getTime()) / 1000);
      setElapsed(secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`);
    }, 1000);

    return () => clearInterval(interval);
  }, [eventChannel]);

  // Stop the timer when the parent signals the process is done.
  useEffect(() => {
    if (completed && !completedRef.current) {
      completedRef.current = true;
      const secs = Math.floor((Date.now() - startTimeRef.current.getTime()) / 1000);
      setFinalElapsed(secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`);
    }
  }, [completed]);

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
        borderColor: "rgba(var(--neon-purple-rgb),0.2)",
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-2 border-b"
        style={{ borderColor: "rgba(var(--neon-purple-rgb),0.15)", background: "var(--surface-elevated)" }}
      >
        <div className="flex items-center gap-2">
          <Terminal className="w-3.5 h-3.5" style={{ color: "var(--neon-purple)" }} />
          <span className="text-xs font-mono font-semibold" style={{ color: "var(--neon-purple)" }}>
            {label}
          </span>
          <span className="text-xs font-mono" style={{ color: canceled ? "var(--neon-red)" : finalElapsed ? "var(--neon-green)" : "var(--text-subtle)" }}>
            {lines.length} lines · {canceled ? "Install Canceled" : finalElapsed ? `Completed in: ${finalElapsed}` : elapsed}
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
          className={cn("overflow-y-auto p-3 terminal", bodyClassName ?? "h-64")}
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
            borderColor: "rgba(var(--neon-purple-rgb),0.15)",
            color: "var(--neon-purple)",
            background: "rgba(var(--neon-purple-rgb),0.05)",
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
