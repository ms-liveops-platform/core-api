import type { Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { spin, type SpinResult } from '../games/slots/slot-engine.js';

export interface SpinRequest { type: 'slot.spin'; requestId: string }
export type GameResponse =
  | { type: 'slot.result'; requestId: string; result: SpinResult }
  | { type: 'error'; requestId: string | null; error: { code: string; message: string } };

export function attachGameSocket(server: Server, runSpin: () => SpinResult = spin) {
  const wss = new WebSocketServer({ server, path: '/ws/games', maxPayload: 16 * 1024 });
  wss.on('connection', (socket) => {
    socket.on('error', (error) => console.error('Game socket error:', error.message));
    const send = (response: GameResponse) => socket.send(JSON.stringify(response));
    const fail = (code: string, message: string, requestId: string | null = null) =>
      send({ type: 'error', requestId, error: { code, message } });

    socket.on('message', (data, isBinary) => {
      if (isBinary) return fail('INVALID_MESSAGE', 'Send a JSON text message.');
      let message: unknown;
      try { message = JSON.parse(data.toString()); }
      catch { return fail('INVALID_JSON', 'Message must contain valid JSON.'); }
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        return fail('INVALID_MESSAGE', 'Message must be an object.');
      }
      const request = message as Record<string, unknown>;
      if (typeof request.requestId !== 'string' || request.requestId.trim().length === 0 || request.requestId.length > 128) {
        return fail('INVALID_MESSAGE', 'requestId must be a non-empty string of at most 128 characters.');
      }
      if (request.type !== 'slot.spin') {
        return fail('UNKNOWN_MESSAGE_TYPE', 'Supported message type: slot.spin.', request.requestId);
      }
      try {
        send({ type: 'slot.result', requestId: request.requestId, result: runSpin() });
      } catch (error) {
        console.error('Spin failed:', error);
        fail('INTERNAL_ERROR', 'Unable to generate spin.', request.requestId);
      }
    });
  });
  return wss;
}
