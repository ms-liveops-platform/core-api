import express from "express";
import cors from "cors";
import { ZodError } from "zod";
import { backOfficeController } from "./controllers/back-office.controller.js";
import type { LiveOpsService } from "../domain/service.js";
import { DomainError } from "../domain/validation.js";

export function createApp(service: LiveOpsService | null = null) {
  const app = express();
  app.disable("x-powered-by");
  app.use(
    cors({
      origin: (
        process.env.BACK_OFFICE_ORIGINS ??
        "http://127.0.0.1:9999,http://localhost:9999"
      ).split(","),
    }),
  );
  app.use(express.json({ limit: "32kb" }));
  app.use("/api/back-office", backOfficeController(service));
  app.use((_req, res) => {
    res
      .status(404)
      .json({ error: { code: "NOT_FOUND", message: "Endpoint not found." } });
  });
  const errors: express.ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof ZodError) {
      res
        .status(400)
        .json({
          error: {
            code: "VALIDATION_ERROR",
            message: error.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; "),
          },
        });
      return;
    }
    if (error instanceof DomainError) {
      res
        .status(error.status)
        .json({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error.type === "entity.parse.failed") {
      res
        .status(400)
        .json({
          error: { code: "INVALID_JSON", message: "Invalid JSON body." },
        });
      return;
    }
    if (error.code === 11000) {
      res
        .status(409)
        .json({
          error: {
            code: "DUPLICATE_REQUEST",
            message:
              "This operation has already been recorded. Refresh to see the result.",
          },
        });
      return;
    }
    console.error("HTTP operation failed:", error.name);
    res
      .status(500)
      .json({
        error: {
          code: "INTERNAL_ERROR",
          message:
            "Operation failed. Check database connectivity and server logs.",
        },
      });
  };
  app.use(errors);
  return app;
}
