import { describe, expect, it } from "vitest";
import { isProgramParams, type BotRiskParams } from "./botTypes";

describe("isProgramParams", () => {
  it("tells an imported bot's settings from an indicator bot's", () => {
    const program: BotRiskParams = { program: { maxStakePerTrade: 5, inputs: {} }, riskLimits: { stopLossAmount: 10 } };
    const indicator: BotRiskParams = { staking: { mode: "FIXED", stake: 1 }, riskLimits: { stopLossAmount: 10 } };
    expect(isProgramParams(program)).toBe(true);
    expect(isProgramParams(indicator)).toBe(false);
  });
});
