// The server-side, always-on bot runner (the user chose "server-side, always-on" over a
// browser-driven loop). One in-process runner evaluates every RUNNING BotInstance on a timer,
// independent of whether the owner has the site open.
//
// What keeps this safe to leave unattended:
//  - Fail closed. Anything unexpected (bad definition, expired Deriv auth, a settlement that
//    never arrives, repeated errors) STOPS the instance with a reason; it never guesses and
//    never keeps trading.
//  - One open trade per instance, evaluated on CLOSED candles only, once per candle.
//  - Stake is never higher than the user's configured ladder: if Deriv's quoted price exceeds
//    the intended stake the trade is refused.
//  - Real accounts re-checked on every trade: REAL requires the instance's own confirmReal.
//  - The runner only ever trades the instance owner's OWN account through their own
//    authenticated session (TradingSessionManager). Admin has no path into any of this.
//  - State (ladder position, session P/L, open trade) lives in the database, so a process
//    restart resumes exactly where it left off — see start().
//
// Two kinds of strategy run here. INDICATOR strategies are evaluated once per closed candle. An
// imported Deriv Bot PROGRAM (dbot/) runs as a loop — start-up once, then for every trade: trade
// options → "before purchase" → buy → wait for settlement → "after purchase" — driven by the
// interpreter in dbot/interpreter.ts. A program decides its own stakes, but it can never go past
// the user's per-trade ceiling, stop-loss, target or trade limits: those are checked HERE, outside
// the program, before every purchase and after every settlement.
//
// Dependencies are injected so every decision here is unit-testable without Deriv or Postgres.

import { randomInt } from "node:crypto";
import type { BotInstance, BotStrategy, DerivAccount, PrismaClient } from "@derivdesk/db";
import { logger } from "../../lib/logger.js";
import type { recordAudit } from "../../lib/audit.js";
import type { MarketDataGateway } from "../market/market.gateway.js";
import type { TradingSessionManager } from "../trading/trading.sessionManager.js";
import { evaluateStrategy } from "./signalEngine.js";
import { strategyDefinitionSchema, type StrategyDefinition } from "./strategy.schema.js";
import { botRiskParamsSchema, isProgramParams, riskStateSchema, stakingStateSchema, type IndicatorRiskParams, type ProgramRiskParams, type ProgramState } from "./botParams.js";
import { advanceRiskState, advanceStakingState, checkRiskLimits, nextStake, type RiskState, type StakingState, type StopReason } from "./staking.js";
import type { ContractType, DerivTick } from "../market/market.schemas.js";
import { BARRIER_DIGIT_TYPES, dbotDefinitionSchema, validateProgram, type DbotDefinition } from "./dbot/program.js";
import { ProgramError, runStage, usesBlock, type StageContext } from "./dbot/interpreter.js";

const CANDLE_COUNT = 200; // plenty of history for EMA(25)/MACD(26+9) to be warm
const MAX_CONSECUTIVE_ERRORS = 5;
const STAKE_TOLERANCE = 0.005; // half a cent — rounding slack only
const MIN_POLL_MS = 5_000;
const MAX_POLL_MS = 15_000;
const SETTLEMENT_GRACE_MS = 120_000;
const PROGRAM_POLL_MS = 5_000; // fallback tick for programs; trades normally chain straight from settlement
const PROGRAM_MIN_GAP_MS = 1_000; // never place trades faster than this, whatever the program asks
const PROGRAM_MAX_WAIT_MS = 30_000; // longest a program's own delays are honoured
const PROGRAM_MAX_IDLE_CYCLES = 200; // "before purchase" ran this many times without buying: the program can't trade
const NO_LADDER = { mode: "FIXED", stake: 1 } as const; // programs have no ladder; satisfies checkRiskLimits

type ParsedDefinition = { kind: "indicator"; def: StrategyDefinition } | { kind: "program"; def: DbotDefinition };

/** The stored definition is never trusted just because it is in the database. */
export function parseDefinition(raw: unknown): ParsedDefinition | null {
  if (typeof raw === "object" && raw !== null && (raw as { kind?: unknown }).kind === "dbot") {
    const r = dbotDefinitionSchema.safeParse(raw);
    return r.success ? { kind: "program", def: r.data } : null;
  }
  const r = strategyDefinitionSchema.safeParse(raw);
  return r.success ? { kind: "indicator", def: r.data } : null;
}

export function lastDigitOf(tick: Pick<DerivTick, "quote" | "pip_size">): number | null {
  const text = typeof tick.pip_size === "number" && tick.pip_size >= 0 && tick.pip_size <= 8 ? tick.quote.toFixed(tick.pip_size) : String(tick.quote);
  const digit = Number(text[text.length - 1]);
  return Number.isInteger(digit) ? digit : null;
}

function durationMs(unit: string, value: number): number {
  const per = unit === "t" ? 2_000 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return value * per;
}

// Explicit shape (not Prisma.BotInstanceGetPayload) so this typechecks identically against the
// real generated client and this sandbox's interim typing shim.
type LoadedInstance = BotInstance & { strategy: BotStrategy; derivAccount: DerivAccount; user: { handle: string } };

export interface BotRunnerDeps {
  db: PrismaClient;
  market: Pick<MarketDataGateway, "getCandles"> & Partial<Pick<MarketDataGateway, "subscribeTicks">>;
  trading: Pick<TradingSessionManager, "buy" | "subscribePosition" | "getProposal">;
  audit: typeof recordAudit;
  now?: () => number;
  /** Leader gate (see lib/runnerLease.ts). The runner only attaches, evaluates and — checked
   *  again immediately before every order — trades while this returns true. Defaults to always
   *  true so a single-process setup and the unit tests behave as before. */
  canTrade?: () => boolean;
  /** Waits for a program's own delays. Injectable so tests don't wait. */
  sleep?: (ms: number) => Promise<void>;
}

interface Runtime {
  timer: NodeJS.Timeout | null;
  busy: boolean;
  lastCandleEpoch: number | null;
  consecutiveErrors: number;
  unsubscribe: (() => void) | null;
  settleTimer: NodeJS.Timeout | null;
  // programs only
  lastDigit: number | null;
  tickUnsub: (() => void) | null;
  notBefore: number; // epoch ms: don't start the next trade before this
  nextTimer: NodeJS.Timeout | null;
  idleCycles: number;
}

export class BotRunner {
  private runtimes = new Map<string, Runtime>();
  private readonly now: () => number;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private reconciling = false;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: BotRunnerDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Call once at process start: re-attaches every instance that was RUNNING when the last
   *  process stopped, and resumes watching any trade still OPEN for it. */
  async start(options: { reconcileEveryMs?: number } = {}): Promise<void> {
    const running = await this.deps.db.botInstance.findMany({ where: { status: "RUNNING" } });
    for (const { id } of running) await this.attach(id);
    logger.info({ count: running.length }, "bot runner started");
    // A bot started or stopped through ANOTHER API instance only changes its database row; the
    // leader notices here. (attach() on a non-leader is a deliberate no-op.)
    const every = options.reconcileEveryMs ?? 10_000;
    if (every > 0 && !this.reconcileTimer) {
      this.reconcileTimer = setInterval(() => void this.reconcile(), every);
      this.reconcileTimer.unref?.();
    }
  }

  /** Graceful shutdown: stops timers/subscriptions only. Instance rows stay RUNNING so the
   *  next process (or the next leader) picks them up. Also what runs when leadership is lost. */
  shutdown(): void {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
    for (const id of [...this.runtimes.keys()]) this.detach(id);
  }

  /** Makes the in-memory set of attached instances match the database: attaches RUNNING ones we
   *  are not watching yet, and lets go of ones that are no longer RUNNING. Public for tests. */
  async reconcile(): Promise<void> {
    if (this.reconciling || !this.canTrade()) return;
    this.reconciling = true;
    try {
      const running = await this.deps.db.botInstance.findMany({ where: { status: "RUNNING" } });
      const runningIds = new Set(running.map((r) => r.id));
      for (const id of runningIds) if (!this.runtimes.has(id)) await this.attach(id);
      for (const id of [...this.runtimes.keys()]) if (!runningIds.has(id)) this.release(id);
    } catch (err) {
      logger.error({ err }, "bot runner reconcile failed");
    } finally {
      this.reconciling = false;
    }
  }

  private canTrade(): boolean {
    return this.deps.canTrade ? this.deps.canTrade() : true;
  }

  /** Begin (or resume) evaluating an instance. The caller has already set status = RUNNING. */
  async attach(instanceId: string, options: { evaluateImmediately?: boolean } = {}): Promise<void> {
    if (this.runtimes.has(instanceId)) return;
    if (!this.canTrade()) return; // not the leader: the leader's reconcile() will pick this bot up
    const runtime: Runtime = {
      timer: null,
      busy: false,
      lastCandleEpoch: null,
      consecutiveErrors: 0,
      unsubscribe: null,
      settleTimer: null,
      lastDigit: null,
      tickUnsub: null,
      notBefore: 0,
      nextTimer: null,
      idleCycles: 0,
    };
    this.runtimes.set(instanceId, runtime);

    // A trade left OPEN by a previous process: resume watching it before anything new trades.
    const open = await this.deps.db.botTrade.findFirst({ where: { botInstanceId: instanceId, status: "OPEN" } });
    if (open) {
      const inst = await this.loadInstance(instanceId);
      if (inst) this.watchTrade(inst, open.id, Number(open.contractId), Number(open.stake), open.stakeStep, 0);
    }

    const loaded = await this.loadInstance(instanceId);
    const def = parseDefinition(loaded?.strategy.definition);
    if (def?.kind === "program" && loaded && usesBlock(def.def.program, "last_digit") && this.deps.market.subscribeTicks) {
      runtime.tickUnsub = this.deps.market.subscribeTicks(loaded.symbol, (tick) => {
        runtime.lastDigit = lastDigitOf(tick);
      });
    }
    const granularityMs = def?.kind === "indicator" ? def.def.candleGranularitySeconds * 1000 : MAX_POLL_MS;
    const pollMs = def?.kind === "program" ? PROGRAM_POLL_MS : Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, granularityMs / 4));
    runtime.timer = setInterval(() => void this.evaluateOnce(instanceId), pollMs);
    if (options.evaluateImmediately ?? true) void this.evaluateOnce(instanceId);
  }

  detach(instanceId: string): void {
    const rt = this.runtimes.get(instanceId);
    if (!rt) return;
    if (rt.timer) clearInterval(rt.timer);
    if (rt.settleTimer) clearTimeout(rt.settleTimer);
    if (rt.nextTimer) clearTimeout(rt.nextTimer);
    rt.tickUnsub?.();
    rt.unsubscribe?.();
    this.runtimes.delete(instanceId);
  }

  /** Called when a user pauses/stops an instance. With no trade open it detaches at once. With
   *  a trade open it deliberately does NOT drop the settlement watch — the trade is real money
   *  on Deriv and will settle regardless, so we keep watching it, record the outcome, and
   *  detach on our own once the (no-longer-RUNNING) instance has nothing left to watch. */
  release(instanceId: string): void {
    const rt = this.runtimes.get(instanceId);
    if (rt && !rt.unsubscribe) this.detach(instanceId);
  }

  attachedCount(): number {
    return this.runtimes.size;
  }

  isAttached(instanceId: string): boolean {
    return this.runtimes.has(instanceId);
  }

  private async loadInstance(id: string): Promise<LoadedInstance | null> {
    const row = await this.deps.db.botInstance.findUnique({
      where: { id },
      include: { strategy: true, derivAccount: true, user: { select: { handle: true } } },
    });
    return row as LoadedInstance | null;
  }

  /** One poll cycle. Public so tests (and nothing else) can drive it deterministically. */
  async evaluateOnce(instanceId: string): Promise<void> {
    const rt = this.runtimes.get(instanceId);
    if (!rt || rt.busy || rt.unsubscribe) return; // busy, or a trade is still open: one at a time
    if (!this.canTrade()) return; // leadership lost: shutdown() is on its way, never evaluate meanwhile
    rt.busy = true;
    try {
      const inst = await this.loadInstance(instanceId);
      if (!inst || inst.status !== "RUNNING") {
        this.detach(instanceId); // paused/stopped/deleted elsewhere
        return;
      }

      const account = inst.derivAccount;
      if (account.status !== "active") return this.fail(inst, "ERROR", "ACCOUNT_UNAVAILABLE", "The Deriv account is no longer available");
      if (account.accountType === "REAL" && !inst.confirmReal) {
        return this.fail(inst, "STOPPED", "REAL_ACCOUNT_NOT_CONFIRMED", "Real-money trading was never explicitly confirmed for this bot");
      }

      const parsedDef = parseDefinition(inst.strategy.definition);
      const parsedParams = botRiskParamsSchema.safeParse(inst.riskParams);
      const staking = stakingStateSchema.safeParse(inst.stakingState);
      const risk = riskStateSchema.safeParse(inst.riskState);
      if (!parsedDef || !parsedParams.success || !staking.success || !risk.success) {
        return this.fail(inst, "ERROR", "INVALID_CONFIGURATION", "Strategy or risk settings failed validation");
      }
      // The strategy and the user's settings must be the same kind (a program needs a per-trade ceiling).
      if ((parsedDef.kind === "program") !== isProgramParams(parsedParams.data)) {
        return this.fail(inst, "ERROR", "INVALID_CONFIGURATION", "The bot's settings don't match its strategy");
      }
      if (parsedDef.kind === "program") {
        return await this.driveProgram(inst, rt, parsedDef.def, parsedParams.data as ProgramRiskParams, staking.data, risk.data);
      }
      const def = { data: parsedDef.def };
      const params = { data: parsedParams.data as IndicatorRiskParams };

      const gran = def.data.candleGranularitySeconds;
      const { candles } = await this.deps.market.getCandles(inst.symbol, gran, CANDLE_COUNT);
      const nowSec = Math.floor(this.now() / 1000);
      const closed = candles.filter((c) => c.epoch + gran <= nowSec); // drop the still-forming candle
      const latest = closed[closed.length - 1];
      if (!latest || rt.lastCandleEpoch === latest.epoch) return;
      rt.lastCandleEpoch = latest.epoch;
      await this.deps.db.botInstance.update({ where: { id: inst.id }, data: { lastEvaluatedAt: new Date(this.now()) } });

      const stop = checkRiskLimits(params.data.riskLimits, params.data.staking, staking.data, risk.data);
      if (stop) return this.stopForLimit(inst, stop);

      const signal = evaluateStrategy(def.data, closed);
      if (!signal) {
        rt.consecutiveErrors = 0;
        return;
      }

      const stake = nextStake(params.data.staking, staking.data);
      const proposal = await this.deps.trading.getProposal(inst.userId, account.derivAccountId, {
        contract_type: signal.contractType,
        underlying_symbol: inst.symbol,
        currency: account.currency,
        amount: stake,
        basis: "stake",
        duration: def.data.tradeParams.durationValue,
        duration_unit: def.data.tradeParams.durationUnit,
      });
      const ask = Number(proposal.ask_price);
      if (!Number.isFinite(ask) || ask <= 0) throw new Error("Deriv proposal had no usable price");
      if (ask > stake + STAKE_TOLERANCE) {
        throw new Error(`Quoted price ${ask} exceeds the configured stake ${stake} — trade refused`);
      }

      // Last check before real money moves: leadership may have lapsed during the awaits above.
      if (!this.canTrade()) {
        logger.warn({ instanceId: inst.id }, "bot runner lost its lease before placing a trade — trade skipped");
        return;
      }
      const bought = await this.deps.trading.buy(inst.userId, account.derivAccountId, proposal.id, ask);
      let trade: { id: string };
      try {
        trade = await this.deps.db.botTrade.create({
          data: {
            botInstanceId: inst.id,
            contractId: String(bought.contract_id),
            transactionId: String(bought.transaction_id),
            contractType: signal.contractType,
            stake: String(bought.buy_price),
            stakeStep: staking.data.currentStep,
            placedAt: new Date(bought.purchase_time * 1000),
            status: "OPEN",
          },
        });
      } catch (recordErr) {
        // Money is already committed on Deriv but we can't track it — never keep trading blind.
        logger.error({ recordErr, contractId: bought.contract_id }, "bot trade placed but could not be recorded");
        return this.fail(inst, "ERROR", "TRADE_RECORD_FAILED", `Trade ${bought.contract_id} was placed but could not be recorded — check it on Deriv`);
      }
      await this.deps.audit({
        actorId: inst.userId,
        actorEmail: inst.user.handle,
        action: "bots.trade_placed",
        targetType: "bot_instance",
        targetId: inst.id,
        metadata: { contractId: bought.contract_id, contractType: signal.contractType, stake, accountType: account.accountType, derivAccountId: account.derivAccountId },
      });
      rt.consecutiveErrors = 0;
      this.watchTrade(inst, trade.id, bought.contract_id, stake, staking.data.currentStep, def.data.tradeParams.durationUnit === "t" ? def.data.tradeParams.durationValue * 2_000 : 0);
    } catch (err) {
      await this.handleError(instanceId, err);
    } finally {
      rt.busy = false;
    }
  }

  private watchTrade(inst: LoadedInstance, tradeId: string, contractId: number, stake: number, _step: number, expectedMs: number): void {
    const rt = this.runtimes.get(inst.id);
    if (!rt) return;
    let settled = false;

    rt.settleTimer = setTimeout(() => {
      if (settled) return;
      // Never assume an outcome we haven't seen: stop instead of trading on a guess.
      void this.fail(inst, "ERROR", "SETTLEMENT_NOT_CONFIRMED", `Trade ${contractId} did not settle in time — check it on Deriv`);
    }, Math.max(expectedMs, 0) + SETTLEMENT_GRACE_MS);

    rt.unsubscribe = this.deps.trading.subscribePosition(inst.userId, inst.derivAccount.derivAccountId, contractId, (contract) => {
      if (settled || contract.is_sold !== 1) return;
      settled = true;
      const profit = Number(contract.profit);
      void this.settleTrade(inst.id, tradeId, contract, Number.isFinite(profit) ? profit : null, stake);
    });
  }

  private async settleTrade(instanceId: string, tradeId: string, contract: { payout?: unknown }, profit: number | null, _stake: number): Promise<void> {
    const rt = this.runtimes.get(instanceId);
    if (rt?.settleTimer) clearTimeout(rt.settleTimer);
    rt?.unsubscribe?.();
    if (rt) {
      rt.unsubscribe = null;
      rt.settleTimer = null;
    }

    try {
      const inst = await this.loadInstance(instanceId);
      if (!inst) return;
      if (profit === null) return this.fail(inst, "ERROR", "SETTLEMENT_NOT_CONFIRMED", "Deriv reported the trade sold without a profit figure");

      await this.deps.db.botTrade.update({
        where: { id: tradeId },
        data: { status: "CLOSED", profit: String(profit), payout: contract.payout !== undefined ? String(contract.payout) : null, settledAt: new Date(this.now()) },
      });

      const params = botRiskParamsSchema.parse(inst.riskParams);
      const currentStaking = stakingStateSchema.parse(inst.stakingState);
      const nextRisk = advanceRiskState(riskStateSchema.parse(inst.riskState), profit);
      if (isProgramParams(params)) {
        await this.settleProgram(inst, params, currentStaking, nextRisk, profit);
        return;
      }
      const nextStaking = advanceStakingState(params.staking, currentStaking, profit > 0);
      await this.deps.db.botInstance.update({ where: { id: inst.id }, data: { stakingState: { ...nextStaking }, riskState: { ...nextRisk } } });

      if (inst.status !== "RUNNING") {
        // Paused/stopped by the user while this trade was open: state is now up to date, so
        // there is nothing left to watch. Don't overwrite the user's own status.
        this.detach(instanceId);
        return;
      }
      const stop = checkRiskLimits(params.riskLimits, params.staking, nextStaking, nextRisk);
      if (stop) await this.stopForLimit(inst, stop);
    } catch (err) {
      await this.handleError(instanceId, err);
    }
  }


  // ---------------------------------------------------------------- imported Deriv Bot programs

  private programContext(rt: Runtime | undefined, params: ProgramRiskParams, risk: RiskState, last: { profit: number } | null): StageContext {
    return {
      totalProfit: risk.sessionProfitLoss,
      totalRuns: risk.tradesCount,
      last,
      lastDigit: rt?.lastDigit ?? null,
      input: (label) => params.program.inputs[label],
      random: () => randomInt(0, 1_000_000) / 1_000_000,
    };
  }

  private logProgram(instanceId: string, logs: Array<{ kind: string; level: string; text: string }>): void {
    for (const line of logs) logger.info({ instanceId, kind: line.kind, level: line.level }, `bot program ${line.kind}: ${line.text}`);
  }

  private async saveProgramState(instanceId: string, program: ProgramState, risk?: RiskState): Promise<void> {
    await this.deps.db.botInstance.update({
      where: { id: instanceId },
      data: { stakingState: { currentStep: 0, program: { ...program } }, ...(risk ? { riskState: { ...risk } } : {}) },
    });
  }

  /** One cycle of a program bot: start-up (once) → trade options → "before purchase" → buy. */
  private async driveProgram(
    inst: LoadedInstance,
    rt: Runtime,
    def: DbotDefinition,
    params: ProgramRiskParams,
    staking: StakingState & { program?: ProgramState },
    risk: RiskState,
  ): Promise<void> {
    if (this.now() < rt.notBefore) return;
    const account = inst.derivAccount;
    const stop = checkRiskLimits(params.riskLimits, NO_LADDER, { currentStep: 0 }, risk);
    if (stop) return this.stopForLimit(inst, stop);

    const program = def.program;
    let state: ProgramState = staking.program ?? { vars: {}, initialized: false };
    try {
      if (usesBlock(program, "last_digit") && rt.lastDigit === null) return; // wait for the first tick

      const ctx = this.programContext(rt, params, risk, null);
      if (!state.initialized) {
        const init = runStage(program, "init", state.vars, ctx);
        this.logProgram(inst.id, init.logs);
        state = { vars: init.vars, initialized: true };
        await this.saveProgramState(inst.id, state);
      }

      const sub = runStage(program, "submarket", state.vars, ctx);
      this.logProgram(inst.id, sub.logs);
      if (!sub.tradeOptions) throw new ProgramError("no_trade_options", "The program did not set any trade options");
      const before = runStage(program, "before", sub.vars, ctx);
      this.logProgram(inst.id, before.logs);
      state = { vars: before.vars, initialized: true };
      await this.saveProgramState(inst.id, state);
      await this.deps.db.botInstance.update({ where: { id: inst.id }, data: { lastEvaluatedAt: new Date(this.now()) } });

      if (!before.purchase) {
        rt.idleCycles += 1;
        if (rt.idleCycles >= PROGRAM_MAX_IDLE_CYCLES) {
          return this.fail(inst, "ERROR", "PROGRAM_NEVER_PURCHASES", `The program ran ${PROGRAM_MAX_IDLE_CYCLES} times without buying anything`);
        }
        rt.notBefore = this.now() + Math.max(PROGRAM_MIN_GAP_MS, sub.maxDelayMs, before.maxDelayMs);
        return;
      }
      rt.idleCycles = 0;

      const opts = sub.tradeOptions;
      const contractType = before.purchase.contractType;
      const stake = Math.round(opts.amount * 100) / 100;
      if (!Number.isFinite(stake) || stake <= 0) {
        return this.fail(inst, "ERROR", "PROGRAM_ERROR", `The program chose an invalid stake (${opts.amount})`);
      }
      // The user's per-trade ceiling is absolute: a program that exceeds it is stopped, never clamped.
      if (stake > params.program.maxStakePerTrade) {
        return this.fail(inst, "STOPPED", "STAKE_CAP_EXCEEDED", `The program tried to stake ${stake}, above your limit of ${params.program.maxStakePerTrade}`);
      }
      const digitContract = BARRIER_DIGIT_TYPES.includes(contractType);
      if (digitContract && (opts.prediction === null || !Number.isInteger(opts.prediction) || opts.prediction < 0 || opts.prediction > 9)) {
        return this.fail(inst, "ERROR", "PROGRAM_ERROR", `${contractType} needs a prediction digit from 0 to 9`);
      }

      // The program's own delays (timeouts) are honoured, capped, then everything is re-checked.
      const waitMs = Math.min(PROGRAM_MAX_WAIT_MS, opts.atMs + before.purchase.atMs);
      if (waitMs > 0) {
        await this.sleep(waitMs);
        const fresh = await this.loadInstance(inst.id);
        if (!fresh || fresh.status !== "RUNNING" || !this.canTrade()) {
          if (!fresh || fresh.status !== "RUNNING") this.detach(inst.id);
          return;
        }
      }

      const proposal = await this.deps.trading.getProposal(inst.userId, account.derivAccountId, {
        contract_type: contractType as ContractType,
        underlying_symbol: inst.symbol,
        currency: account.currency,
        amount: stake,
        basis: "stake",
        duration: opts.duration,
        duration_unit: opts.durationUnit,
        ...(digitContract ? { barrier: String(opts.prediction) } : {}),
      });
      const ask = Number(proposal.ask_price);
      if (!Number.isFinite(ask) || ask <= 0) throw new Error("Deriv proposal had no usable price");
      if (ask > stake + STAKE_TOLERANCE) throw new Error(`Quoted price ${ask} exceeds the stake ${stake} — trade refused`);

      if (!this.canTrade()) {
        logger.warn({ instanceId: inst.id }, "bot runner lost its lease before placing a trade — trade skipped");
        return;
      }
      const bought = await this.deps.trading.buy(inst.userId, account.derivAccountId, proposal.id, ask);
      let trade: { id: string };
      try {
        trade = await this.deps.db.botTrade.create({
          data: {
            botInstanceId: inst.id,
            contractId: String(bought.contract_id),
            transactionId: String(bought.transaction_id),
            contractType,
            stake: String(bought.buy_price),
            stakeStep: 0,
            placedAt: new Date(bought.purchase_time * 1000),
            status: "OPEN",
          },
        });
      } catch (recordErr) {
        logger.error({ recordErr, contractId: bought.contract_id }, "bot trade placed but could not be recorded");
        return this.fail(inst, "ERROR", "TRADE_RECORD_FAILED", `Trade ${bought.contract_id} was placed but could not be recorded — check it on Deriv`);
      }
      await this.deps.audit({
        actorId: inst.userId,
        actorEmail: inst.user.handle,
        action: "bots.trade_placed",
        targetType: "bot_instance",
        targetId: inst.id,
        metadata: {
          contractId: bought.contract_id,
          contractType,
          stake,
          barrier: digitContract ? opts.prediction : null,
          duration: opts.duration,
          durationUnit: opts.durationUnit,
          accountType: account.accountType,
          derivAccountId: account.derivAccountId,
        },
      });
      rt.consecutiveErrors = 0;
      this.watchTrade(inst, trade.id, bought.contract_id, stake, 0, durationMs(opts.durationUnit, opts.duration));
    } catch (err) {
      if (err instanceof ProgramError) {
        return this.fail(inst, "ERROR", "PROGRAM_ERROR", `The imported bot stopped itself: ${err.message}`);
      }
      throw err;
    }
  }

  /** A program trade settled: record the outcome, run "after purchase", then loop or finish. */
  private async settleProgram(inst: LoadedInstance, params: ProgramRiskParams, staking: StakingState & { program?: ProgramState }, nextRisk: RiskState, profit: number): Promise<void> {
    const rt = this.runtimes.get(inst.id);
    const parsed = parseDefinition(inst.strategy.definition);
    if (!parsed || parsed.kind !== "program") {
      await this.saveProgramState(inst.id, staking.program ?? { vars: {}, initialized: false }, nextRisk);
      return this.fail(inst, "ERROR", "INVALID_CONFIGURATION", "The bot's strategy is no longer a valid program");
    }
    const state: ProgramState = staking.program ?? { vars: {}, initialized: false };
    // The outcome is real whatever happens next, so the risk state is saved before the program runs.
    await this.saveProgramState(inst.id, state, nextRisk);

    let after;
    try {
      after = runStage(parsed.def.program, "after", state.vars, this.programContext(rt, params, nextRisk, { profit }));
    } catch (err) {
      if (err instanceof ProgramError) return this.fail(inst, "ERROR", "PROGRAM_ERROR", `The imported bot stopped itself: ${err.message}`);
      throw err;
    }
    this.logProgram(inst.id, after.logs);
    await this.saveProgramState(inst.id, { vars: after.vars, initialized: true });

    if (inst.status !== "RUNNING") {
      this.detach(inst.id); // paused/stopped while the trade was open: state is current, don't touch status
      return;
    }
    const stop = checkRiskLimits(params.riskLimits, NO_LADDER, { currentStep: 0 }, nextRisk);
    if (stop) return this.stopForLimit(inst, stop);
    if (!after.tradeAgain) {
      return this.fail(inst, "STOPPED", "PROGRAM_FINISHED", "The program finished (it did not ask to trade again)");
    }
    if (rt) {
      const delay = Math.max(PROGRAM_MIN_GAP_MS, Math.min(PROGRAM_MAX_WAIT_MS, after.maxDelayMs));
      rt.notBefore = this.now() + delay;
      rt.nextTimer = setTimeout(() => void this.evaluateOnce(inst.id), delay);
    }
  }

  private async stopForLimit(inst: LoadedInstance, reason: StopReason): Promise<void> {
    await this.deps.db.botInstance.update({ where: { id: inst.id }, data: { status: "STOPPED", stopReason: reason, stoppedAt: new Date(this.now()) } });
    this.detach(inst.id);
    await this.deps.audit({ actorId: inst.userId, actorEmail: inst.user.handle, action: "bots.stopped", targetType: "bot_instance", targetId: inst.id, metadata: { reason } });
  }

  private async fail(inst: LoadedInstance, status: "ERROR" | "STOPPED", reason: string, message: string): Promise<void> {
    await this.deps.db.botInstance.update({ where: { id: inst.id }, data: { status, stopReason: reason, lastError: message, stoppedAt: new Date(this.now()) } });
    this.detach(inst.id);
    await this.deps.audit({ actorId: inst.userId, actorEmail: inst.user.handle, action: "bots.stopped", targetType: "bot_instance", targetId: inst.id, metadata: { reason, message } });
  }

  private async handleError(instanceId: string, err: unknown): Promise<void> {
    const rt = this.runtimes.get(instanceId);
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string }).code;
    logger.warn({ instanceId, err: message }, "bot evaluation failed");

    const inst = await this.loadInstance(instanceId).catch(() => null);
    if (!inst) return;
    // Deriv auth is gone: retrying can't help and the user must reconnect.
    if (code === "ReauthRequired") return this.fail(inst, "ERROR", "REAUTH_REQUIRED", "Reconnect your Deriv account to resume this bot");

    await this.deps.db.botInstance.update({ where: { id: inst.id }, data: { lastError: message } }).catch(() => undefined);
    if (rt) {
      rt.consecutiveErrors += 1;
      if (rt.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        await this.fail(inst, "ERROR", "TOO_MANY_ERRORS", `Stopped after ${MAX_CONSECUTIVE_ERRORS} consecutive errors: ${message}`);
      }
    }
  }
}
