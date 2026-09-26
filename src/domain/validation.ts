import { z } from "zod";
export class DomainError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export const id = z.string().uuid();
const credits = z.number().int().min(0).max(1_000_000);
export const requestId = z.string().trim().min(1).max(128);
export const playerInput = z
  .object({
    displayName: z.string().trim().min(1).max(50),
    balance: credits.default(100),
    tags: z.array(z.string().trim().min(1).max(30)).max(10).default([]),
  })
  .strict();
export const playerPatch = playerInput
  .pick({ displayName: true, tags: true })
  .partial()
  .extend({ status: z.enum(["active", "archived"]).optional() })
  .strict();
export const audienceInput = z
  .object({
    playerIds: z.array(id).max(500).default([]),
    tags: z.array(z.string().trim().min(1).max(30)).max(10).default([]),
    minBalance: credits.default(0),
    maxBalance: credits.default(1_000_000),
    minDeposits: credits.default(0),
  })
  .strict()
  .refine(
    (v) => v.maxBalance >= v.minBalance,
    "Maximum balance must be at least the minimum",
  );
export const campaignInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().max(500).default(""),
    status: z.enum(["draft", "active", "paused", "archived"]).default("draft"),
    rewardType: z.enum(["credits", "wheel", "chests", "targets", "scratch"]),
    rewardValue: credits.min(1),
    audience: audienceInput,
  })
  .strict();
export const depositInput = z
  .object({ playerId: id, amount: credits.min(1), requestId })
  .strict();
export const awardInput = z
  .object({
    playerId: id,
    type: campaignInput.shape.rewardType,
    value: credits.min(1),
    requestId,
  })
  .strict();
export const simulationInput = z
  .object({ playerId: id, daysAgo: z.number().int().min(0).max(90).default(0) })
  .strict();
