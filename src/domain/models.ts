import type { SpinResult } from "../games/slots/slot-engine.js";
export interface Player {
  _id: string;
  displayName: string;
  balance: number;
  tags: string[];
  status: "active" | "archived";
  gameToken: string;
  createdAt: Date;
  lastSeenAt: Date | null;
  depositTotal: number;
  spinCount: number;
  totalBet: number;
  totalPayout: number;
}
export interface Audience {
  playerIds: string[];
  tags: string[];
  minBalance: number;
  maxBalance: number;
  minDeposits: number;
}
export interface Campaign {
  _id: string;
  name: string;
  description: string;
  status: "draft" | "active" | "paused" | "archived";
  rewardType: "credits" | "wheel" | "chests" | "targets" | "scratch";
  rewardValue: number;
  audience: Audience;
  createdAt: Date;
  updatedAt: Date;
}
export interface Award {
  _id: string;
  playerId: string;
  campaignId: string | null;
  type: Campaign["rewardType"];
  value: number;
  status: "pending" | "credited" | "revoked";
  createdAt: Date;
  updatedAt: Date;
  requestId: string;
}
export interface Deposit {
  _id: string;
  playerId: string;
  amount: number;
  createdAt: Date;
  requestId: string;
  simulated: true;
}
export interface Session {
  _id: string;
  playerId: string;
  createdAt: Date;
  simulated: boolean;
}
export interface Round {
  _id: string;
  playerId: string;
  requestId: string;
  result: PaidSpin;
  createdAt: Date;
}
export interface PaidSpin extends SpinResult {
  bet: number;
  payout: number;
  balance: number;
}
export const publicPlayer = (p: Player) => ({
  id: p._id,
  displayName: p.displayName,
  balance: p.balance,
  status: p.status,
});
