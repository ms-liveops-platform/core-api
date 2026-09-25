import { randomInt, randomUUID } from 'node:crypto';

export type SymbolId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
export type RowIndex = 0 | 1 | 2;
export type Triple<T> = [T, T, T];
/** Row-major: matrix[row][reel], reels go left to right. */
export type Matrix = Triple<Triple<SymbolId>>;
export interface WayResult {
  id: number;
  rows: Triple<RowIndex>;
  positions: Triple<{ row: RowIndex; reel: RowIndex }>;
  symbols: Triple<SymbolId>;
  isWin: boolean;
}
export interface SpinResult {
  spinId: string;
  matrix: Matrix;
  ways: WayResult[];
  wins: WayResult[];
  winCount: number;
}
const ROWS: RowIndex[] = [0, 1, 2];

/** All 3 × 3 × 3 ways, including non-adjacent rows. IDs are stable, 0–26. */
export function evaluateWays(matrix: Matrix): WayResult[] {
  return ROWS.flatMap((first) => ROWS.flatMap((second) => ROWS.map((third) => {
    const symbols: Triple<SymbolId> = [matrix[first][0], matrix[second][1], matrix[third][2]];
    return {
      id: first * 9 + second * 3 + third,
      rows: [first, second, third] as Triple<RowIndex>,
      positions: [{ row: first, reel: 0 }, { row: second, reel: 1 }, { row: third, reel: 2 }] as WayResult['positions'],
      symbols,
      isWin: symbols[0] === symbols[1] && symbols[1] === symbols[2],
    };
  })));
}

export function generateMatrix(draw: () => number = () => randomInt(10)): Matrix {
  const next = (): SymbolId => {
    const value = draw();
    if (!Number.isInteger(value) || value < 0 || value > 9) {
      throw new RangeError('Symbol must be an integer from 0 to 9.');
    }
    return value as SymbolId;
  };
  const row = (): Triple<SymbolId> => [next(), next(), next()];
  return [row(), row(), row()];
}

export function spin(): SpinResult {
  const matrix = generateMatrix();
  const ways = evaluateWays(matrix);
  const wins = ways.filter((way) => way.isWin);
  return { spinId: randomUUID(), matrix, ways, wins, winCount: wins.length };
}
