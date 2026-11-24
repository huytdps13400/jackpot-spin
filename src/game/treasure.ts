/**
 * The treasure layer of a board. Every one of the 100 cells hides a treasure under its lid;
 * claiming the cell opens the lid and reveals it. A board always holds the same mix (so every
 * board is worth the same and a full board is always the same jackpot), shuffled by a seed that
 * changes each time a new board is dealt.
 */

export type TreasureTier = 0 | 1 | 2 | 3;

export type Treasure = {
  id: string;
  /** Banner / VoiceOver name. */
  name: string;
  /** 0 common · 1 rare · 2 epic · 3 legendary — drives the size of the reveal. */
  tier: TreasureTier;
  /** How many of the 100 cells hold this treasure. */
  count: number;
  /** Light colour of the reveal (sparks, halo), linear-ish RGB 0..1. */
  tint: readonly [number, number, number];
};

export const TREASURES: readonly Treasure[] = [
  { id: 'coin', name: 'Gold coin', tier: 0, count: 28, tint: [1, 0.84, 0.38] },
  { id: 'bars', name: 'Gold bars', tier: 0, count: 20, tint: [1, 0.78, 0.3] },
  { id: 'emerald', name: 'Emerald', tier: 1, count: 13, tint: [0.35, 1, 0.55] },
  { id: 'sapphire', name: 'Sapphire', tier: 1, count: 12, tint: [0.4, 0.62, 1] },
  { id: 'amethyst', name: 'Amethyst', tier: 1, count: 10, tint: [0.86, 0.72, 1] },
  { id: 'ruby', name: 'Ruby', tier: 2, count: 8, tint: [1, 0.46, 0.24] },
  { id: 'crown', name: 'Royal crown', tier: 2, count: 5, tint: [1, 0.86, 0.45] },
  { id: 'diamond', name: 'Diamond', tier: 3, count: 3, tint: [0.75, 0.95, 1] },
  { id: 'chest', name: 'Treasure chest', tier: 3, count: 1, tint: [1, 0.8, 0.35] },
];

export const TREASURE_KINDS = TREASURES.length;
/** The chest is shown with its Blender opening animation instead of a still. */
export const CHEST = TREASURES.findIndex((t) => t.id === 'chest');

/** Tier per treasure index, and reveal tint per treasure index (flat, for worklets). */
export const TREASURE_TIER: readonly number[] = TREASURES.map((t) => t.tier);
export const TREASURE_TINT: readonly number[] = TREASURES.flatMap((t) => [...t.tint]);

/** Small, fast, well-distributed PRNG (mulberry32). */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Treasure index (into TREASURES) for each cell 0..99 of the board dealt with `seed`. */
export function boardTreasures(seed: number): number[] {
  const deck: number[] = [];
  TREASURES.forEach((t, i) => {
    for (let k = 0; k < t.count; k++) deck.push(i);
  });
  const rand = mulberry32(seed);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = deck[i];
    deck[i] = deck[j];
    deck[j] = tmp;
  }
  return deck;
}

export function newBoardSeed() {
  return (Math.random() * 0x7fffffff) | 0;
}
