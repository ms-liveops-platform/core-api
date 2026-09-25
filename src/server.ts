import { createServer } from 'node:http';
import { createApp } from './http/app.js';
import { attachGameSocket } from './websocket/game-socket.js';

export function createCoreServer() {
  const server = createServer(createApp());
  const wss = attachGameSocket(server);
  const close = async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve, reject) => wss.close((error) => error ? reject(error) : resolve()));
    if (server.listening) {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
  return { server, wss, close };
}
