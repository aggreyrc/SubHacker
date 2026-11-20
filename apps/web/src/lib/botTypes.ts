// Shapes returned by /api/bots/* (see apps/api/src/modules/bots/bots.service.ts). Decimals
// arrive as strings over JSON; JSON columns (riskParams, stakingState, riskState) are typed
// to what the server's own Zod schemas guarantee.

export type BotStaking =
  | { mode: "FIXED"; stake: number }
  | { mode: "MARTINGALE"; baseStake: number; multiplierOnLoss: number; maxSteps: number; resetOnWin: boolean };

export interface BotRiskLimits {
  stopLossAmount?: number;
  targetProfitAmount?: number;
  maxConsecutiveLosses?: number;
  maxTradesPerSession?: number;
}

export interface IndicatorRiskParams {
  staking: BotStaking;
  riskLimits: BotRiskLimits;
}

/** An imported Deriv Bot decides its own stakes, so the user's settings are a hard ceiling per
 *  trade (the bot is stopped, never clamped, if it tries to go above it) plus the usual kill
 *  switches, and a value for each question the imported bot asks. */
export interface ProgramRiskParams {
  program: { maxStakePerTrade: number; inputs: Record<string, number> };
  riskLimits: BotRiskLimits;
}

export type BotRiskParams = IndicatorRiskParams | ProgramRiskParams;

export const isProgramParams = (p: BotRiskParams): p is ProgramRiskParams => "program" in p;

interface CatalogBase {
  id: string;
  key: string;
  name: string;
  description: string;
  contractTypes: string[];
}

export interface IndicatorCatalogEntry extends CatalogBase {
  kind: "indicator";
  candleGranularitySeconds: number;
  indicators: string[];
  tradeParams: { durationValue: number; durationUnit: string };
  suggested: IndicatorRiskParams;
}

export interface ProgramCatalogEntry extends CatalogBase {
  kind: "program";
  suggestedSymbol: string;
  /** Labels of the questions the imported bot asks (e.g. "Stake", "Target Profit"). */
  prompts: string[];
}

export type BotCatalogEntry = IndicatorCatalogEntry | ProgramCatalogEntry;

export type BotStatus = "DRAFT" | "RUNNING" | "PAUSED" | "STOPPED" | "ERROR";

export interface BotView {
  id: string;
  name: string;
  symbol: string;
  status: BotStatus;
  stopReason: string | null;
  lastError: string | null;
  lastEvaluatedAt: string | null;
  startedAt: string | null;
  riskParams: BotRiskParams;
  stakingState: { currentStep: number; program?: { initialized: boolean } };
  riskState: { sessionProfitLoss: number; consecutiveLosses: number; tradesCount: number };
  strategy: { id: string; name: string };
  derivAccount: { id: string; derivAccountId: string; accountType: "REAL" | "DEMO"; currency: string };
}

export interface BotTradeView {
  id: string;
  contractId: string;
  contractType: string;
  stake: string;
  stakeStep: number;
  profit: string | null;
  status: "OPEN" | "CLOSED" | "SOLD" | "CANCELLED";
  placedAt: string;
}

export interface CreateBotInput {
  strategyId: string;
  accountId: string;
  name: string;
  symbol: string;
  riskParams: BotRiskParams;
  confirmReal: boolean;
}
