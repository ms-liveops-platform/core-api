import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import type { LiveOpsService } from "../domain/service.js";
import { publicPlayer } from "../domain/models.js";
import { DomainError, requestId, id } from "../domain/validation.js";

export function attachGameSocket(
  server: Server,
  service: LiveOpsService | null,
) {
  const wss = new WebSocketServer({
    server,
    path: "/ws/games",
    maxPayload: 16 * 1024,
  });
  wss.on("error", () =>
    console.error("WebSocket server error. Check the configured port."),
  );
  wss.on("connection", (socket) => {
    let playerId: string | null = null;
    let busy = false;
    const send = (message: unknown) => {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify(message));
    };
    const fail = (
      code: string,
      message: string,
      requestId: string | null = null,
    ) => send({ type: "error", requestId, error: { code, message } });
    const updatePlayer = async (changedId: string) => {
      if (playerId !== changedId || !service) return;
      try {
        send({
          type: "player.updated",
          player: publicPlayer(await service.getPlayer(changedId)),
        });
      } catch {
        /* Next request reports the connection failure. */
      }
    };
    service?.on("player", updatePlayer);
    socket.on("close", () => service?.off("player", updatePlayer));
    socket.on("error", () => console.error("Game socket connection error."));
    socket.on("message", async (data, isBinary) => {
      if (isBinary) return fail("INVALID_MESSAGE", "Send a JSON text message.");
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return fail("INVALID_JSON", "Message must contain valid JSON.");
      }
      if (!message || typeof message !== "object" || Array.isArray(message))
        return fail("INVALID_MESSAGE", "Message must be an object.");
      const parsedId = requestId.safeParse(message.requestId);
      if (!parsedId.success)
        return fail(
          "INVALID_MESSAGE",
          "requestId must be a non-empty string of at most 128 characters.",
        );
      const rid = parsedId.data;
      if (!["session.open", "slot.spin"].includes(message.type))
        return fail(
          "UNKNOWN_MESSAGE_TYPE",
          "Supported types: session.open, slot.spin.",
          rid,
        );
      if (!service)
        return fail(
          "DATABASE_UNAVAILABLE",
          "Database is not configured. Set MONGO_DB_CONNECTION_STRING in core-api/.env.",
          rid,
        );
      if (busy)
        return fail(
          "REQUEST_IN_PROGRESS",
          "Wait for the previous request.",
          rid,
        );
      busy = true;
      try {
        if (message.type === "session.open") {
          if (playerId)
            throw new DomainError(
              409,
              "SESSION_EXISTS",
              "Session already opened.",
            );
          const credentials = z
            .object({ playerId: id.optional(), token: id.optional() })
            .refine(
              (v) => Boolean(v.playerId) === Boolean(v.token),
              "Player ID and token must be supplied together",
            )
            .parse(message);
          const opened = await service.openSession(
            credentials.playerId,
            credentials.token,
          );
          playerId = opened.player.id;
          send({ type: "session.ready", requestId: rid, ...opened });
        } else {
          if (!playerId)
            throw new DomainError(
              401,
              "SESSION_REQUIRED",
              "Open a player session before spinning.",
            );
          send({
            type: "slot.result",
            requestId: rid,
            result: await service.play(playerId, rid),
            player: publicPlayer(await service.getPlayer(playerId)),
          });
        }
      } catch (error) {
        if (error instanceof DomainError) fail(error.code, error.message, rid);
        else if (error instanceof z.ZodError)
          fail("INVALID_MESSAGE", "Invalid session credentials.", rid);
        else {
          console.error(
            "Game operation failed:",
            error instanceof Error ? error.name : "Unknown error",
          );
          fail("INTERNAL_ERROR", "Unable to complete this request.", rid);
        }
      } finally {
        busy = false;
      }
    });
  });
  return wss;
}
