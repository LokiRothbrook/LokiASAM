/**
 * ini-utils.ts — helpers for the section → key → value maps the app stores
 * INI configuration as (GameUserSettings.ini / Game.ini).
 */

export type IniSections = Record<string, Record<string, string>>;

/** The Game.ini section every gameplay setting lives in. */
export const GAME_MODE_SECTION = "/script/shootergame.shootergamemode";
/** ASA reads MaxPlayers from this UE section of GameUserSettings.ini. */
export const GAME_SESSION_SECTION = "/Script/Engine.GameSession";

/** Find the existing section name matching `name`, ignoring case. */
export function findSectionKey(sections: IniSections, name: string): string | undefined {
  const lower = name.toLowerCase();
  return Object.keys(sections).find((k) => k.toLowerCase() === lower);
}

/** Read one value, matching the section name case-insensitively. */
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
 * Copy the identity keys (and the MOTD section) that exist in `from` into
 * `to`, overriding whatever `to` has for them.
 */
export function carryOverIdentity(from: IniSections, to: IniSections): IniSections {
  let out = to;
  for (const { section, key } of IDENTITY_FIELDS) {
    const v = getIni(from, section, key);
    if (v !== undefined) out = setIni(out, section, key, v);
  }
  const motdKey = findSectionKey(from, "MessageOfTheDay");
  if (motdKey) {
    const existing = findSectionKey(out, "MessageOfTheDay");
    out = { ...out };
    if (existing) delete out[existing];
    out[motdKey] = { ...from[motdKey] };
  }
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
