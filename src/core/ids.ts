import { randomBytes } from 'node:crypto';
import type { Id } from './types.js';

// Crockford's Base32
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateId(prefix?: string): Id {
  const time = Date.now();
  let timeStr = '';
  let t = time;
  for (let i = 9; i >= 0; i--) {
    timeStr = ENCODING[t % 32] + timeStr;
    t = Math.floor(t / 32);
  }

  const bytes = randomBytes(10);
  let randStr = '';
  for (let i = 0; i < 16; i++) {
    randStr += ENCODING[bytes[i % bytes.length] % 32];
  }

  const id = `${timeStr}${randStr}`;
  return prefix ? `${prefix}_${id}` : id;
}
