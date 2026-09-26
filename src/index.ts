import "dotenv/config";
import { MongoClient } from "mongodb";
import { initializeDatabase } from "./db/database.js";
import { LiveOpsService } from "./domain/service.js";
import { createCoreServer } from "./server.js";

const port = Number(process.env.PORT ?? 5555);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}
const host = process.env.HOST ?? "127.0.0.1";
let client: MongoClient | null = null;
let service: LiveOpsService | null = null;
const connectionString = process.env.MONGO_DB_CONNECTION_STRING;
if (connectionString) {
  client = new MongoClient(connectionString, {
    serverSelectionTimeoutMS: 5000,
  });
  try {
    const db = client.db(process.env.MONGO_DB_NAME || undefined);
    await initializeDatabase(client, db);
    service = new LiveOpsService(client, db);
    console.log("MongoDB connected and indexes initialized.");
  } catch {
    await client.close();
    console.error(
      "MongoDB initialization failed. Check the connection string, network access, and replica-set/Atlas configuration.",
    );
    process.exit(1);
  }
} else
  console.warn(
    "MONGO_DB_CONNECTION_STRING is missing. Database-backed features will return 503.",
  );
const { server, close } = createCoreServer(service);
server.on("error", (error) => {
  console.error("Server failed:", error.message);
  process.exitCode = 1;
});
server.listen(port, host, () => {
  console.log(
    `Core API listening on http://${host}:${port}; game socket: /ws/games`,
  );
});
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void close()
      .then(() => client?.close())
      .catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
  });
}
