// murmur3_x86_32 (seed 0), ported from switchyard-core for display only:
// showing the bucket of an evaluated user in the test panel.
// It never influences decisions. Verify: node lib/murmur.check.mjs
export function murmur3x86_32(data: Uint8Array, seed = 0): number {
  const C1 = 0xcc9e2d51;
  const C2 = 0x1b873593;
  let h = seed >>> 0;
  const n = data.length;
  const nblocks = Math.floor(n / 4);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i < nblocks; i++) {
    let k = view.getUint32(i * 4, true);
    k = Math.imul(k, C1);
    k = ((k << 15) | (k >>> 17)) >>> 0;
    k = Math.imul(k, C2);
    h ^= k;
    h = ((h << 13) | (h >>> 19)) >>> 0;
    h = (Math.imul(h, 5) + 0xe6546b64) >>> 0;
  }
  const tail = nblocks * 4;
  let k = 0;
  if (n - tail >= 3) k ^= data[tail + 2] << 16;
  if (n - tail >= 2) k ^= data[tail + 1] << 8;
  if (n - tail >= 1) {
    k ^= data[tail];
    k = Math.imul(k, C1);
    k = ((k << 15) | (k >>> 17)) >>> 0;
    k = Math.imul(k, C2);
    h ^= k;
  }
  h ^= n;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export function bucket(flagKey: string, contextKey: string): number {
  const input = new TextEncoder().encode(`${flagKey}:${contextKey}`);
  return murmur3x86_32(input, 0) % 10000;
}
