import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { MongoClient } from "mongodb";
import WebSocket from "ws";
import { initializeDatabase } from "../src/db/database.js";
import { LiveOpsService, payoutFor } from "../src/domain/service.js";
import { evaluateWays, type Matrix } from "../src/games/slots/slot-engine.js";
import { createCoreServer } from "../src/server.js";

const round = (matrix: Matrix) => {
  const ways = evaluateWays(matrix);
  const wins = ways.filter((w) => w.isWin);
  return { spinId: randomUUID(), matrix, ways, wins, winCount: wins.length };
};
const audience = {
  playerIds: [],
  tags: [],
  minBalance: 0,
  maxBalance: 1000000,
  minDeposits: 0,
};

test("all ten symbols pay their tier for every winning way", () => {
  for (let symbol = 0; symbol < 10; symbol++) {
    const matrix = Array.from({ length: 3 }, () => [
      symbol,
      symbol,
      symbol,
    ]) as Matrix;
    assert.equal(
      payoutFor(round(matrix)),
      27 * (symbol < 3 ? 1 : symbol < 6 ? 3 : 10),
    );
  }
});

test(
  "MongoDB transactions, management APIs, and player WebSockets",
  { timeout: 180000 },
  async (t) => {
    const mongo = await MongoMemoryReplSet.create({
      replSet: { count: 1 },
      binary: { version: "7.0.14" },
    });
    t.after(() => mongo.stop());
    const client = new MongoClient(mongo.getUri());
    t.after(() => client.close());
    const db = client.db("liveops_test");
    await initializeDatabase(client, db);
    let matrix: Matrix = [
      [0, 1, 2],
      [3, 4, 5],
      [6, 7, 8],
    ];
    const service = new LiveOpsService(client, db, () => round(matrix));
    const player = await service.createPlayer({
      displayName: "Test Player",
      balance: 10,
      tags: ["vip"],
    });

    await t.test(
      "charges once across concurrent identical requests",
      async () => {
        const [a, b] = await Promise.all([
          service.play(player._id, "same-spin"),
          service.play(player._id, "same-spin"),
        ]);
        assert.equal(a.spinId, b.spinId);
        assert.equal(a.payout, 0);
        assert.equal((await service.getPlayer(player._id)).balance, 9);
        assert.equal(await service.c.rounds.countDocuments(), 1);
      },
    );
    await t.test(
      "credits high payouts and preserves the original result on replay",
      async () => {
        matrix = [
          [9, 9, 9],
          [1, 2, 3],
          [4, 5, 6],
        ];
        const result = await service.play(player._id, "high-win");
        assert.equal(result.payout, 10);
        assert.equal(result.balance, 18);
        assert.deepEqual(await service.play(player._id, "high-win"), result);
      },
    );
    await t.test(
      "prevents concurrent overspending and rejects archived players",
      async () => {
        matrix = [
          [0, 1, 2],
          [3, 4, 5],
          [6, 7, 8],
        ];
        const poor = await service.createPlayer({
          displayName: "One Credit",
          balance: 1,
          tags: [],
        });
        const results = await Promise.allSettled([
          service.play(poor._id, "one"),
          service.play(poor._id, "two"),
        ]);
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
        assert.equal((await service.getPlayer(poor._id)).balance, 0);
        await service.updatePlayer(poor._id, { status: "archived" });
        await assert.rejects(service.play(poor._id, "three"), /archived/);
      },
    );
    await t.test("rolls back balance if saving a round fails", async () => {
      const fixed = round(matrix);
      const failing = new LiveOpsService(client, db, () => fixed);
      await failing.play(player._id, "fixed-one");
      const before = (await service.getPlayer(player._id)).balance;
      await assert.rejects(failing.play(player._id, "fixed-two"));
      assert.equal((await service.getPlayer(player._id)).balance, before);
    });
    await t.test(
      "mock deposit is idempotent and rejects conflicting reuse",
      async () => {
        const before = (await service.getPlayer(player._id)).balance;
        const input = {
          playerId: player._id,
          amount: 100,
          requestId: "deposit-one",
        };
        await service.deposit(input);
        await service.deposit(input);
        assert.equal(
          (await service.getPlayer(player._id)).balance,
          before + 100,
        );
        await assert.rejects(
          service.deposit({ ...input, amount: 200 }),
          /different deposit/,
        );
      },
    );
    await t.test(
      "targets campaigns, credits once, and revokes only pending awards",
      async () => {
        const c = await service.createCampaign({
          name: "VIP",
          description: "",
          status: "active",
          rewardType: "credits",
          rewardValue: 25,
          audience: { ...audience, tags: ["vip"] },
        });
        const before = (await service.getPlayer(player._id)).balance;
        assert.equal((await service.issueCampaign(c._id)).granted, 1);
        assert.equal((await service.issueCampaign(c._id)).skipped, 1);
        assert.equal(
          (await service.getPlayer(player._id)).balance,
          before + 25,
        );
        const credited = await service.c.awards.findOne({ campaignId: c._id });
        await assert.rejects(service.revoke(credited!._id), /Only pending/);
        const pending = await service.grant({
          playerId: player._id,
          type: "wheel",
          value: 10,
          requestId: "wheel-one",
        });
        assert.equal(pending.status, "pending");
        await service.revoke(pending._id);
        assert.equal(
          (await service.getPlayer(player._id)).balance,
          before + 25,
        );
      },
    );
    await t.test(
      "seeded retention stays separate and new cohorts are immature",
      async () => {
        await service.seed(8);
        const analytics = await service.analytics();
        assert.equal(analytics.retention.simulated.d1.rate, 50);
        assert.equal(analytics.retention.simulated.d7.rate, 25);
        assert.equal(analytics.retention.real.d1.rate, null);
        await assert.rejects(
          service.simulateSession(player._id, 20),
          /predate/,
        );
      },
    );
    const core = createCoreServer(service);
    t.after(() => core.close());
    core.server.listen(0, "127.0.0.1");
    await once(core.server, "listening");
    const { port } = core.server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}/api/back-office`;
    await t.test(
      "HTTP CRUD validates input and soft-deletes without losing history",
      async () => {
        const request = (path: string, method = "GET", body?: unknown) =>
          fetch(base + path, {
            method,
            headers: { "content-type": "application/json" },
            body: body ? JSON.stringify(body) : undefined,
          });
        assert.equal((await request("/health")).status, 200);
        assert.equal(
          (await request("/players", "POST", { displayName: "", balance: -1 }))
            .status,
          400,
        );
        const created = await (
          await request("/players", "POST", {
            displayName: "HTTP Player",
            balance: 100,
          })
        ).json();
        assert.equal(created.displayName, "HTTP Player");
        assert.equal(
          (await request(`/players/${created._id}`, "PATCH", { balance: 999 }))
            .status,
          400,
        );
        await request(`/players/${created._id}`, "PATCH", {
          displayName: "Renamed",
        });
        assert.equal(
          (await (await request(`/players/${created._id}`)).json()).displayName,
          "Renamed",
        );
        await request(`/players/${created._id}`, "DELETE");
        assert.equal(
          (await (await request(`/players/${created._id}`)).json()).status,
          "archived",
        );
        const preview = await (
          await request("/targeting/preview", "POST", {
            ...audience,
            tags: ["vip"],
          })
        ).json();
        assert.equal(preview.count, 1);
      },
    );
    await t.test(
      "WebSocket authenticates the player, settles spins, pushes deposits, and restores sessions",
      async () => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/games`);
        await once(socket, "open");
        t.after(() => socket.terminate());
        const exchange = (message: Record<string, unknown>) =>
          new Promise<Record<string, any>>((resolve) => {
            const listener = (data: WebSocket.RawData) => {
              const response = JSON.parse(data.toString());
              if (response.requestId === message.requestId) {
                socket.off("message", listener);
                resolve(response);
              }
            };
            socket.on("message", listener);
            socket.send(JSON.stringify(message));
          });
        assert.equal(
          (await exchange({ type: "slot.spin", requestId: "no-session" })).error
            .code,
          "SESSION_REQUIRED",
        );
        assert.equal(
          (
            await exchange({
              type: "session.open",
              requestId: "bad-auth",
              playerId: player._id,
              token: randomUUID(),
            })
          ).error.code,
          "INVALID_PLAYER_TOKEN",
        );
        const session = await exchange({
          type: "session.open",
          requestId: "session",
          playerId: player._id,
          token: player.gameToken,
        });
        assert.equal(session.player.displayName, player.displayName);
        const first = await exchange({
          type: "slot.spin",
          requestId: "ws-spin",
        });
        assert.equal(first.result.bet, 1);
        assert.equal(first.result.payout, 0);
        const again = await exchange({
          type: "slot.spin",
          requestId: "ws-spin",
        });
        assert.equal(first.result.spinId, again.result.spinId);
        const pushed = new Promise<Record<string, any>>((resolve) => {
          socket.on("message", (data) => {
            const m = JSON.parse(data.toString());
            if (
              m.type === "player.updated" &&
              m.player.balance === first.player.balance + 20
            )
              resolve(m);
          });
        });
        await service.deposit({
          playerId: player._id,
          amount: 20,
          requestId: "ws-deposit",
        });
        assert.equal((await pushed).player.balance, first.player.balance + 20);
        socket.close();
      },
    );
  },
);
