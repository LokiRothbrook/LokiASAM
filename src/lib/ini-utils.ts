/**
 * ini-utils.ts — helpers for the section → key → value maps the app stores
 * INI configuration as (GameUserSettings.ini / Game.ini).
 */

export type IniSections = Record<string, Record<string, string>>;

/**
 * Repeated keys: Game.ini relies on keys that appear on several lines
 * (OverridePlayerLevelEngramPoints, OverrideNamedEngramEntries,
 * ConfigOverrideItemMaxQuantity, …). The app keeps them as ONE value with
 * the lines joined by "\n" — a real INI value can't contain a newline — and
 * writes them back out as one line each. The Rust side (config.rs) uses the
 * same encoding.
 */
export const REPEAT_SEP = "\n";

/** Parse INI text into sections; repeated keys are joined with REPEAT_SEP. */
export function parseIniText(text: string): IniSections {
  const result: IniSections = {};
  let current = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      current = line.slice(1, -1);
      result[current] = result[current] ?? {};
    } else if (current && line.includes("=")) {
      const eq = line.indexOf("=");
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1);
      if (!key) continue;
      const prev = result[current][key];
      result[current][key] = prev === undefined ? value : `${prev}${REPEAT_SEP}${value}`;
    }
  }
  return result;
}

/** Turn sections back into INI text, one line per repeated value. */
export function iniToText(sections: IniSections): string {
  return Object.entries(sections)
    .map(([section, kvs]) => {
      const lines = Object.entries(kvs).flatMap(([k, v]) =>
        String(v).split(REPEAT_SEP).map((part) => `${k}=${part}`),
      );
      return `[${section}]\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

/** The Game.ini section every gameplay setting lives in. */
export const GAME_MODE_SECTION = "/script/shootergame.shootergamemode";
/** ASA reads MaxPlayers from this UE section of GameUserSettings.ini. */
export const GAME_SESSION_SECTION = "/Script/Engine.GameSession";

/** Find the existing section name matching `name`, ignoring case. */
export function findSectionKey(sections: IniSections, name: string): string | undefined {
  const lower = name.toLowerCase();
  return Object.keys(sections).find((k) => k.toLowerCase() === lower);
}

/** Read one value, matching the section name case-insensitively. A repeated
 *  key returns all its lines joined with REPEAT_SEP. */
export function getIni(sections: IniSections | undefined | null, section: string, key: string): string | undefined {
  if (!sections) return undefined;
  const sec = findSectionKey(sections, section);
  return sec ? sections[sec]?.[key] : undefined;
}

/** Return a copy of `sections` with one value set (section matched case-insensitively). */
export function setIni(sections: IniSections, section: string, key: string, value: string): IniSections {
  const sec = findSectionKey(sections, section) ?? section;
  return { ...sections, [sec]: { ...(sections[sec] ?? {}), [key]: value } };
}

/** Return a copy of `sections` with one key removed (and its section, if left empty). */
export function deleteIni(sections: IniSections, section: string, key: string): IniSections {
  const sec = findSectionKey(sections, section);
  if (!sec || !(key in (sections[sec] ?? {}))) return sections;
  const rest = { ...sections[sec] };
  delete rest[key];
  const out = { ...sections, [sec]: rest };
  if (Object.keys(rest).length === 0) delete out[sec];
  return out;
}

/**
 * Merge `overlay` into `base` key by key. Sections present in both are
 * combined (overlay wins per key) instead of the overlay's section replacing
 * the base section wholesale — a whole-section replace silently dropped every
 * base key the overlay didn't mention (admin password, RCON settings, …).
 */
export function mergeIniSections(base: IniSections, overlay: IniSections): IniSections {
  const out: IniSections = {};
  for (const [sec, kv] of Object.entries(base)) out[sec] = { ...kv };
  for (const [sec, kv] of Object.entries(overlay)) {
    const target = findSectionKey(out, sec) ?? sec;
    out[target] = { ...(out[target] ?? {}), ...kv };
  }
  return out;
}

/** True for INI booleans regardless of case ("True", "true", "1"). */
export function isIniTrue(value: string | undefined | null): boolean {
  return value != null && /^(true|1)$/i.test(value.trim());
}

/**
 * Keys that describe the server itself rather than gameplay. They're owned by
 * the Server Identity card (and mirrored in the servers DB row), so presets
 * and imports must never overwrite them.
 */
export const IDENTITY_FIELDS: { section: string; key: string }[] = [
  { section: "SessionSettings", key: "SessionName" },
  { section: "ServerSettings", key: "ServerPassword" },
  { section: "ServerSettings", key: "ServerAdminPassword" },
  { section: "ServerSettings", key: "RCONEnabled" },
  { section: "ServerSettings", key: "RCONPort" },
  { section: GAME_SESSION_SECTION, key: "MaxPlayers" },
];

export function isIdentityKey(section: string, key: string): boolean {
  return IDENTITY_FIELDS.some(
    (f) => f.section.toLowerCase() === section.toLowerCase() && f.key === key,
  );
}

/**
 * Make `to`'s identity keys and MOTD exactly `from`'s: keys `from` has are
 * copied over, and keys `from` lacks are REMOVED from `to` — otherwise a
 * server with no join password or no MOTD would pick up the other config's.
 * Callers should pass a `from` with the required keys filled in (see
 * ConfigTab's ownIdentity), so nothing essential is dropped.
 */
export function carryOverIdentity(from: IniSections, to: IniSections): IniSections {
  let out = to;
  for (const { section, key } of IDENTITY_FIELDS) {
    const v = getIni(from, section, key);
    out = v !== undefined ? setIni(out, section, key, v) : deleteIni(out, section, key);
  }
  // Legacy copy of the join password in the wrong section.
  out = deleteIni(out, "SessionSettings", "ServerPassword");
  const existing = findSectionKey(out, "MessageOfTheDay");
  if (existing) {
    out = { ...out };
    delete out[existing];
  }
  const motdKey = findSectionKey(from, "MessageOfTheDay");
  if (motdKey) out = { ...out, [motdKey]: { ...from[motdKey] } };
  return out;
}

/** A single key-level difference between two configs. */
export interface IniDiffEntry {
  file: "gus" | "game";
  section: string;
  key: string;
  before: string | undefined;
  after: string | undefined;
}

/** List every key that differs between `before` and `after` (sections matched case-insensitively). */
export function diffIniSections(file: "gus" | "game", before: IniSections, after: IniSections): IniDiffEntry[] {
  const entries: IniDiffEntry[] = [];
  const sections = new Map<string, string>();
  for (const s of [...Object.keys(before), ...Object.keys(after)]) {
    if (!sections.has(s.toLowerCase())) sections.set(s.toLowerCase(), s);
  }
  for (const display of sections.values()) {
    const b = before[findSectionKey(before, display) ?? ""] ?? {};
    const a = after[findSectionKey(after, display) ?? ""] ?? {};
    for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
      if (b[key] !== a[key]) entries.push({ file, section: display, key, before: b[key], after: a[key] });
    }
  }
  return entries;
}
