import { mascotSvg, type MascotMood } from '@truly/lib/brand';

/** Truly's mascot. The SVG is a fixed string from brand.ts, never user input. */
export function Mascot({ mood = 'happy', size = 120, className = '' }: { mood?: MascotMood; size?: number; className?: string }) {
  return (
    <span
      className={`mascot ${className}`.trim()}
      style={{ width: size, height: size }}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: mascotSvg(mood, size) }}
    />
  );
}

/** The wordmark: mascot plus "truly", for the top bar. */
export function Logo({ mood = 'happy' }: { mood?: MascotMood }) {
  return (
    <span className="logo">
      <Mascot mood={mood} size={26} />
      <span className="wordmark">truly</span>
    </span>
  );
}
