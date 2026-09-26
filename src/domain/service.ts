import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { MongoClient, Db, ClientSession, Filter } from "mongodb";
import { collections } from "../db/database.js";
import { spin } from "../games/slots/slot-engine.js";
import type { Audience, Award, Campaign, Player, PaidSpin } from "./models.js";
import { publicPlayer } from "./models.js";
import { DomainError } from "./validation.js";

export function payoutFor(result: ReturnType<typeof spin>, bet = 1) {
  return result.wins.reduce(
    (sum, win) =>
      sum + bet * (win.symbols[0] < 3 ? 1 : win.symbols[0] < 6 ? 3 : 10),
    0,
  );
}
export class LiveOpsService extends EventEmitter {
  readonly c;
  constructor(
    readonly client: MongoClient,
    readonly db: Db,
    private generate = spin,
  ) {
    super();
    this.setMaxListeners(0);
    this.c = collections(db);
  }
  private async transaction<T>(
    fn: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    return this.client.withSession(async (session) => {
      const result = await session.withTransaction(() => fn(session), {
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
      });
      return result as T;
    });
  }
  async getPlayer(playerId: string, session?: ClientSession) {
    const player = await this.c.players.findOne({ _id: playerId }, { session });
    if (!player)
      throw new DomainError(404, "PLAYER_NOT_FOUND", "Player not found.");
    return player;
  }
  private active(player: Player) {
    if (player.status !== "active")
      throw new DomainError(409, "PLAYER_ARCHIVED", "This player is archived.");
  }
  async createPlayer(input: {
    displayName: string;
    balance: number;
    tags: string[];
  }) {
    const player: Player = {
      _id: randomUUID(),
      ...input,
      status: "active",
      gameToken: randomUUID(),
      createdAt: new Date(),
      lastSeenAt: null,
      depositTotal: 0,
      spinCount: 0,
      totalBet: 0,
      totalPayout: 0,
    };
    await this.c.players.insertOne(player);
    return player;
  }
  async updatePlayer(
    playerId: string,
    patch: Partial<Pick<Player, "displayName" | "tags" | "status">>,
  ) {
    const p = await this.c.players.findOneAndUpdate(
      { _id: playerId },
      { $set: patch },
      { returnDocument: "after" },
    );
    if (!p) throw new DomainError(404, "PLAYER_NOT_FOUND", "Player not found.");
    this.emit("player", playerId);
    return p;
  }
  async openSession(playerId?: string, token?: string) {
    let player: Player;
    if (playerId) {
      player = await this.getPlayer(playerId);
      if (player.gameToken !== token)
        throw new DomainError(
          401,
          "INVALID_PLAYER_TOKEN",
          "Invalid player access token.",
        );
    } else
      player = await this.createPlayer({
        displayName: `Player ${randomUUID().slice(0, 6)}`,
        balance: 100,
        tags: ["demo"],
      });
    this.active(player);
    const now = new Date();
    await this.transaction(async (session) => {
      const updated = await this.c.players.updateOne(
        { _id: player._id, status: "active" },
        { $max: { lastSeenAt: now } },
        { session },
      );
      if (!updated.matchedCount)
        throw new DomainError(
          409,
          "PLAYER_ARCHIVED",
          "This player is archived.",
        );
      await this.c.sessions.insertOne(
        {
          _id: randomUUID(),
          playerId: player._id,
          createdAt: now,
          simulated: false,
        },
        { session },
      );
    });
    return {
      player: publicPlayer(await this.getPlayer(player._id)),
      token: player.gameToken,
    };
  }
  async play(playerId: string, requestId: string): Promise<PaidSpin> {
    const generated = this.generate();
    const payout = payoutFor(generated);
    const result = await this.transaction(async (session) => {
      const prior = await this.c.rounds.findOne(
        { playerId, requestId },
        { session },
      );
      if (prior) return prior.result;
      const player = await this.getPlayer(playerId, session);
      this.active(player);
      if (player.balance < 1)
        throw new DomainError(
          409,
          "INSUFFICIENT_BALANCE",
          "Insufficient balance. Add mock credits in the back office.",
        );
      const updated = await this.c.players.findOneAndUpdate(
        { _id: playerId, status: "active", balance: { $gte: 1 } },
        {
          $inc: {
            balance: payout - 1,
            spinCount: 1,
            totalBet: 1,
            totalPayout: payout,
          },
          $set: { lastSeenAt: new Date() },
        },
        { session, returnDocument: "after" },
      );
      if (!updated)
        throw new DomainError(
          409,
          "INSUFFICIENT_BALANCE",
          "Insufficient balance.",
        );
      const paid: PaidSpin = {
        ...generated,
        bet: 1,
        payout,
        balance: updated.balance,
      };
      await this.c.rounds.insertOne(
        {
          _id: generated.spinId,
          playerId,
          requestId,
          result: paid,
          createdAt: new Date(),
        },
        { session },
      );
      return paid;
    });
    this.emit("player", playerId);
    return result;
  }
  async deposit(input: {
    playerId: string;
    amount: number;
    requestId: string;
  }) {
    const result = await this.transaction(async (session) => {
      const prior = await this.c.deposits.findOne(
        { requestId: input.requestId },
        { session },
      );
      if (prior) {
        if (prior.playerId !== input.playerId || prior.amount !== input.amount)
          throw new DomainError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "Request ID already used with different deposit data.",
          );
        return prior;
      }
      const p = await this.getPlayer(input.playerId, session);
      this.active(p);
      const deposit = {
        _id: randomUUID(),
        ...input,
        createdAt: new Date(),
        simulated: true as const,
      };
      await this.c.players.updateOne(
        { _id: p._id },
        { $inc: { balance: input.amount, depositTotal: input.amount } },
        { session },
      );
      await this.c.deposits.insertOne(deposit, { session });
      return deposit;
    });
    this.emit("player", input.playerId);
    return result;
  }
  audienceFilter(a: Audience): Filter<Player> {
    return {
      status: "active",
      balance: { $gte: a.minBalance, $lte: a.maxBalance },
      depositTotal: { $gte: a.minDeposits },
      ...(a.tags.length ? { tags: { $all: a.tags } } : {}),
      ...(a.playerIds.length ? { _id: { $in: a.playerIds } } : {}),
    };
  }
  async createCampaign(
    input: Omit<Campaign, "_id" | "createdAt" | "updatedAt">,
  ) {
    const campaign: Campaign = {
      _id: randomUUID(),
      ...input,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await this.c.campaigns.insertOne(campaign);
    return campaign;
  }
  async updateCampaign(
    campaignId: string,
    input: Omit<Campaign, "_id" | "createdAt" | "updatedAt">,
  ) {
    const c = await this.c.campaigns.findOneAndUpdate(
      { _id: campaignId },
      { $set: { ...input, updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!c)
      throw new DomainError(404, "CAMPAIGN_NOT_FOUND", "Campaign not found.");
    return c;
  }
  async grant(
    input: {
      playerId: string;
      type: Award["type"];
      value: number;
      requestId: string;
    },
    campaignId: string | null = null,
  ) {
    const award = await this.transaction(async (session) => {
      const prior = await this.c.awards.findOne(
        { requestId: input.requestId },
        { session },
      );
      if (prior) {
        if (
          prior.playerId !== input.playerId ||
          prior.type !== input.type ||
          prior.value !== input.value
        )
          throw new DomainError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "Request ID already used with different award data.",
          );
        return prior;
      }
      const player = await this.getPlayer(input.playerId, session);
      this.active(player);
      if (campaignId) {
        const campaign = await this.c.campaigns.findOne(
          { _id: campaignId, status: "active" },
          { session },
        );
        if (
          !campaign ||
          !(await this.c.players.findOne(
            { ...this.audienceFilter(campaign.audience), _id: player._id },
            { session },
          )) ||
          (campaign.audience.playerIds.length &&
            !campaign.audience.playerIds.includes(player._id))
        )
          throw new DomainError(
            409,
            "NOT_ELIGIBLE",
            "Campaign is inactive or player no longer eligible.",
          );
        input = {
          ...input,
          type: campaign.rewardType,
          value: campaign.rewardValue,
        };
      }
      const record: Award = {
        _id: randomUUID(),
        ...input,
        campaignId,
        status: input.type === "credits" ? "credited" : "pending",
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      if (input.type === "credits")
        await this.c.players.updateOne(
          { _id: player._id },
          { $inc: { balance: input.value } },
          { session },
        );
      await this.c.awards.insertOne(record, { session });
      return record;
    });
    this.emit("player", input.playerId);
    return award;
  }
  async issueCampaign(campaignId: string) {
    const campaign = await this.c.campaigns.findOne({
      _id: campaignId,
      status: "active",
    });
    if (!campaign)
      throw new DomainError(
        409,
        "CAMPAIGN_INACTIVE",
        "Activate the campaign before issuing awards.",
      );
    const eligible = await this.c.players
      .find(this.audienceFilter(campaign.audience))
      .limit(501)
      .toArray();
    if (eligible.length > 500)
      throw new DomainError(
        400,
        "AUDIENCE_TOO_LARGE",
        "Narrow the audience to at most 500 players for this PoC.",
      );
    let granted = 0;
    let skipped = 0;
    for (const p of eligible) {
      if (await this.c.awards.findOne({ campaignId, playerId: p._id })) {
        skipped++;
        continue;
      }
      try {
        await this.grant(
          {
            playerId: p._id,
            type: campaign.rewardType,
            value: campaign.rewardValue,
            requestId: `campaign:${campaignId}:${p._id}`,
          },
          campaignId,
        );
        granted++;
      } catch (error) {
        if (error instanceof DomainError && error.code === "NOT_ELIGIBLE") {
          skipped++;
          continue;
        }
        throw error;
      }
    }
    return { eligible: eligible.length, granted, skipped };
  }
  async revoke(awardId: string) {
    const award = await this.c.awards.findOneAndUpdate(
      { _id: awardId, status: "pending" },
      { $set: { status: "revoked", updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!award)
      throw new DomainError(
        409,
        "AWARD_NOT_PENDING",
        "Only pending mini-game awards can be revoked. Credited awards are retained as ledger records.",
      );
    return award;
  }
  async simulateSession(playerId: string, daysAgo: number) {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - daysAgo);
    return this.transaction(async (session) => {
      const p = await this.getPlayer(playerId, session);
      this.active(p);
      if (date < p.createdAt)
        throw new DomainError(
          400,
          "BEFORE_CREATION",
          "A session cannot predate player creation. Seed a cohort for historical data.",
        );
      await this.c.players.updateOne(
        { _id: playerId },
        { $max: { lastSeenAt: date } },
        { session },
      );
      const record = {
        _id: randomUUID(),
        playerId,
        createdAt: date,
        simulated: true,
      };
      await this.c.sessions.insertOne(record, { session });
      return record;
    });
  }
  async seed(count: number) {
    return this.transaction(async (session) => {
      const players: Player[] = [];
      for (let i = 0; i < count; i++) {
        const createdAt = new Date();
        createdAt.setUTCDate(createdAt.getUTCDate() - 14);
        const p: Player = {
          _id: randomUUID(),
          displayName: `Demo ${randomUUID().slice(0, 5)}`,
          balance: 100,
          tags: ["simulated"],
          status: "active",
          gameToken: randomUUID(),
          createdAt,
          lastSeenAt: createdAt,
          depositTotal: 0,
          spinCount: 0,
          totalBet: 0,
          totalPayout: 0,
        };
        players.push(p);
        await this.c.players.insertOne(p, { session });
        for (const offset of [
          0,
          ...(i % 2 === 0 ? [1] : []),
          ...(i % 4 === 0 ? [7] : []),
        ]) {
          const date = new Date(createdAt);
          date.setUTCDate(date.getUTCDate() + offset);
          await this.c.sessions.insertOne(
            {
              _id: randomUUID(),
              playerId: p._id,
              createdAt: date,
              simulated: true,
            },
            { session },
          );
          await this.c.players.updateOne(
            { _id: p._id },
            { $max: { lastSeenAt: date } },
            { session },
          );
        }
      }
      return { created: players.length };
    });
  }
  async analytics() {
    const [players, sessions, awards, deposits, rounds] = await Promise.all([
      this.c.players.find().toArray(),
      this.c.sessions.find().toArray(),
      this.c.awards.find().toArray(),
      this.c.deposits.find().toArray(),
      this.c.rounds.find().toArray(),
    ]);
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const today = day(new Date());
    const retention = (days: number, simulated: boolean) => {
      const cohort = players.filter(
        (p) =>
          p.tags.includes("simulated") === simulated &&
          day(new Date(p.createdAt.getTime() + days * 86400000)) < today,
      );
      const returned = cohort.filter((p) =>
        sessions.some(
          (s) =>
            s.playerId === p._id &&
            (simulated || !s.simulated) &&
            day(s.createdAt) ===
              day(new Date(p.createdAt.getTime() + days * 86400000)),
        ),
      ).length;
      return {
        eligible: cohort.length,
        returned,
        rate: cohort.length
          ? Math.round((returned / cohort.length) * 1000) / 10
          : null,
      };
    };
    const activity = Array.from({ length: 15 }, (_, i) => {
      const date = new Date();
      date.setUTCDate(date.getUTCDate() - 14 + i);
      const key = day(date);
      const visits = sessions.filter((s) => day(s.createdAt) === key);
      return {
        date: key,
        players: new Set(visits.map((s) => s.playerId)).size,
        simulated: visits.filter((s) => s.simulated).length,
        sessions: visits.length,
      };
    });
    return {
      playerCount: players.length,
      activePlayers: players.filter((p) => p.status === "active").length,
      totalBalance: players.reduce((s, p) => s + p.balance, 0),
      spins: rounds.length,
      totalBet: rounds.reduce((s, r) => s + r.result.bet, 0),
      totalPayout: rounds.reduce((s, r) => s + r.result.payout, 0),
      deposits: deposits.reduce((s, d) => s + d.amount, 0),
      awards: {
        total: awards.length,
        pending: awards.filter((a) => a.status === "pending").length,
        credited: awards.filter((a) => a.status === "credited").length,
        revoked: awards.filter((a) => a.status === "revoked").length,
        creditValue: awards
          .filter((a) => a.status === "credited")
          .reduce((s, a) => s + a.value, 0),
      },
      retention: {
        real: { d1: retention(1, false), d7: retention(7, false) },
        simulated: { d1: retention(1, true), d7: retention(7, true) },
      },
      activity,
    };
  }
}
