/**
 * theme.ts — accent color switching via CSS custom property overrides.
 *
 * The app defaults to purple as the primary accent. Calling applyThemeAccent()
 * remaps --neon-purple (and its related glow/border variables) to the chosen
 * color so every component picks it up automatically.
 */

export type ThemeAccent = "purple" | "cyan" | "green";

interface AccentTokens {
  neonPurple:  string;
  border:      string;
  borderHover: string;
  glassBorder: string;
  glowPurple:  string;
  accent:      string;
  scrollThumb: string;
  scrollHover: string;
}

const ACCENT_TOKENS: Record<ThemeAccent, AccentTokens> = {
  purple: {
    neonPurple:  "#bf00ff",
    border:      "rgba(191,0,255,0.15)",
    borderHover: "rgba(191,0,255,0.4)",
    glassBorder: "rgba(191,0,255,0.12)",
    glowPurple:  "0 0 8px rgba(191,0,255,0.6), 0 0 24px rgba(191,0,255,0.2)",
    accent:      "rgba(191,0,255,0.15)",
    scrollThumb: "rgba(191,0,255,0.2)",
    scrollHover: "rgba(191,0,255,0.4)",
  },
  cyan: {
    neonPurple:  "#00ffff",
    border:      "rgba(0,255,255,0.15)",
    borderHover: "rgba(0,255,255,0.4)",
    glassBorder: "rgba(0,255,255,0.12)",
    glowPurple:  "0 0 8px rgba(0,255,255,0.6), 0 0 24px rgba(0,255,255,0.2)",
    accent:      "rgba(0,255,255,0.15)",
    scrollThumb: "rgba(0,255,255,0.2)",
    scrollHover: "rgba(0,255,255,0.4)",
  },
  green: {
    neonPurple:  "#00ff88",
    border:      "rgba(0,255,136,0.15)",
    borderHover: "rgba(0,255,136,0.4)",
    glassBorder: "rgba(0,255,136,0.12)",
    glowPurple:  "0 0 8px rgba(0,255,136,0.6), 0 0 24px rgba(0,255,136,0.2)",
    accent:      "rgba(0,255,136,0.15)",
    scrollThumb: "rgba(0,255,136,0.2)",
    scrollHover: "rgba(0,255,136,0.4)",
  },
};

/** Apply (or reset) the accent color by overriding CSS custom properties on :root. */
export function applyThemeAccent(accent: string): void {
  if (typeof document === "undefined") return;

  const tokens = ACCENT_TOKENS[(accent as ThemeAccent)] ?? ACCENT_TOKENS.purple;
  const root = document.documentElement;

  root.style.setProperty("--neon-purple",  tokens.neonPurple);
  root.style.setProperty("--border",       tokens.border);
  root.style.setProperty("--border-hover", tokens.borderHover);
  root.style.setProperty("--glass-border", tokens.glassBorder);
  root.style.setProperty("--glow-purple",  tokens.glowPurple);
  root.style.setProperty("--accent",       tokens.accent);

  // Store on the element so Settings page can read it without hitting the DB.
  root.dataset.accent = accent;
}
