import { useEffect, useRef } from 'react';
import type { MascotMood } from '@truly/lib/brand';

const bodyUrl = chrome.runtime.getURL('brand/ghost-body.png');
const eyesUrl = chrome.runtime.getURL('brand/ghost-eyes.png');

/**
 * The ghost turns its face and slides its eyes toward the pointer.
 * The toolbar icon stays the still image; only the ghost drawn in the
 * extension can follow the cursor.
 */
export function Mascot({ size = 120, className = '' }: { mood?: MascotMood; size?: number; className?: string }) {
  const root = useRef<HTMLSpanElement>(null);
  const face = useRef<HTMLSpanElement>(null);
  const eyes = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const rootEl = root.current;
    const faceEl = face.current;
    const eyesEl = eyes.current;
    if (!rootEl || !faceEl || !eyesEl) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let frame = 0;
    let x = 0;
    let y = 0;

    const look = () => {
      frame = 0;
      const box = rootEl.getBoundingClientRect();
      const cx = box.left + box.width * 0.5;
      const cy = box.top + box.height * 0.34;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.hypot(dx, dy) || 1;
      const reach = Math.min(1, dist / (box.width * 2.4));
      const nx = dx / dist;
      const ny = dy / dist;
      const shift = box.width * 0.055 * reach;
      faceEl.style.transform = `rotateY(${nx * 18 * reach}deg) rotateX(${ny * 14 * reach}deg)`;
      eyesEl.style.transform = `translate(${nx * shift}px, ${ny * shift}px)`;
    };

    const onMove = (event: PointerEvent) => {
      x = event.clientX;
      y = event.clientY;
      if (!frame) frame = requestAnimationFrame(look);
    };

    const rest = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      faceEl.style.transform = '';
      eyesEl.style.transform = '';
    };

    const onOut = (event: PointerEvent) => {
      if (!event.relatedTarget) rest();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerout', onOut);
    window.addEventListener('blur', rest);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerout', onOut);
      window.removeEventListener('blur', rest);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <span
      ref={root}
      className={`mascot ${className}`.trim()}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <span ref={face} className="mascot-face">
        <img className="mascot-body" src={bodyUrl} alt="" draggable={false} />
        <img ref={eyes} className="mascot-eyes" src={eyesUrl} alt="" draggable={false} />
      </span>
    </span>
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
