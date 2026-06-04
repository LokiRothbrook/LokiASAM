"use client";

export type ServerStatusValue =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "updating"
  | "error"
  | "crashed"
  | "installing"
  | "install_failed"
  | "start-failed";

interface StatusConfig {
  label: string;
  color: string;
  pulse: boolean;
}

const STATUS_MAP: Record<ServerStatusValue, StatusConfig> = {
  running:        { label: "Running",         color: "var(--neon-green)",  pulse: true  },
  starting:       { label: "Starting",        color: "var(--neon-cyan)",   pulse: true  },
  stopping:       { label: "Shutting Down",   color: "#ff6400",            pulse: true  },
  updating:       { label: "Updating",        color: "var(--neon-cyan)",   pulse: true  },
  stopped:        { label: "Stopped",         color: "var(--text-muted)",  pulse: false },
  error:          { label: "Error",           color: "var(--neon-red)",    pulse: false },
  crashed:        { label: "Crashed",         color: "var(--neon-red)",    pulse: false },
  installing:     { label: "Installing",      color: "var(--neon-purple)", pulse: true  },
  install_failed: { label: "Install Failed",  color: "var(--neon-red)",    pulse: false },
  "start-failed": { label: "Start Failed",    color: "var(--neon-red)",    pulse: false },
};

interface Props {
  status: string;
  /** Render a slightly larger badge. Defaults to false. */
  large?: boolean;
}

export function ServerStatusBadge({ status, large = false }: Props) {
  const cfg = STATUS_MAP[status as ServerStatusValue] ?? STATUS_MAP.stopped;
  const size = large ? "text-sm px-3 py-1" : "text-xs px-2 py-0.5";

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-semibold tracking-wide ${size}`}
      style={{
        color: cfg.color,
        background: `color-mix(in srgb, ${cfg.color} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${cfg.color} 35%, transparent)`,
        boxShadow: `0 0 8px color-mix(in srgb, ${cfg.color} 25%, transparent)`,
      }}
    >
      {/* Pulsing dot for active states */}
      <span
        className={`inline-block w-1.5 h-1.5 rounded-full ${cfg.pulse ? "animate-pulse" : ""}`}
        style={{ background: cfg.color }}
      />
      {cfg.label}
    </span>
  );
}
