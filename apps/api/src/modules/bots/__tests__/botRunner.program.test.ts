import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@derivdesk/db";
import { BotRunner, lastDigitOf } from "../botRunner.js";

// Imported Deriv Bot programs: these tests drive the REAL interpreter (bot 1 from the user's own
// export — digits over, recover a loss) through the runner, with Deriv and Postgres faked.
const program = JSON.parse(readFileSync(new URL("../dbot/__tests__/fixtures/digits-over-recovery.program.json", import.meta.url), "utf8"));
const definition = { kind: "dbot", version: 1, program };
const programParams = { program: { maxStakePerTrade: 5, inputs: {} }, riskLimits: { stopLossAmount: 50 } };
const NOW = 1_000_000;

function setup(overrides: Record<string, unknown> = {}) {
  const instance: Record<string, unknown> = {
    id: "bot_1",
    userId: "user_1",
    derivAccountId: "acc_1",
    strategyId: "strat_1",
    name: "Imported",
    symbol: "R_100",
    riskParams: programParams,
    confirmReal: false,
    status: "RUNNING",
    stopReason: null,
    stakingState: { currentStep: 0 },
    riskState: { sessionProfitLoss: 0, consecutiveLosses: 0, tradesCount: 0 },
    strategy: { id: "strat_1", definition },
    derivAccount: { id: "acc_1", derivAccountId: "VRTC1", accountType: "DEMO", currency: "USD", status: "active" },
    user: { handle: "CR1000001" },
    ...overrides,
  };
  const db = {
    botInstance: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockImplementation(async () => instance),
      update: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => Object.assign(instance, data)),
    },
    botTrade: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "trade_1" }),
      update: vi.fn().mockResolvedValue({}),
    },
  } as unknown as PrismaClient;
  let positionCallback: ((c: Record<string, unknown>) => void) | null = null;
  const market = {
    getCandles: vi.fn(),
    subscribeTicks: vi.fn().mockReturnValue(vi.fn()),
  };
  const trading = {
    getProposal: vi.fn().mockResolvedValue({ id: "prop_1", ask_price: 2 }),
    buy: vi.fn().mockResolvedValue({ contract_id: 777, transaction_id: 888, purchase_time: 600, buy_price: 2 }),
    subscribePosition: vi.fn().mockImplementation((_u: string, _a: string, _c: number, cb: (c: Record<string, unknown>) => void) => {
      positionCallback = cb;
      return vi.fn();
    }),
  };
  const audit = vi.fn().mockResolvedValue(undefined);
  const sleep = vi.fn().mockResolvedValue(undefined);
  const runner = new BotRunner({ db, market: market as never, trading: trading as never, audit, now: () => NOW, sleep });
  const settle = async (c: Record<string, unknown>) => {
    positionCallback!(c);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
  };
  return { runner, db, instance, market, trading, audit, settle };
}

const lastUpdate = (db: PrismaClient, pick: string) => {
  const calls = (db.botInstance.update as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].data as Record<string, unknown>);
  return [...calls].reverse().find((d) => pick in d);
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("BotRunner — imported program: placing a trade", () => {
  it("runs start-up once, then buys the contract the program chose, with its digit as the barrier", async () => {
    const { runner, trading, db, audit } = setup();
    await runner.attach("bot_1", { evaluateImmediately: false });
    await runner.evaluateOnce("bot_1");

    expect(trading.getProposal).toHaveBeenCalledWith(
      "user_1",
      "VRTC1",
      expect.objectContaining({ contract_type: "DIGITOVER", barrier: "5", amount: 2, basis: "stake", duration: 1, duration_unit: "t", currency: "USD", underlying_symbol: "R_100" }),
    );
    expect(trading.buy).toHaveBeenCalledWith("user_1", "VRTC1", "prop_1", 2);
    expect(db.botTrade.create).toHaveBeenCalledWith({ data: expect.objectContaining({ contractType: "DIGITOVER", status: "OPEN", contractId: "777" }) });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "bots.trade_placed", metadata: expect.objectContaining({ contractType: "DIGITOVER", barrier: 5, stake: 2 }) }));
    const saved = lastUpdate(db, "stakingState")!.stakingState as { program: { initialized: boolean; vars: Record<string, unknown> } };
    expect(saved.program.initialized).toBe(true);
    expect(saved.program.vars.Stake).toBe(2);
    runner.shutdown();
  });

  it("never trades while a trade is open", async () => {
    const { runner, trading } = setup();
    await runner.attach("bot_1", { evaluateImmediately: false });
    await runner.evaluateOnce("bot_1");
    await runner.evaluateOnce("bot_1");
    expect(trading.buy).toHaveBeenCalledTimes(1);
    runner.shutdown();
  });

  it("STOPS the bot — rather than clamping — when the program's stake is above the user's per-trade limit", async () => {
    const { runner, trading, db } = setup({ riskParams: { program: { maxStakePerTrade: 1, inputs: {} }, riskLimits: { stopLossAmount: 50 } } });
    await runner.attach("bot_1", { evaluateImmediately: false });
    await runner.evaluateOnce("bot_1");
    expect(trading.buy).not.toHaveBeenCalled();
    expect(db.botInstance.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "STOPPED", stopReason: "STAKE_CAP_EXCEEDED" }) }));
    expect(runner.isAttached("bot_1")).toBe(false);
  });

  it("refuses a quote above the program's stake", async () => {
    const { runner, trading } = setup();
    trading.getProposal.mockResolvedValue({ id: "prop_1", ask_price: 2.5 });
    await runner.attach("bot_1", { evaluateImmediately: false });
    await runner.evaluateOnce("bot_1");
    expect(trading.buy).not.toHaveBeenCalled();
    runner.shutdown();
  });

  it("stops before trading when the user's own stop-loss is already reached", async () => {
    const { runner, trading, db } = setup({ riskState: { sessionProfitLoss: -50, consecutiveLosses: 3, tradesCount: 20 } });
    await runner.attach("bot_1", { evaluateImmediately: false });
    await runner.evaluateOnce("bot_1");
    expect(trading.buy).not.toHaveBeenCalled();
    expect(db.botInstance.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ stopReason: "STOP_LOSS_REACHED" }) }));
  });

  it("errors a bot whose settings are the wrong kind for its strategy", async () => {
    const { runner, trading, db } = setup({ riskParams: { staking: { mode: "FIXED", stake: 1 }, riskLimits: { stopLossAmount: 5 } } });
    await runner.attach("bot_1", { evaluateImmediately: false });
    await runner.evaluateOnce("bot_1");
    expect(trading.buy).not.toHaveBeenCalled();
    expect(db.botInstance.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "ERROR", stopReason: "INVALID_CONFIGURATION" }) }));
  });

  it("errors a bot whose stored program no longer validates", async () => {
    const { runner, trading, db } = setup({ strategy: { id: "strat_1", definition: { kind: "dbot", version: 1, program: { ...program, before: [] } } } });
    await runner.attach("bot_1", { evaluateImmediately: false });
    await runner.evaluateOnce("bot_1");
    expect(trading.buy).not.toHaveBeenCalled();
    expect(db.botInstance.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "ERROR", stopReason: "INVALID_CONFIGURATION" }) }));
  });
});

describe("BotRunner — imported program: settlement", () => {
  it("records a loss, runs 'after purchase' (stake grows by the loss) and schedules the next trade no sooner than 1 second later", async () => {
    const { runner, db, trading, settle } = setup();
    await runner.attach("bot_1", { evaluateImmediately: false });
    await runner.evaluateOnce("bot_1");
    await settle({ is_sold: 1, profit: "-2.00", payout: "0" });

    const state = lastUpdate(db, "stakingState")!.stakingState as { program: { vars: Record<string, unknown> } };
    expect(state.program.vars.Stake).toBe(4);
    expect(lastUpdate(db, "riskState")!.riskState).toEqual({ sessionProfitLoss: -2, consecutiveLosses: 1, tradesCount: 1 });
    expect(db.botTrade.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "CLOSED", profit: "-2" }) }));

    await runner.evaluateOnce("bot_1"); // too soon (clock hasn't moved)
    expect(trading.buy).toHaveBeenCalledTimes(1);
    runner.shutdown();
  });

  it("the user's stop-loss overrides the program: it stops even though the program wants to continue", async () => {
    const { runner, db, settle } = setup({ riskParams: { program: { maxStakePerTrade: 5, inputs: {} }, riskLimits: { stopLossAmount: 3 } }, riskState: { sessionProfitLoss: -2, consecutiveLosses: 1, tradesCount: 1 } });
    await runner.attach("bot_1", { evaluateImmediately: false });
    await runner.evaluateOnce("bot_1");
    await settle({ is_sold: 1, profit: "-2.00", payout: "0" });
    expect(db.botInstance.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "STOPPED", stopReason: "STOP_LOSS_REACHED" }) }));
    expect(runner.isAttached("bot_1")).toBe(false);
  });

  it("finishes the bot when the program itself decides not to trade again (its own profit target)", async () => {
    const { runner, db, settle } = setup({ riskState: { sessionProfitLoss: 606, consecutiveLosses: 0, tradesCount: 300 } });
    await runner.attach("bot_1", { evaluateImmediately: false });
    await runner.evaluateOnce("bot_1");
    await settle({ is_sold: 1, profit: "1.95", payout: "3.95" });
    expect(db.botInstance.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "STOPPED", stopReason: "PROGRAM_FINISHED" }) }));
  });

  it("keeps the outcome (and updates the program's state) but does not change status when the user paused during the trade", async () => {
    const { runner, db, instance, settle } = setup();
    await runner.attach("bot_1", { evaluateImmediately: false });
    await runner.evaluateOnce("bot_1");
    instance.status = "PAUSED";
    await settle({ is_sold: 1, profit: "-2.00", payout: "0" });
    expect(lastUpdate(db, "riskState")!.riskState).toMatchObject({ tradesCount: 1 });
    expect(db.botInstance.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "STOPPED" }) }));
    expect(runner.isAttached("bot_1")).toBe(false);
  });

  it("resumes with the saved variables after a restart instead of starting over", async () => {
    const { runner, trading } = setup({ stakingState: { currentStep: 0, program: { initialized: true, vars: { Stake: 4, "stake 2": 2, Loss: 1000, "Target Profit": 607 } } } });
    await runner.attach("bot_1", { evaluateImmediately: false });
    await runner.evaluateOnce("bot_1");
    expect(trading.getProposal).toHaveBeenCalledWith("user_1", "VRTC1", expect.objectContaining({ amount: 4 }));
    runner.shutdown();
  });
});

describe("lastDigitOf", () => {
  it("uses the pip size so trailing zeros count", () => {
    expect(lastDigitOf({ quote: 1234.5, pip_size: 2 })).toBe(0);
    expect(lastDigitOf({ quote: 1234.56, pip_size: 2 })).toBe(6);
    expect(lastDigitOf({ quote: 1234.5 })).toBe(5);
  });
});
