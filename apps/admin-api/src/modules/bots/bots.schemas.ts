import { z } from "zod";
import { anyStrategyDefinitionSchema } from "./strategy.schema.js";

// Stable slug, referenced from code/seeds (see BotStrategy.key in schema.prisma) — kebab-case
// only so it's safe to use as a lookup key without further sanitization anywhere it's read.
const strategyKeySchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "key must be lowercase kebab-case, e.g. \"ema-rsi-macd-martingale\"");

export const createStrategySchema = z.object({
  key: strategyKeySchema,
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  definition: anyStrategyDefinitionSchema,
});
export type CreateStrategyBody = z.infer<typeof createStrategySchema>;

// Every field optional — a PATCH, not a full replace. `definition` is still validated as a
// COMPLETE StrategyDefinition when present (no partial/merge semantics for it — the signal
// engine needs a self-consistent whole, not a patch applied to JSON it never sees structured).
export const updateStrategySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().min(1).max(2000).optional(),
  definition: anyStrategyDefinitionSchema.optional(),
});
export type UpdateStrategyBody = z.infer<typeof updateStrategySchema>;

export const setStrategyStatusSchema = z.object({
  status: z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]),
});

// Preview an uploaded Deriv Bot XML file. Nothing is saved: the admin reviews the result and then
// saves it through the normal create-strategy call, which validates the program all over again.
export const importDbotSchema = z.object({
  xml: z.string().min(1).max(220_000),
  // Blocks the admin has explicitly agreed to drop (see IGNORABLE_BLOCKS in dbot/program.ts).
  ignore: z.array(z.string().max(60)).max(10).default([]),
});
export type ImportDbotBody = z.infer<typeof importDbotSchema>;
