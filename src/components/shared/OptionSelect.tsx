"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

/** Radix Select can't use "" as an item value; options store "" for "omit / default". */
const EMPTY = "__empty__";

/**
 * Themed dropdown for a fixed list of string options where "" is a valid
 * value (e.g. a launch parameter's "game default"). Replaces native <select>
 * elements, whose OS-drawn popup ignores the app theme.
 */
export function OptionSelect({
  value,
  options,
  onChange,
  placeholder,
  className,
  size = "default",
  disabled,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  size?: "sm" | "default";
  disabled?: boolean;
}) {
  // "" maps to the sentinel only when it's a real option; otherwise it means
  // "nothing selected" and Radix needs "" to show the placeholder.
  const hasEmptyOption = options.some((o) => o.value === "");
  return (
    <Select
      value={value === "" && hasEmptyOption ? EMPTY : value}
      onValueChange={(v) => onChange(v === EMPTY ? "" : v)}
      disabled={disabled}
    >
      <SelectTrigger size={size} className={cn("w-full text-xs", className)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value || EMPTY} value={o.value === "" ? EMPTY : o.value} className="text-xs">
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
