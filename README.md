# Core API

Node.js / TypeScript backend with Express HTTP scaffolding and a native WebSocket protocol for games-web. Express and WebSockets share one HTTP server.

## Run

Requires Node.js 20 or newer and npm.

```sh
npm install
npm run dev
```

`npm run dev` watches the TypeScript source and restarts the server automatically when files change.

Defaults to `127.0.0.1:5555`. Configure using environment variables, e.g. `HOST=0.0.0.0 PORT=3001 npm run dev`. `.env.example` documents these variables; environment files are not loaded automatically.

```sh
npm run typecheck
npm test
npm run build
npm start
```

## HTTP

An empty back-office controller is mounted at `/api/back-office` in `src/http/controllers/back-office.controller.ts`. No business endpoints are implemented yet; unmatched requests return JSON with HTTP 404.

## WebSocket

Connect with the browser's native `WebSocket` to `ws://127.0.0.1:5555/ws/games` (not Socket.IO).

```js
const socket = new WebSocket('ws://127.0.0.1:5555/ws/games');
socket.onmessage = (event) => console.log(JSON.parse(event.data));
socket.onopen = () => socket.send(JSON.stringify({
  type: 'slot.spin',
  requestId: crypto.randomUUID(),
}));
```

The response is `{ type: 'slot.result', requestId, result }`. `result` contains:

- `spinId`: server-generated UUID.
- `matrix`: three rows, each containing three numeric symbols. Access with `matrix[row][reel]`; row 0 is top, reel 0 is left.
- `ways`: all 27 evaluated ways. Each includes `id` (0–26), `rows` (one row per reel), `positions` (`{row, reel}` per cell), `symbols`, and `isWin`.
- `wins`: the subset of ways with three matching symbols.
- `winCount`: number of winning ways, not a monetary payout.

For example, `[[9,1,2],[3,4,9],[5,9,6]]` wins on rows `[0,2,1]`, connecting the top-left, bottom-middle, and middle-right cells.

Each cell independently draws a uniform integer from 0 through 9 using Node's `crypto.randomInt`. All 3 × 3 × 3 row combinations are evaluated; adjacent rows are not required. Only three identical symbols across all three reels win. Zero is an ordinary symbol. Repeated matching symbols count as distinct ways: two matches on reel one, one on reel two, and three on reel three produce six wins. A board of one symbol produces 27 wins.

Errors use `{ type: 'error', requestId, error: { code, message } }`. Codes are `INVALID_JSON`, `INVALID_MESSAGE`, `UNKNOWN_MESSAGE_TYPE`, and `INTERNAL_ERROR`. An unvalidated request ID is returned as `null`. IDs must be nonblank strings of at most 128 characters. Binary messages are rejected; payloads above 16 KiB close the connection.

## Scope and extension points

This is a stateless local PoC: no authentication, database, balance, bet, payout table, weighted reel strips, or persisted rounds yet. `requestId` correlates responses; it does not provide idempotency. Every valid request generates a fresh spin, including repeated IDs. On reconnection, no previous results are restored.

Slot generation and win evaluation live in `src/games/slots/slot-engine.ts`, independently of the transport. Future wheel, chest, and other generators can live alongside `slots`, with their message handlers added to `src/websocket/game-socket.ts`.

The WebSocket setup follows the [ws shared HTTP server API](https://github.com/websockets/ws#external-https-server).
