// The user-owned half of a bot instance's configuration (BotInstance.riskParams). Same shapes
// as StrategyDefinition.staking / .riskLimits, but these are the INSTANCE's own values — the
// admin template's staking/riskLimits are only a suggested starting point shown to the user,
// never applied to real money unless the user chose them for their own instance.
//
// A bot with no stop-loss and no target-profit is refused outright: unattended, always-on
// trading with no kill switch is not something this app will start for anyone.

import { z } from "zod";
import { riskLimitsSchema, stakingConfigSchema } from "./strategy.schema.js";

// Hard ceilings enforced server-side regardless of what the strategy or the client asks for.
export const MAX_STAKE_PER_TRADE = 1000;

function requireKillSwitch(riskLimits: z.infer<typeof riskLimitsSchema>, ctx: z.RefinementCtx) {
  if (riskLimits.stopLossAmount === undefined && riskLimits.targetProfitAmount === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["riskLimits"], message: "Set a stop-loss or a target profit — a bot can't run without a kill switch" });
  }
}

/** Settings for a bot built on an INDICATOR strategy: the user's own staking ladder + limits. */
export const indicatorRiskParamsSchema = z
  .object({
    staking: stakingConfigSchema,
    riskLimits: riskLimitsSchema,
  })
  .superRefine((value, ctx) => {
    requireKillSwitch(value.riskLimits, ctx);
    const peak =
      value.staking.mode === "FIXED"
        ? value.staking.stake
        : value.staking.baseStake * Math.pow(value.staking.multiplierOnLoss, value.staking.maxSteps - 1);
    if (peak > MAX_STAKE_PER_TRADE) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["staking"], message: `The largest stake this setup can reach (${peak.toFixed(2)}) exceeds the ${MAX_STAKE_PER_TRADE} per-trade ceiling` });
    }
  });
export type IndicatorRiskParams = z.infer<typeof indicatorRiskParamsSchema>;

/** Settings for a bot built on an imported Deriv Bot PROGRAM. The program decides each stake, so
 *  there is no ladder to configure — instead the user sets a hard ceiling no stake may exceed
 *  (a program that asks for more is STOPPED, never silently clamped) plus the same kill switches,
 *  and answers the program's prompts ("Maximum Loss Amount" …) once, here. */
export const programRiskParamsSchema = z
  .object({
    program: z.object({
      maxStakePerTrade: z.number().positive().max(MAX_STAKE_PER_TRADE, `The per-trade ceiling can't be above ${MAX_STAKE_PER_TRADE}`),
      inputs: z.record(z.string().min(1).max(100), z.number().finite()).default({}),
    }),
    riskLimits: riskLimitsSchema,
  })
  .superRefine((value, ctx) => requireKillSwitch(value.riskLimits, ctx));
export type ProgramRiskParams = z.infer<typeof programRiskParamsSchema>;

export type BotRiskParams = IndicatorRiskParams | ProgramRiskParams;

export function isProgramParams(p: BotRiskParams): p is ProgramRiskParams {
  return "program" in p;
}

/** Either kind. A `program` key selects the program shape, so each reports its own errors. */
export const botRiskParamsSchema = z.unknown().transform((raw, ctx): BotRiskParams => {
  const isProgram = typeof raw === "object" && raw !== null && "program" in raw;
  const parsed = isProgram ? programRiskParamsSchema.safeParse(raw) : indicatorRiskParamsSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) ctx.addIssue({ code: z.ZodIssueCode.custom, path: issue.path, message: issue.message });
    return z.NEVER;
  }
  return parsed.data;
});

// What a program remembers between trades: its variables, and whether its start-up part has run.
// Stored beside the ladder position in BotInstance.stakingState (a fresh session clears all of it).
export const programStateSchema = z.object({
  vars: z.record(z.string(), z.union([z.number().finite(), z.string(), z.boolean(), z.null()])),
  initialized: z.boolean(),
});
export type ProgramState = z.infer<typeof programStateSchema>;

export const stakingStateSchema = z.object({ currentStep: z.number().int().min(0), program: programStateSchema.optional() });
export const riskStateSchema = z.object({
  sessionProfitLoss: z.number(),
  consecutiveLosses: z.number().int().min(0),
  tradesCount: z.number().int().min(0),
});
