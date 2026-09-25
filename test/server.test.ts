import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import WebSocket from 'ws';
import { createCoreServer } from '../src/server.js';
import type { GameResponse } from '../src/websocket/game-socket.js';

test('HTTP scaffold and WebSocket spin protocol', { timeout: 10000 }, async (t) => {
  const core = createCoreServer();
  t.after(() => core.close());
  core.server.listen(0, '127.0.0.1');
  await once(core.server, 'listening');
  const { port } = core.server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}/api/back-office`);
  assert.equal(response.status, 404);
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/games`);
  await once(socket, 'open');
  const exchange = async (payload: string | Buffer): Promise<GameResponse> => {
    const received = once(socket, 'message');
    socket.send(payload);
    const [data] = await received;
    return JSON.parse(data.toString()) as GameResponse;
  };
  for (const [payload, code] of [
    ['{', 'INVALID_JSON'], ['null', 'INVALID_MESSAGE'], ['[]', 'INVALID_MESSAGE'],
    [JSON.stringify({ type: 'slot.spin' }), 'INVALID_MESSAGE'],
    [JSON.stringify({ type: 'slot.spin', requestId: ' ' }), 'INVALID_MESSAGE'],
    [JSON.stringify({ type: 'wheel.spin', requestId: 'unknown' }), 'UNKNOWN_MESSAGE_TYPE'],
  ]) {
    const result = await exchange(payload);
    assert.equal(result.type, 'error');
    if (result.type === 'error') assert.equal(result.error.code, code);
  }
  assert.equal((await exchange(Buffer.from('{}'))).type, 'error');
  const first = await exchange(JSON.stringify({ type: 'slot.spin', requestId: 'spin-1' }));
  assert.equal(first.type, 'slot.result');
  if (first.type !== 'slot.result') throw new Error('Expected a spin result');
  assert.equal(first.requestId, 'spin-1');
  assert.equal(first.result.ways.length, 27);
  assert.equal(first.result.matrix.length, 3);
  assert.equal(first.result.winCount, first.result.wins.length);
  const second = await exchange(JSON.stringify({ type: 'slot.spin', requestId: 'spin-2' }));
  assert.equal(second.type, 'slot.result');
  if (second.type === 'slot.result') assert.notEqual(second.result.spinId, first.result.spinId);
  const closed = once(socket, 'close');
  socket.close();
  await closed;
});
