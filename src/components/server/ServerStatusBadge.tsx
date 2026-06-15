"use client";

export type ServerStatusValue =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "updating"
  | "update_queued"
  | "startup_queued"
  | "error"
  | "crashed"
  | "installing"
  | "install_failed"
  | "start-failed"
  | "detecting";

interface StatusConfig {
  label: string;
  color: string;
  pulse: boolean;
}

const STATUS_MAP: Record<ServerStatusValue, StatusConfig> = {
  running:        { label: "Running",         color: "var(--neon-green)",  pulse: true  },
  starting:       { label: "Starting",        color: "var(--neon-cyan)",   pulse: true  },
  stopping:       { label: "Shutting Down",   color: "#ff6400",            pulse: true  },
  updating:       { label: "Updating",        color: "#ffa500",            pulse: true  },
  update_queued:  { label: "Update Queued",   color: "#ffa500",            pulse: false },
  startup_queued: { label: "Startup Queued",  color: "var(--neon-cyan)",   pulse: false },
  stopped:        { label: "Stopped",         color: "var(--text-muted)",  pulse: false },
  error:          { label: "Error",           color: "var(--neon-red)",    pulse: false },
  crashed:        { label: "Crashed",         color: "var(--neon-red)",    pulse: false },
  installing:     { label: "Installing",      color: "var(--neon-purple)", pulse: true  },
  install_failed: { label: "Install Failed",  color: "var(--neon-red)",    pulse: false },
  "start-failed": { label: "Start Failed",    color: "var(--neon-red)",    pulse: false },
  detecting:      { label: "Detecting...",    color: "var(--text-muted)",  pulse: true  },
};

interface Props {
  status: string;
  /** Render a slightly larger badge. Defaults to false. */
  large?: boolean;
  /** When set, overrides the label with a live countdown string and uses an orange pulsing style. */
  countdownLabel?: string;
}

export function ServerStatusBadge({ status, large = false, countdownLabel }: Props) {
  const cfg = STATUS_MAP[status as ServerStatusValue] ?? STATUS_MAP.stopped;
  const size = large ? "text-sm px-3 py-1" : "text-xs px-2 py-0.5";

  const color = countdownLabel ? "#ff8c00" : cfg.color;
  const pulse = countdownLabel ? true : cfg.pulse;
  const label = countdownLabel ?? cfg.label;

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-semibold tracking-wide ${size}`}
      style={{
        color,
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 35%, transparent)`,
        boxShadow: `0 0 8px color-mix(in srgb, ${color} 25%, transparent)`,
      }}
    >
      {/* Pulsing dot for active states */}
      <span
        className={`inline-block w-1.5 h-1.5 rounded-full ${pulse ? "animate-pulse" : ""}`}
        style={{ background: color }}
      />
      {label}
    </span>
  );
}
