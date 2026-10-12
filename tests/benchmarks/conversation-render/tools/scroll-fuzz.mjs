/** Keep input choices reproducible; actual dispatch timings remain in the frame trace. */
export function createScrollFuzz(seed) {
  if (!Number.isSafeInteger(seed) || seed < 1 || seed > 0xffffffff) throw new Error("stream-fuzz-seed must be an integer from 1 to 4294967295");
  let state = seed >>> 0;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
  return () => {
    const distance = () => 0.12 + random() * 0.65;
    const deltas = [-distance()];
    for (let index = 0, count = 1 + Math.floor(random() * 4); index < count; index++) {
      deltas.push((index % 2 ? -1 : 1) * distance());
    }
    return { deltas, gapMs: 16 + Math.floor(random() * 65), holdMs: 80 + Math.floor(random() * 241) };
  };
}
