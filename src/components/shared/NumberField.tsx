"use client";

/**
 * NumberField — a slider + numeric input combo for server config settings.
 *
 * The slider is clamped to [min, max] (the "safe" range).
 * The text input is unconstrained, letting admins override beyond safe limits.
 * Colored dots with labels are shown above the track at 0 and at defaultValue.
 */

import { useState, useRef, useEffect } from "react";
import { Slider } from "@/components/ui/slider";

interface Props {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  defaultValue?: number;
}

export function NumberField({ value, onChange, min, max, step = 0.1, defaultValue }: Props) {
  const [raw, setRaw] = useState(String(value));
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep the text box in sync when value changes externally (slider drag)
  useEffect(() => {
    if (document.activeElement !== inputRef.current) {
      setRaw(String(value));
    }
  }, [value]);

  const sliderValue = Math.min(Math.max(value, min), max);

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    setRaw(e.target.value);
    const n = parseFloat(e.target.value);
    if (!isNaN(n)) onChange(n);
  }

  function handleInputBlur() {
    const n = parseFloat(raw);
    if (isNaN(n)) {
      setRaw(String(value));
    } else {
      setRaw(String(n));
      onChange(n);
    }
  }

  // Calculate % position of a value along [min, max] for tick marks
  function pct(v: number): number {
    if (max === min) return 0;
    return Math.min(100, Math.max(0, ((v - min) / (max - min)) * 100));
  }

  const showZeroMark = min < 0 || (min === 0 && max > 0);
  const zeroPct = pct(0);
  const defaultPct = defaultValue !== undefined ? pct(defaultValue) : null;

  return (
    <div className="flex items-center gap-2">
      {/* Slider with reference markers */}
      <div className="relative flex-1 pt-4">
        {/* Tick marks */}
        <div className="absolute top-0 left-0 right-0 pointer-events-none" style={{ height: "16px" }}>
          {showZeroMark && zeroPct >= 0 && zeroPct <= 100 && (
            <div
              className="absolute flex flex-col items-center"
              style={{ left: `${zeroPct}%`, transform: "translateX(-50%)" }}
            >
              <span className="text-[9px] font-mono leading-none mb-0.5" style={{ color: "rgba(255,255,255,0.35)" }}>0</span>
              <div className="w-0.5 h-1.5 rounded-full" style={{ background: "rgba(255,255,255,0.25)" }} />
            </div>
          )}
          {defaultPct !== null && defaultPct >= 0 && defaultPct <= 100 && (
            <div
              className="absolute flex flex-col items-center"
              style={{ left: `${defaultPct}%`, transform: "translateX(-50%)" }}
            >
              <span className="text-[9px] font-mono leading-none mb-0.5" style={{ color: "rgba(191,0,255,0.7)" }}>def</span>
              <div className="w-0.5 h-1.5 rounded-full" style={{ background: "rgba(191,0,255,0.6)" }} />
            </div>
          )}
        </div>
        <Slider
          min={min}
          max={max}
          step={step}
          value={[sliderValue]}
          onValueChange={([v]) => {
            onChange(v);
            setRaw(String(v));
          }}
        />
      </div>

      {/* Numeric input override */}
      <input
        ref={inputRef}
        type="number"
        value={raw}
        step={step}
        onChange={handleInputChange}
        onBlur={handleInputBlur}
        className="w-20 h-7 text-xs font-mono text-right rounded px-2 shrink-0"
        style={{
          background: "rgba(0,0,0,0.35)",
          border: "1px solid rgba(191,0,255,0.2)",
          color: "var(--text-primary)",
          outline: "none",
        }}
      />
    </div>
  );
}
