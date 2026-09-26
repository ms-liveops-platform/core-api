import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateWays,
  generateMatrix,
  spin,
} from "../src/games/slots/slot-engine.js";

test("all identical symbols produce 27 distinct winning ways, including zero", () => {
  const ways = evaluateWays([
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]);
  assert.equal(ways.length, 27);
  assert.equal(new Set(ways.map((way) => way.rows.join(","))).size, 27);
  assert.deepEqual(
    ways.map((way) => way.id),
    Array.from({ length: 27 }, (_, i) => i),
  );
  assert.ok(ways.every((way) => way.isWin));
});

test("counts all repeated-symbol combinations across reels", () => {
  const wins = evaluateWays([
    [7, 7, 7],
    [7, 1, 7],
    [2, 3, 7],
  ]).filter((way) => way.isWin);
  assert.equal(wins.length, 6);
  assert.ok(wins.every((way) => way.symbols.every((symbol) => symbol === 7)));
});

test("identifies a non-adjacent winning path with row-major coordinates", () => {
  const wins = evaluateWays([
    [9, 1, 2],
    [3, 4, 9],
    [5, 9, 6],
  ]).filter((way) => way.isWin);
  assert.equal(wins.length, 1);
  assert.deepEqual(wins[0].rows, [0, 2, 1]);
  assert.deepEqual(wins[0].positions, [
    { row: 0, reel: 0 },
    { row: 2, reel: 1 },
    { row: 1, reel: 2 },
  ]);
});

test("two matching reels alone do not win", () => {
  assert.equal(
    evaluateWays([
      [1, 1, 2],
      [3, 3, 4],
      [5, 5, 6],
    ]).filter((way) => way.isWin).length,
    0,
  );
});

test("generation fills rows in order and rejects invalid symbols", () => {
  let next = 0;
  assert.deepEqual(
    generateMatrix(() => next++),
    [
      [0, 1, 2],
      [3, 4, 5],
      [6, 7, 8],
    ],
  );
  for (const value of [-1, 10, 1.5, NaN])
    assert.throws(() => generateMatrix(() => value), RangeError);
});

test("spin produces a consistent result with valid symbols", () => {
  const result = spin();
  assert.equal(result.matrix.flat().length, 9);
  assert.ok(
    result.matrix
      .flat()
      .every(
        (symbol) => Number.isInteger(symbol) && symbol >= 0 && symbol <= 9,
      ),
  );
  assert.deepEqual(result.ways, evaluateWays(result.matrix));
  assert.deepEqual(
    result.wins,
    result.ways.filter((way) => way.isWin),
  );
  assert.equal(result.winCount, result.wins.length);
  assert.ok(result.spinId);
});
