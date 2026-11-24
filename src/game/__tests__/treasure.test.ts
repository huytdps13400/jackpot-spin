import { TREASURES, boardTreasures } from '../treasure';

describe('boardTreasures', () => {
  it('always deals the same mix: 100 cells, every treasure at its count', () => {
    expect(TREASURES.reduce((n, t) => n + t.count, 0)).toBe(100);
    for (const seed of [1, 42, 123456789]) {
      const board = boardTreasures(seed);
      expect(board).toHaveLength(100);
      TREASURES.forEach((t, i) => {
        expect(board.filter((v) => v === i)).toHaveLength(t.count);
      });
    }
  });

  it('is deterministic per seed and differs between seeds', () => {
    expect(boardTreasures(7)).toEqual(boardTreasures(7));
    expect(boardTreasures(7)).not.toEqual(boardTreasures(8));
  });
});
