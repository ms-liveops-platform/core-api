import { Router } from "express";
import { z } from "zod";
import type { LiveOpsService } from "../../domain/service.js";
import {
  DomainError,
  id,
  playerInput,
  playerPatch,
  audienceInput,
  campaignInput,
  awardInput,
  depositInput,
  simulationInput,
} from "../../domain/validation.js";

export function backOfficeController(service: LiveOpsService | null) {
  const router = Router();
  router.get("/health", async (_req, res) => {
    if (!service) {
      res
        .status(503)
        .json({
          ready: false,
          message:
            "Set MONGO_DB_CONNECTION_STRING in core-api/.env and restart core-api.",
        });
      return;
    }
    await service.db.command({ ping: 1 });
    res.json({ ready: true });
  });
  router.use((_req, _res, next) =>
    service
      ? next()
      : next(
          new DomainError(
            503,
            "DATABASE_UNAVAILABLE",
            "Set MONGO_DB_CONNECTION_STRING in core-api/.env and restart core-api.",
          ),
        ),
  );
  const s = service!;
  const page = (value: unknown) =>
    z.coerce.number().int().min(0).max(100000).default(0).parse(value);
  router.get("/players", async (req, res) =>
    res.json(
      await s.c.players
        .find()
        .sort({ createdAt: -1 })
        .skip(page(req.query.offset))
        .limit(500)
        .toArray(),
    ),
  );
  router.get("/players/:id", async (req, res) =>
    res.json(await s.getPlayer(id.parse(req.params.id))),
  );
  router.post("/players", async (req, res) =>
    res.status(201).json(await s.createPlayer(playerInput.parse(req.body))),
  );
  router.patch("/players/:id", async (req, res) =>
    res.json(
      await s.updatePlayer(
        id.parse(req.params.id),
        playerPatch.parse(req.body),
      ),
    ),
  );
  router.delete("/players/:id", async (req, res) =>
    res.json(
      await s.updatePlayer(id.parse(req.params.id), { status: "archived" }),
    ),
  );
  router.post("/targeting/preview", async (req, res) => {
    const filter = s.audienceFilter(audienceInput.parse(req.body));
    const [count, players] = await Promise.all([
      s.c.players.countDocuments(filter),
      s.c.players.find(filter).limit(500).toArray(),
    ]);
    res.json({ count, players });
  });
  router.get("/campaigns", async (_req, res) =>
    res.json(
      await s.c.campaigns.find().sort({ createdAt: -1 }).limit(500).toArray(),
    ),
  );
  router.post("/campaigns", async (req, res) =>
    res.status(201).json(await s.createCampaign(campaignInput.parse(req.body))),
  );
  router.put("/campaigns/:id", async (req, res) =>
    res.json(
      await s.updateCampaign(
        id.parse(req.params.id),
        campaignInput.parse(req.body),
      ),
    ),
  );
  router.delete("/campaigns/:id", async (req, res) => {
    const c = await s.c.campaigns.findOneAndUpdate(
      { _id: id.parse(req.params.id) },
      { $set: { status: "archived", updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!c)
      throw new DomainError(404, "CAMPAIGN_NOT_FOUND", "Campaign not found.");
    res.json(c);
  });
  router.post("/campaigns/:id/issue", async (req, res) =>
    res.json(await s.issueCampaign(id.parse(req.params.id))),
  );
  router.get("/awards", async (req, res) =>
    res.json(
      await s.c.awards
        .find()
        .sort({ createdAt: -1 })
        .skip(page(req.query.offset))
        .limit(500)
        .toArray(),
    ),
  );
  router.post("/awards", async (req, res) =>
    res.status(201).json(await s.grant(awardInput.parse(req.body))),
  );
  router.post("/awards/:id/revoke", async (req, res) =>
    res.json(await s.revoke(id.parse(req.params.id))),
  );
  router.get("/deposits", async (req, res) =>
    res.json(
      await s.c.deposits
        .find()
        .sort({ createdAt: -1 })
        .skip(page(req.query.offset))
        .limit(500)
        .toArray(),
    ),
  );
  router.post("/simulation/deposits", async (req, res) =>
    res.status(201).json(await s.deposit(depositInput.parse(req.body))),
  );
  router.post("/simulation/sessions", async (req, res) => {
    const data = simulationInput.parse(req.body);
    res.status(201).json(await s.simulateSession(data.playerId, data.daysAgo));
  });
  router.post("/simulation/seed", async (req, res) => {
    const data = z
      .object({ count: z.number().int().min(1).max(100) })
      .strict()
      .parse(req.body);
    res.status(201).json(await s.seed(data.count));
  });
  router.get("/analytics", async (_req, res) => res.json(await s.analytics()));
  return router;
}
