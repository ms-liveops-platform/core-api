import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import WebSocket from "ws";
import { createCoreServer } from "../src/server.js";
type GameResponse = {
  type: string;
  error: { code: string };
  requestId: string | null;
};

test(
  "HTTP and WebSocket return explicit database-unavailable errors",
  { timeout: 10000 },
  async (t) => {
    const core = createCoreServer();
    t.after(() => core.close());
    core.server.listen(0, "127.0.0.1");
    await once(core.server, "listening");
    const { port } = core.server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/back-office`);
    assert.equal(response.status, 503);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/games`);
    await once(socket, "open");
    const exchange = async (
      payload: string | Buffer,
    ): Promise<GameResponse> => {
      const received = once(socket, "message");
      socket.send(payload);
      const [data] = await received;
      return JSON.parse(data.toString()) as GameResponse;
    };
    for (const [payload, code] of [
      ["{", "INVALID_JSON"],
      ["null", "INVALID_MESSAGE"],
      ["[]", "INVALID_MESSAGE"],
      [JSON.stringify({ type: "slot.spin" }), "INVALID_MESSAGE"],
      [
        JSON.stringify({ type: "slot.spin", requestId: " " }),
        "INVALID_MESSAGE",
      ],
      [
        JSON.stringify({ type: "wheel.spin", requestId: "unknown" }),
        "UNKNOWN_MESSAGE_TYPE",
      ],
    ]) {
      const result = await exchange(payload);
      assert.equal(result.type, "error");
      if (result.type === "error") assert.equal(result.error.code, code);
    }
    assert.equal((await exchange(Buffer.from("{}"))).type, "error");
    const first = await exchange(
      JSON.stringify({ type: "slot.spin", requestId: "spin-1" }),
    );
    assert.equal(first.error.code, "DATABASE_UNAVAILABLE");
    const closed = once(socket, "close");
    socket.close();
    await closed;
  },
);
