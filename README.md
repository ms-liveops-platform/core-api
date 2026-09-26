# Core API / LiveOps PoC

Node.js + TypeScript, Express HTTP, native WebSockets, and MongoDB. The back office uses HTTP; games-web uses only WebSockets.

## Setup

```sh
npm install
cp .env.example .env
```

Set `MONGO_DB_CONNECTION_STRING` in `.env` to your MongoDB URI. Atlas or a replica set is required: player balances and financial records are committed in multi-document transactions. Standalone MongoDB is rejected at startup. `MONGO_DB_NAME` optionally overrides the database in the URI; `.env.example` suggests `liveops`.

```sh
npm run dev
```

The API listens on `127.0.0.1:5555`. `tsx watch` restarts on source changes. Restart after editing `.env`; dotenv loads it at startup. If the URI is absent, the server starts with explicit HTTP 503 / WebSocket database-unavailable errors. It never substitutes an in-memory database for application data. A configured but invalid connection fails startup.

Back-office origin defaults to `http://127.0.0.1:9999` and `http://localhost:9999`; configure `BACK_OFFICE_ORIGINS` for additional origins. Ports and host can be overridden with `PORT` and `HOST`.

## Player balances and payouts

Credits are integers. Each spin costs exactly **1 credit**, deducted once. Every three-of-a-kind winning way pays the following multiplier of that bet:

| Symbol IDs | Game symbols | Per-way multiplier |
| --- | --- | --- |
| 0–2 | Cherries, lemon, grapes | 1× |
| 3–5 | Bell, star, diamond | 3× |
| 6–9 | Clover, crown, horseshoe, planet | 10× |

The total payout is the sum of all winning ways. Example: two crown ways pay 20 credits, giving a net balance change of +19 after the stake. Payout includes the entire return; no extra stake refund is added. There are 27 ways. With uniform independent symbols, this intentionally simple paytable is not tuned to a target RTP.

Players with fewer than 1 credit cannot spin. A transaction updates balance/counters and inserts the round together. `(playerId, requestId)` uniquely identifies a spin. Repeating it returns the original matrix and payout without charging or crediting again; the response also includes the latest player profile. Deposit/award request IDs are likewise idempotent, with mismatched reuse rejected.

## HTTP `/api/back-office`

- `GET /health`: database readiness.
- `GET /players`, `POST /players`: list / create a player (`displayName`, `balance`, `tags`).
- `GET /players/:id`, `PATCH /players/:id`: read / update display name, tags, or status. Balance cannot be patched.
- `DELETE /players/:id`: archive a player while retaining all history.
- `POST /targeting/preview`: audience matching with `playerIds`, required `tags`, `minBalance`, `maxBalance`, `minDeposits`. All filters intersect; only active players match.
- `GET /campaigns`, `POST /campaigns`, `PUT /campaigns/:id`, `DELETE /campaigns/:id`: campaign list / create / full update / archive.
- `POST /campaigns/:id/issue`: manually issue an active campaign, once per eligible player. At most 500 matching players per request; narrow targeting for larger audiences. Partial progress is persisted; retry skips already-issued awards.
- `GET /awards`, `POST /awards`: list / manual grant (`playerId`, `type`, `value`, `requestId`).
- `POST /awards/:id/revoke`: revoke a pending mini-game award. Delivered credits are immutable ledger records.
- `GET /deposits`: list mock deposits.
- `POST /simulation/deposits`: `{ playerId, amount, requestId }`; deposits credits and records a labeled mock deposit.
- `POST /simulation/sessions`: `{ playerId, daysAgo }`; records a labeled return session, never before the player's creation.
- `POST /simulation/seed`: `{ count: 1..100 }`; creates a cohort dated 14 days ago, starting with 100 credits, tagged `simulated`, with deterministic return sessions.
- `GET /analytics`: player activity, credits, awards, and D1/D7 retention.

List endpoints return up to 500 records; players, awards, and deposits support `?offset=500`. Campaign audiences and collections are intentionally simple PoC models. No arbitrary MongoDB query bodies are accepted.

A campaign has `name`, `description`, `status` (`draft`, `active`, `paused`, `archived`), `rewardType`, `rewardValue`, and `audience`. Reward types are `credits`, `wheel`, `chests`, `targets`, `scratch`. Credits are delivered immediately. Other types create pending one-play awards; their gameplay, redemption, expiration, and prize settlement are future work. Campaigns run manually via Issue; no scheduler is implied.

## WebSocket `/ws/games`

First send a session request:

```json
{"type":"session.open","requestId":"open-1"}
```

Without credentials this provisions a demo player with 100 credits and records a session. The response is `{ type: 'session.ready', requestId, player: { id, displayName, balance, status }, token }`. Reconnect using `playerId` and `token` in `session.open`. One player is bound to each socket; spin messages cannot select a different player.

```json
{"type":"slot.spin","requestId":"unique-spin-id"}
```

The response is `{ type: 'slot.result', requestId, result, player }`. `result` contains `spinId`, row-major `matrix[row][reel]`, all 27 `ways`, matching `wins`, `winCount`, `bet`, `payout`, and settlement `balance`. Each way contains a stable ID, selected rows, cell positions, symbols, and `isWin`.

Changes to a connected player's name, balance, or status emit `{ type: 'player.updated', player }`. Errors use `{ type: 'error', requestId, error: { code, message } }`. Requests require a nonblank ID of at most 128 characters; binary messages are rejected; maximum payload is 16 KiB.

## Collections and analytics

Collections: `players`, `sessions`, `deposits`, `campaigns`, `awards`, `gameRounds`. Collections and indexes initialize automatically. Rounds and credit grants serve as immutable records. Deleting players/campaigns means archival, not destructive deletion.

Retention uses player creation date as cohort day, distinct players returning on exactly D1 or D7, UTC calendar days, and only completed observation days. Game-player retention excludes simulated sessions; seeded-cohort retention is reported separately. Activity charts include both kinds with simulation counts. The simulator demonstrates measurement, not causal campaign uplift. Analytics currently aggregates collections in application memory and should move to bounded MongoDB aggregations as data grows.

## Verification

```sh
npm run typecheck
npm run build
npm test
npm start
```

Tests create a disposable MongoDB replica set, never using `.env` or your database. First run may download a MongoDB binary. They cover all payout tiers, duplicate and concurrent spins, insufficient balances, rollback on failed persistence, idempotent deposits, targeting and campaign grants, award revocation, retention, HTTP validation, and WebSocket player/balance flows.

## Scope

Local demo only: the administrative HTTP API has no operator authentication. Player tokens are simple demo session credentials, not a production identity system. Keep the default loopback binding. Starting credits are profile funding, not deposits. No real-money wallet, production gambling math, campaign scheduler, or mini-game redemption is implemented. Live balance notifications are in-process; a multi-instance deployment would need shared pub/sub.
