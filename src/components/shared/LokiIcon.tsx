"use client";

/**
 * LokiIcon — SVG app logo component.
 *
 * Server rack with neon-purple dinosaur claw marks.
 * Replaces the generic Zap icon throughout the app.
 *
 * Props:
 *   size      — pixel size (width = height). Default 32.
 *   className — extra CSS classes.
 *   style     — inline styles (e.g. filter for drop-shadow).
 */

interface LokiIconProps {
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}

export function LokiIcon({ size = 32, className, style }: LokiIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 512 512"
      width={size}
      height={size}
      className={className}
      style={style}
      aria-label="LokiASAM"
    >
      <defs>
        <filter id="loki-glow-s" x="-25%" y="-25%" width="150%" height="150%">
          <feGaussianBlur stdDeviation="5" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <filter id="loki-glow-m" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="10" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <filter id="loki-led" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="3.5" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <linearGradient id="loki-bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#120a22"/>
          <stop offset="100%" stopColor="#060410"/>
        </linearGradient>
        <linearGradient id="loki-unit" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#1c0c34"/>
          <stop offset="100%" stopColor="#0e061e"/>
        </linearGradient>
        <linearGradient id="loki-active" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#250e40"/>
          <stop offset="100%" stopColor="#120828"/>
        </linearGradient>
        <clipPath id="loki-clip">
          <rect width="512" height="512" rx="84"/>
        </clipPath>
      </defs>

      {/* Background */}
      <rect width="512" height="512" rx="84" fill="url(#loki-bg)"/>
      <rect x="1.5" y="1.5" width="509" height="509" rx="83" fill="none"
            stroke="#bf00ff" strokeWidth="3" strokeOpacity="0.25"/>

      <g clipPath="url(#loki-clip)">
        {/* ── Rack chassis ── */}
        <rect x="72" y="56" width="368" height="400" rx="20" fill="#0d061c"
              stroke="#bf00ff" strokeWidth="2.5" strokeOpacity="0.55"/>
        <rect x="88" y="72" width="336" height="368" rx="12" fill="#080414"/>

        {/* Unit 1 */}
        <rect x="100" y="84"  width="312" height="62" rx="7" fill="url(#loki-unit)"
              stroke="#bf00ff" strokeWidth="1" strokeOpacity="0.4"/>
        <rect x="114" y="97"  width="192" height="5" rx="2.5" fill="#bf00ff" opacity="0.50"/>
        <rect x="114" y="108" width="152" height="4" rx="2"   fill="#bf00ff" opacity="0.30"/>
        <rect x="114" y="118" width="168" height="3" rx="1.5" fill="#bf00ff" opacity="0.20"/>
        <circle cx="382" cy="104" r="7" fill="#00ff88" filter="url(#loki-led)"/>
        <circle cx="366" cy="104" r="5" fill="#00ff88" opacity="0.45"/>

        {/* Unit 2 — active */}
        <rect x="100" y="154" width="312" height="62" rx="7" fill="url(#loki-active)"
              stroke="#bf00ff" strokeWidth="2" strokeOpacity="0.75"/>
        <rect x="114" y="167" width="210" height="5" rx="2.5" fill="#bf00ff" opacity="0.80"/>
        <rect x="114" y="178" width="165" height="4" rx="2"   fill="#bf00ff" opacity="0.55"/>
        <rect x="114" y="188" width="182" height="3" rx="1.5" fill="#bf00ff" opacity="0.38"/>
        <circle cx="382" cy="174" r="7" fill="#00ff88" filter="url(#loki-led)"/>
        <circle cx="366" cy="174" r="5" fill="#00ff88" opacity="0.65"/>

        {/* Unit 3 */}
        <rect x="100" y="224" width="312" height="62" rx="7" fill="url(#loki-unit)"
              stroke="#bf00ff" strokeWidth="1" strokeOpacity="0.4"/>
        <rect x="114" y="237" width="172" height="5" rx="2.5" fill="#bf00ff" opacity="0.45"/>
        <rect x="114" y="248" width="134" height="4" rx="2"   fill="#bf00ff" opacity="0.28"/>
        <rect x="114" y="258" width="148" height="3" rx="1.5" fill="#bf00ff" opacity="0.18"/>
        <circle cx="382" cy="244" r="7" fill="#ff3355" opacity="0.85"/>
        <circle cx="366" cy="244" r="5" fill="#ff3355" opacity="0.45"/>

        {/* Unit 4 */}
        <rect x="100" y="294" width="312" height="62" rx="7" fill="url(#loki-unit)"
              stroke="#bf00ff" strokeWidth="1" strokeOpacity="0.4"/>
        <rect x="114" y="307" width="180" height="5" rx="2.5" fill="#bf00ff" opacity="0.50"/>
        <rect x="114" y="318" width="140" height="4" rx="2"   fill="#bf00ff" opacity="0.30"/>
        <rect x="114" y="328" width="158" height="3" rx="1.5" fill="#bf00ff" opacity="0.20"/>
        <circle cx="382" cy="314" r="7" fill="#00ff88" filter="url(#loki-led)"/>
        <circle cx="366" cy="314" r="5" fill="#00ff88" opacity="0.50"/>

        {/* Unit 5 */}
        <rect x="100" y="364" width="312" height="62" rx="7" fill="url(#loki-unit)"
              stroke="#bf00ff" strokeWidth="1" strokeOpacity="0.4"/>
        <rect x="114" y="377" width="158" height="5" rx="2.5" fill="#bf00ff" opacity="0.45"/>
        <rect x="114" y="388" width="122" height="4" rx="2"   fill="#bf00ff" opacity="0.28"/>
        <rect x="114" y="398" width="138" height="3" rx="1.5" fill="#bf00ff" opacity="0.18"/>
        <circle cx="382" cy="384" r="7" fill="#00ff88" filter="url(#loki-led)"/>
        <circle cx="366" cy="384" r="5" fill="#00ff88" opacity="0.50"/>

        {/* ── Dino claw marks ── */}
        {/* Slash 1 */}
        <line x1="196" y1="72"  x2="120" y2="440"
              stroke="#bf00ff" strokeWidth="22" strokeLinecap="round" strokeOpacity="0.35"
              filter="url(#loki-glow-m)"/>
        <line x1="196" y1="72"  x2="120" y2="440"
              stroke="#bf00ff" strokeWidth="12" strokeLinecap="round" strokeOpacity="0.85"/>
        <line x1="196" y1="72"  x2="120" y2="440"
              stroke="#e080ff" strokeWidth="4"  strokeLinecap="round" strokeOpacity="0.95"/>

        {/* Slash 2 */}
        <line x1="263" y1="72"  x2="187" y2="440"
              stroke="#bf00ff" strokeWidth="22" strokeLinecap="round" strokeOpacity="0.35"
              filter="url(#loki-glow-m)"/>
        <line x1="263" y1="72"  x2="187" y2="440"
              stroke="#bf00ff" strokeWidth="12" strokeLinecap="round" strokeOpacity="0.85"/>
        <line x1="263" y1="72"  x2="187" y2="440"
              stroke="#e080ff" strokeWidth="4"  strokeLinecap="round" strokeOpacity="0.95"/>

        {/* Slash 3 */}
        <line x1="330" y1="72"  x2="254" y2="440"
              stroke="#bf00ff" strokeWidth="22" strokeLinecap="round" strokeOpacity="0.35"
              filter="url(#loki-glow-m)"/>
        <line x1="330" y1="72"  x2="254" y2="440"
              stroke="#bf00ff" strokeWidth="12" strokeLinecap="round" strokeOpacity="0.85"/>
        <line x1="330" y1="72"  x2="254" y2="440"
              stroke="#e080ff" strokeWidth="4"  strokeLinecap="round" strokeOpacity="0.95"/>
      </g>
    </svg>
  );
}
