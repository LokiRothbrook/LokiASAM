"use client";

/**
 * HiddenWindowCard — the per-server "Hide Server Window" toggle, plus what
 * makes it work on this machine: the native flag on Windows, or an invisible
 * X display on Linux (Xvfb preferred, headless gamescope as a fallback), with
 * install help when neither is present.
 */

import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ToggleLeft, ToggleRight, Copy, Download, RefreshCw, Loader2, CheckCircle2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useOnMount } from "@/hooks/useOnMount";
import { setServerHideWindow, type ServerRow } from "@/lib/db";
import { tauriCmd, type HiddenWindowSupport } from "@/lib/tauri-commands";

const BACKEND_LABEL: Record<string, string> = {
  native: "Hidden with the Windows no-console flag.",
  xvfb: "Using Xvfb — a lightweight invisible display.",
  gamescope: "Using gamescope's headless mode — works fine. Xvfb is lighter and more robust (no GPU involved) if you'd like to install it.",
};

/** Detect the hidden-window backend and offer Xvfb install help. */
export function useHiddenWindowSupport() {
  const [support, setSupport] = useState<HiddenWindowSupport | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);

  const check = useCallback(async () => {
    setChecking(true);
    try { setSupport(await tauriCmd.getHiddenWindowSupport()); }
    catch (e) { toast.error(`Couldn't check hidden-window support: ${e}`); }
    finally { setChecking(false); }
  }, []);
  useOnMount(check);

  const install = async () => {
    setInstalling(true);
    try {
      await tauriCmd.installXvfb();
      toast.success("Xvfb installed. Hidden servers use it from their next start once none are running on the current display.");
      await check();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setInstalling(false);
    }
  };

  return { support, checking, installing, check, install, available: support?.backend != null };
}

/**
 * Which backend hides the window here, and — unless Xvfb is already in use —
 * the Xvfb install command with Copy / Install / Check again. Shared by the
 * server's Config tab and the creation wizard.
 */
export function HiddenWindowStatus({
  state,
  hideRequested,
}: {
  state: ReturnType<typeof useHiddenWindowSupport>;
  /** The toggle is on — mention the visible fallback when nothing is installed. */
  hideRequested: boolean;
}) {
  const { support, checking, installing, check, install, available } = state;
  if (!support) return null;

  const copyCommand = async () => {
    if (!support.installCommand) return;
    try { await writeText(support.installCommand); toast.success("Command copied."); }
    catch { toast.error("Couldn't copy to the clipboard."); }
  };

  // Install help: always when nothing works; as an upgrade when on gamescope.
  const showInstall = support.backend === null || support.backend === "gamescope";

  return (
    <div className="space-y-2 text-xs">
      {available ? (
        <p className="flex items-start gap-1.5" style={{ color: "var(--text-muted)" }}>
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: "var(--neon-green)" }} />
          {BACKEND_LABEL[support.backend!]}
        </p>
      ) : (
        <p className="flex items-start gap-1.5" style={{ color: "var(--text-primary)" }}>
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: "var(--neon-orange)" }} />
          <span>
            Hiding the window on Linux needs an invisible display program: <strong>Xvfb</strong> (recommended) or gamescope.
            Neither is installed{support.distro ? ` on ${support.distro}` : ""}.
            {hideRequested && " Until one is installed, the server starts with its window visible."}
          </span>
        </p>
      )}

      {showInstall && (
        <div className="rounded-lg p-3 space-y-2"
          style={available
            ? { background: "rgba(var(--neon-purple-rgb),0.04)", border: "1px solid rgba(var(--neon-purple-rgb),0.15)" }
            : { background: "rgba(var(--neon-orange-rgb),0.06)", border: "1px solid rgba(var(--neon-orange-rgb),0.2)" }}>
          {support.installCommand && (
            <div className="flex items-center gap-2">
              <code className="flex-1 min-w-0 truncate rounded px-2 py-1.5 font-mono"
                style={{ background: "var(--terminal-bg)", color: "var(--terminal-fg)" }}
                title={support.installCommand}>
                {support.installCommand}
              </code>
              <Button size="sm" variant="outline" onClick={copyCommand} title="Copy command"
                style={{ borderColor: "rgba(var(--neon-purple-rgb),0.35)", color: "var(--neon-purple)" }}>
                <Copy className="w-3.5 h-3.5" />
              </Button>
            </div>
          )}
          {support.installNote && <p style={{ color: "var(--text-muted)" }}>{support.installNote}</p>}
          <div className="flex gap-2">
            {support.canAutoInstall && (
              <Button size="sm" className="btn-neon-purple" onClick={install} disabled={installing}>
                {installing ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Download className="w-3.5 h-3.5 mr-1.5" />}
                {installing ? "Installing…" : "Install Xvfb"}
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={check} disabled={checking}
              style={{ borderColor: "rgba(var(--neon-purple-rgb),0.3)", color: "var(--text-muted)" }}>
              <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${checking ? "animate-spin" : ""}`} />
              Check again
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function HiddenWindowCard({ server }: { server: ServerRow }) {
  const queryClient = useQueryClient();
  const state = useHiddenWindowSupport();
  const [saving, setSaving] = useState(false);
  const on = server.hide_window === 1;

  const toggle = async () => {
    setSaving(true);
    try {
      await setServerHideWindow(server.id, !on);
      queryClient.invalidateQueries({ queryKey: ["servers"] });
    } catch (e) { toast.error(`Failed: ${e}`); }
    finally { setSaving(false); }
  };

  return (
    <div className="glass-card rounded-xl p-4 space-y-3" style={{ border: "1px solid rgba(var(--neon-orange-rgb),0.2)" }}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Hide Server Window</h3>
          <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
            Run the server without its console window. Logs, RCON and stop/restart work as normal. Applies on the next start.
            If a hidden server hits a startup error (like a failed mod download) the app closes it so the usual automatic retry runs.
          </p>
        </div>
        <button
          type="button"
          onClick={toggle}
          // Can always be turned off; turning on needs a working backend.
          disabled={saving || (!on && !state.available)}
          className="shrink-0 flex items-center focus:outline-none disabled:opacity-40"
          aria-label={on ? "Show server window" : "Hide server window"}
        >
          {on
            ? <ToggleRight className="w-8 h-8" style={{ color: "var(--neon-purple)" }} />
            : <ToggleLeft className="w-8 h-8" style={{ color: "var(--text-subtle)" }} />}
        </button>
      </div>
      <HiddenWindowStatus state={state} hideRequested={on} />
    </div>
  );
}
