/**
 * Truly's mascot: a small mint shield wearing a dark privacy mask.
 *
 * One drawing, several moods, so the lock screen, the header, the toolbar
 * icon and the icon Lighter's wallet list shows (EIP-6963) all come from the
 * same source. Plain SVG strings: the injected provider and the icon script
 * need a string, the popup renders the same string.
 */

export type MascotMood = 'sleepy' | 'happy' | 'wink' | 'worried';

export const BRAND = {
  mint: '#5eead4',
  mintDeep: '#2dd4bf',
  ink: '#0b0d10',
  glow: '#ccfbf1',
} as const;

const EYES: Record<MascotMood, string> = {
  // Closed, content: the vault is locked and resting.
  sleepy:
    '<path d="M35 53q7 7 14 0M71 53q7 7 14 0" fill="none" stroke="#5eead4" stroke-width="4.5" stroke-linecap="round"/>',
  // Smiling eyes: unlocked.
  happy:
    '<path d="M35 57q7-9 14 0M71 57q7-9 14 0" fill="none" stroke="#5eead4" stroke-width="4.5" stroke-linecap="round"/>',
  wink:
    '<circle cx="42" cy="54" r="5" fill="#ccfbf1"/><path d="M71 57q7-9 14 0" fill="none" stroke="#5eead4" stroke-width="4.5" stroke-linecap="round"/>',
  worried:
    '<circle cx="42" cy="55" r="4.5" fill="#ccfbf1"/><circle cx="78" cy="55" r="4.5" fill="#ccfbf1"/>',
};

const MOUTH: Record<MascotMood, string> = {
  sleepy: '<path d="M54 84q6 4 12 0" fill="none" stroke="#0b0d10" stroke-width="4" stroke-linecap="round"/>',
  happy: '<path d="M50 81q10 11 20 0" fill="none" stroke="#0b0d10" stroke-width="4.5" stroke-linecap="round"/>',
  wink: '<path d="M50 81q10 11 20 0" fill="none" stroke="#0b0d10" stroke-width="4.5" stroke-linecap="round"/>',
  worried: '<path d="M52 87q8-7 16 0" fill="none" stroke="#0b0d10" stroke-width="4" stroke-linecap="round"/>',
};

/** The mascot as a standalone SVG document, square viewBox 0 0 120 120. */
export function mascotSvg(mood: MascotMood = 'happy', size = 120): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 120 120">`,
    // Shield body, with a deeper shade on the right half for depth.
    '<path d="M60 7c15 7 30 10 45 11 1 42-13 74-45 95C28 92 14 60 15 18c15-1 30-4 45-11z" fill="#5eead4"/>',
    '<path d="M60 7c15 7 30 10 45 11 1 42-13 74-45 95z" fill="#2dd4bf"/>',
    // Highlight.
    '<path d="M27 27c8-1 15-3 22-6" fill="none" stroke="#ccfbf1" stroke-width="4" stroke-linecap="round" opacity=".8"/>',
    // The privacy mask: a domino band across the eyes.
    '<path d="M22 50c0-8 5-11 13-11h50c8 0 13 3 13 11v4c0 9-6 13-15 13-11 0-15-4-19-9-2-2-6-2-8 0-4 5-8 9-19 9-9 0-15-4-15-13z" fill="#0b0d10"/>',
    EYES[mood],
    MOUTH[mood],
    '</svg>',
  ].join('');
}

/** For an <img src> or an EIP-6963 icon. */
export function mascotDataUri(mood: MascotMood = 'happy'): string {
  const svg = mascotSvg(mood, 96);
  const base64 = typeof btoa === 'function' ? btoa(svg) : Buffer.from(svg).toString('base64');
  return `data:image/svg+xml;base64,${base64}`;
}
