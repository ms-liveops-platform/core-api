import { createCoreServer } from './server.js';

const port = Number(process.env.PORT ?? 5555);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}
const host = process.env.HOST ?? '127.0.0.1';
const { server, close } = createCoreServer();
server.on('error', (error) => {
  console.error('Server failed:', error.message);
  process.exitCode = 1;
});
server.listen(port, host, () => {
  console.log(`Core API listening on http://${host}:${port}; game socket: /ws/games`);
});
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void close().catch((error) => { console.error(error); process.exitCode = 1; });
  });
}
