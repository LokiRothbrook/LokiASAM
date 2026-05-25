"use client";

interface LokiIconProps {
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}

// ARK-style bold angular "L" polygon points
const L = "75,80 185,46 185,348 442,348 408,450 75,450";

// 3 claw fingers — wide at right (base), tapering to hooked tip digging into L's right edge
const CLAW1 = "M 402,114 C 325,103 248,113 186,146 L 163,180 C 186,164 268,152 342,133 C 378,122 394,119 402,143 Z";
const CLAW2 = "M 428,215 C 352,203 268,210 186,234 L 163,268 C 186,253 268,246 358,224 C 396,213 413,214 428,243 Z";
const CLAW3 = "M 415,310 C 342,299 264,305 186,320 L 163,354 C 186,341 268,334 348,320 C 383,309 402,310 415,337 Z";

// Gear tooth polygons (30 teeth, alternating tall/short, computed at 512×512)
const TEETH = [
  "244.0,26.3 268.0,26.3 256.0,12.0","292.0,28.8 315.5,33.8 305.3,24.2","338.4,41.3 360.4,51.1 352.4,39.5",
  "381.3,63.1 400.7,77.3 399.4,58.6","418.6,93.4 434.7,111.3 432.1,97.4","448.9,130.7 460.9,151.6 461.2,137.5",
  "470.7,173.6 478.2,196.5 488.1,180.6","483.2,220.0 485.7,244.0 491.7,231.2","485.7,268.0 483.2,292.0 491.7,280.8",
  "478.2,315.5 470.7,338.4 488.1,331.4","460.9,360.4 448.9,381.3 461.2,374.5","434.7,400.7 418.6,418.6 432.1,414.6",
  "400.7,434.7 381.3,448.9 399.4,453.4","360.4,460.9 338.4,470.7 352.4,472.5","315.5,478.2 292.0,483.2 305.3,487.8",
  "268.0,485.7 244.0,485.7 256.0,500.0","220.0,483.2 196.5,478.2 206.7,487.8","173.6,470.7 151.6,460.9 159.6,472.5",
  "130.7,448.9 111.3,434.7 112.6,453.4","93.4,418.6 77.3,400.7 79.9,414.6","63.1,381.3 51.1,360.4 50.8,374.5",
  "41.3,338.4 33.8,315.5 23.9,331.4","28.8,292.0 26.3,268.0 20.3,280.8","26.3,244.0 28.8,220.0 20.3,231.2",
  "33.8,196.5 41.3,173.6 23.9,180.6","51.1,151.6 63.1,130.7 50.8,137.5","77.3,111.3 93.4,93.4 79.9,97.4",
  "111.3,77.3 130.7,63.1 112.6,58.6","151.6,51.1 173.6,41.3 159.6,39.5","196.5,33.8 220.0,28.8 206.7,24.2",
];

// 8 compass diamond markers at r=193
const DIAMONDS = [
  "256.0,57.0 262.0,63.0 256.0,69.0 250.0,63.0","392.5,113.5 398.5,119.5 392.5,125.5 386.5,119.5",
  "449.0,250.0 455.0,256.0 449.0,262.0 443.0,256.0","392.5,386.5 398.5,392.5 392.5,398.5 386.5,392.5",
  "256.0,443.0 262.0,449.0 256.0,455.0 250.0,449.0","119.5,386.5 125.5,392.5 119.5,398.5 113.5,392.5",
  "63.0,250.0 69.0,256.0 63.0,262.0 57.0,256.0","119.5,113.5 125.5,119.5 119.5,125.5 113.5,119.5",
];

export function LokiIcon({ size = 32, className, style }: LokiIconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"
         width={size} height={size} className={className} style={style} aria-label="LokiASAM">
      <defs>
        <radialGradient id="loki-bg" cx="50%" cy="40%" r="58%">
          <stop offset="0%"   stopColor="#1a0535"/>
          <stop offset="100%" stopColor="#040012"/>
        </radialGradient>
        <linearGradient id="loki-lf" x1="0%" y1="0%" x2="15%" y2="100%">
          <stop offset="0%"   stopColor="#e844ff"/>
          <stop offset="30%"  stopColor="#bb00ee"/>
          <stop offset="100%" stopColor="#6a0088"/>
        </linearGradient>
        <linearGradient id="loki-ls" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%"   stopColor="#000000" stopOpacity={0}/>
          <stop offset="100%" stopColor="#000000" stopOpacity={0.35}/>
        </linearGradient>
        <linearGradient id="loki-cf" x1="100%" y1="0%" x2="0%" y2="0%">
          <stop offset="0%"   stopColor="#005c42"/>
          <stop offset="60%"  stopColor="#00a87c"/>
          <stop offset="100%" stopColor="#00e8b0"/>
        </linearGradient>
        <filter id="loki-gl" x="-35%" y="-35%" width="170%" height="170%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="16" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <filter id="loki-gt" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="8" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <filter id="loki-ge" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="4" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>

      {/* Background */}
      <rect width="512" height="512" fill="url(#loki-bg)"/>

      {/* ── Ring system ── */}
      <circle cx="256" cy="256" r="185" fill="none" stroke="#00d4aa" strokeWidth="1.5" strokeDasharray="11 5.7" opacity={0.55}/>
      {/* 24 radial ticks */}
      {[["256.0","58.0","256.0","41.0","2.5"],["308.5","59.9","311.6","48.3","1.5"],["357.5","80.2","363.5","69.8","1.5"],
        ["399.5","112.5","408.0","104.0","1.5"],["431.8","154.5","442.2","148.5","1.5"],["452.1","203.5","463.7","200.4","1.5"],
        ["454.0","256.0","471.0","256.0","2.5"],["452.1","308.5","463.7","311.6","1.5"],["431.8","357.5","442.2","363.5","1.5"],
        ["399.5","399.5","408.0","408.0","1.5"],["357.5","431.8","363.5","442.2","1.5"],["308.5","452.1","311.6","463.7","1.5"],
        ["256.0","454.0","256.0","471.0","2.5"],["203.5","452.1","200.4","463.7","1.5"],["154.5","431.8","148.5","442.2","1.5"],
        ["112.5","399.5","104.0","408.0","1.5"],["80.2","357.5","69.8","363.5","1.5"],["59.9","308.5","48.3","311.6","1.5"],
        ["58.0","256.0","41.0","256.0","2.5"],["59.9","203.5","48.3","200.4","1.5"],["80.2","154.5","69.8","148.5","1.5"],
        ["112.5","112.5","104.0","104.0","1.5"],["154.5","80.2","148.5","69.8","1.5"],["203.5","59.9","200.4","48.3","1.5"],
      ].map(([x1,y1,x2,y2,sw], i) => (
        <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#00d4aa" strokeWidth={sw} opacity={0.85}/>
      ))}
      {/* 8 diamond markers */}
      {DIAMONDS.map((pts, i) => <polygon key={i} points={pts} fill="#00d4aa" opacity={0.9}/>)}
      {/* Inner detail ring */}
      <circle cx="256" cy="256" r="219" fill="none" stroke="#00d4aa" strokeWidth="1.5" opacity={0.5}/>
      {/* Primary ring glow + solid */}
      <circle cx="256" cy="256" r="228" fill="none" stroke="#00d4aa" strokeWidth="22" opacity={0.22} filter="url(#loki-gt)"/>
      <circle cx="256" cy="256" r="228" fill="none" stroke="#00d4aa" strokeWidth="5"/>
      {/* 30 gear teeth */}
      {TEETH.map((pts, i) => <polygon key={i} points={pts} fill="#00d4aa"/>)}

      {/* ── L letterform ── */}
      <polygon points={L} fill="#bf00ff" opacity={0.60} filter="url(#loki-gl)"/>
      <polygon points={L} fill="url(#loki-lf)"/>
      <polygon points={L} fill="url(#loki-ls)"/>
      <line x1="75"  y1="80"  x2="185" y2="46"  stroke="#00ffcc" strokeWidth="4.5" strokeLinecap="square" opacity={0.95} filter="url(#loki-ge)"/>
      <line x1="442" y1="348" x2="408" y2="450" stroke="#00ffcc" strokeWidth="4"   strokeLinecap="square" opacity={0.90} filter="url(#loki-ge)"/>
      <line x1="185" y1="348" x2="442" y2="348" stroke="#ee88ff" strokeWidth="3"   strokeLinecap="square" opacity={0.80} filter="url(#loki-ge)"/>
      <line x1="75"  y1="80"  x2="75"  y2="450" stroke="#dd66ff" strokeWidth="3"   strokeLinecap="square" opacity={0.70}/>
      <line x1="75"  y1="450" x2="408" y2="450" stroke="#cc44ff" strokeWidth="2"   strokeLinecap="square" opacity={0.55}/>
      <line x1="174" y1="58"  x2="174" y2="340" stroke="#000000" strokeWidth="3"   opacity={0.30}/>
      <line x1="187" y1="360" x2="432" y2="360" stroke="#000000" strokeWidth="2.5" opacity={0.25}/>

      {/* ── Claw marks gripping the L ── */}
      {[CLAW1, CLAW2, CLAW3].map((d, i) => (
        <g key={i}>
          <path d={d} fill="#00e8b0" opacity={0.30} filter="url(#loki-gt)"/>
          <path d={d} fill="url(#loki-cf)" opacity={0.92}/>
        </g>
      ))}
      {/* Dorsal highlight lines on each claw */}
      <path d="M 402,114 C 325,103 248,113 186,146" fill="none" stroke="#00ffcc" strokeWidth="2" opacity={0.75} filter="url(#loki-ge)"/>
      <path d="M 428,215 C 352,203 268,210 186,234" fill="none" stroke="#00ffcc" strokeWidth="2" opacity={0.75} filter="url(#loki-ge)"/>
      <path d="M 415,310 C 342,299 264,305 186,320" fill="none" stroke="#00ffcc" strokeWidth="2" opacity={0.75} filter="url(#loki-ge)"/>
    </svg>
  );
}
