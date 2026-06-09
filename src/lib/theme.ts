/**
 * theme.ts — accent color + theme preset switching via CSS custom property overrides.
 */

export type ThemeAccent =
  | "purple" | "cyan" | "green" | "pink"
  | "orange" | "red"  | "blue"  | "teal" | "yellow";

export type ThemePreset = "neon" | "abyss" | "toxic" | "storm";

interface AccentTokens {
  hex:         string;
  r: number; g: number; b: number;
}

export const ACCENT_OPTIONS: { value: ThemeAccent; label: string }[] = [
  { value: "purple", label: "Purple"  },
  { value: "cyan",   label: "Cyan"    },
  { value: "green",  label: "Green"   },
  { value: "pink",   label: "Pink"    },
  { value: "orange", label: "Orange"  },
  { value: "red",    label: "Red"     },
  { value: "blue",   label: "Blue"    },
  { value: "teal",   label: "Teal"    },
  { value: "yellow", label: "Yellow"  },
];

const ACCENT_TOKENS: Record<ThemeAccent, AccentTokens> = {
  purple: { hex: "#bf00ff", r: 191, g:   0, b: 255 },
  cyan:   { hex: "#00ffff", r:   0, g: 255, b: 255 },
  green:  { hex: "#00ff88", r:   0, g: 255, b: 136 },
  pink:   { hex: "#ff0080", r: 255, g:   0, b: 128 },
  orange: { hex: "#ff8800", r: 255, g: 136, b:   0 },
  red:    { hex: "#ff0055", r: 255, g:   0, b:  85 },
  blue:   { hex: "#4080ff", r:  64, g: 128, b: 255 },
  teal:   { hex: "#00ffc8", r:   0, g: 255, b: 200 },
  yellow: { hex: "#ffdc00", r: 255, g: 220, b:   0 },
};

interface PresetTokens {
  label:       string;
  background:  string;
  surface:     string;
  surfaceEl:   string;
  glassBg:     string;
  textMuted:   string;
  textSubtle:  string;
  defaultAccent: ThemeAccent;
}

export const THEME_PRESETS: Record<ThemePreset, PresetTokens> = {
  neon: {
    label:        "Neon",
    background:   "#050510",
    surface:      "rgba(20, 20, 52, 0.85)",
    surfaceEl:    "rgba(28, 28, 68, 0.92)",
    glassBg:      "rgba(18, 18, 50, 0.72)",
    textMuted:    "#5858a0",
    textSubtle:   "#3a3a70",
    defaultAccent: "purple",
  },
  abyss: {
    label:        "Abyss",
    background:   "#050814",
    surface:      "rgba(5, 12, 25, 0.75)",
    surfaceEl:    "rgba(8, 16, 35, 0.9)",
    glassBg:      "rgba(5, 12, 30, 0.6)",
    textMuted:    "#384060",
    textSubtle:   "#263040",
    defaultAccent: "blue",
  },
  toxic: {
    label:        "Toxic",
    background:   "#060d06",
    surface:      "rgba(8, 18, 8, 0.75)",
    surfaceEl:    "rgba(10, 24, 10, 0.9)",
    glassBg:      "rgba(8, 18, 8, 0.6)",
    textMuted:    "#3a5040",
    textSubtle:   "#283530",
    defaultAccent: "green",
  },
  storm: {
    label:        "Storm",
    background:   "#0e1018",
    surface:      "rgba(18, 22, 35, 0.8)",
    surfaceEl:    "rgba(24, 28, 44, 0.9)",
    glassBg:      "rgba(18, 22, 38, 0.65)",
    textMuted:    "#606880",
    textSubtle:   "#464e64",
    defaultAccent: "cyan",
  },
};

/** Apply (or reset) the accent color by overriding CSS custom properties on :root. */
export function applyThemeAccent(accent: string): void {
  if (typeof document === "undefined") return;
  const t = ACCENT_TOKENS[(accent as ThemeAccent)] ?? ACCENT_TOKENS.purple;
  const { r, g, b, hex } = t;
  const root = document.documentElement;

  // RGB components variable — used by rgba(var(--neon-purple-rgb), alpha) throughout globals.css
  root.style.setProperty("--neon-purple-rgb", `${r},${g},${b}`);
  root.style.setProperty("--neon-purple",   hex);
  root.style.setProperty("--border",        `rgba(${r},${g},${b},0.15)`);
  root.style.setProperty("--border-hover",  `rgba(${r},${g},${b},0.4)`);
  root.style.setProperty("--glass-border",  `rgba(${r},${g},${b},0.12)`);
  root.style.setProperty("--glow-purple",   `0 0 8px rgba(${r},${g},${b},0.6), 0 0 24px rgba(${r},${g},${b},0.2)`);
  root.style.setProperty("--accent",        `rgba(${r},${g},${b},0.15)`);
  // Drive shadcn Switch checked state + focus rings
  root.style.setProperty("--color-primary", hex);
  root.style.setProperty("--color-ring",    hex);
  root.style.setProperty("--color-input",   `rgba(${r},${g},${b},0.2)`);
  root.dataset.accent = accent;
}

/** Apply a theme preset (background/surface palette). Does NOT change the accent color. */
export function applyThemePreset(preset: string): void {
  if (typeof document === "undefined") return;
  const p = THEME_PRESETS[(preset as ThemePreset)] ?? THEME_PRESETS.neon;
  const root = document.documentElement;
  root.style.setProperty("--background",        p.background);
  root.style.setProperty("--surface",           p.surface);
  root.style.setProperty("--surface-elevated",  p.surfaceEl);
  root.style.setProperty("--glass-bg",          p.glassBg);
  root.style.setProperty("--text-muted",        p.textMuted);
  root.style.setProperty("--text-subtle",       p.textSubtle);
  root.dataset.preset = preset;
}

/** Apply both preset and accent together. */
export function applyTheme(preset: string, accent: string): void {
  applyThemePreset(preset);
  applyThemeAccent(accent);
}
