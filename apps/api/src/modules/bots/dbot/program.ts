// SHARED RULEBOOK for imported Deriv Bot (DBot / Blockly) programs.
//
// INTENTIONAL DUPLICATE: apps/api/src/modules/bots/dbot/program.ts and
// apps/admin-api/src/modules/bots/dbot/program.ts must be byte-for-byte identical — the two apps
// are separate deployments that never import each other (see strategy.schema.ts for the same
// reasoning). A test in each app (dbot/__tests__/sync.test.ts) fails if they drift.
//
// What this file is: the list of blocks a program may contain, and the validator that enforces it.
//   * admin-api uses it when an admin imports XML or saves a definition;
//   * api uses it again before a bot runs, because a stored definition is never trusted just
//     because it is already in the database.
//
// What a program is: the Blockly XML turned into plain JSON data (DbotNode trees). There is no
// code in it and nothing is ever eval'd — the interpreter (api only) walks these nodes itself,
// and ONLY the block types listed in BLOCKS below exist. Anything else is rejected at import
// with the block's name, never skipped silently.

import { z } from "zod";

// Type aliases rather than interfaces on purpose: a type alias is assignable to Prisma's JSON input
// type (an interface is not), and these are stored as JSON.
export type DbotNode = {
  type: string;
  /** <field> values by name (variable names, operators, numbers as text …). */
  f?: Record<string, string>;
  /** <value> inputs: a single expression node by input name. */
  v?: Record<string, DbotNode>;
  /** <statement> inputs: a chain of statement nodes by input name. */
  s?: Record<string, DbotNode[]>;
  /** <mutation> attributes (e.g. the procedure name on a call block). */
  m?: Record<string, string>;
  /** Parameter names on a procedure definition. */
  args?: string[];
};

export type DbotProc = {
  args: string[];
  body: DbotNode[];
  /** The returned expression for `procedures_defreturn`, otherwise null. */
  ret: DbotNode | null;
};

export type DbotProgram = {
  /** The symbol the XML was authored for; the user's bot may choose another. */
  suggestedSymbol: string;
  init: DbotNode[];
  submarket: DbotNode[];
  before: DbotNode[];
  during: DbotNode[];
  after: DbotNode[];
  procs: Record<string, DbotProc>;
  /** Blocks the admin explicitly agreed to ignore at import (see IGNORABLE_BLOCKS). */
  ignored: string[];
};

export interface DbotIssue {
  code: string;
  message: string;
  block?: string;
}

// ---- limits (also enforced again by the interpreter at run time) -------------------------------

export const LIMITS = {
  maxNodes: 5000,
  maxDepth: 60,
  maxTextLength: 500,
  maxNameLength: 100,
  maxPrompts: 20,
  maxProcs: 50,
  maxProcArgs: 10,
  maxStepsPerStage: 20_000,
  maxLoopIterations: 1000,
  maxCallDepth: 20,
  maxTimersPerStage: 50,
  maxTimerSeconds: 60,
} as const;

// ---- the block catalogue ----------------------------------------------------------------------

interface BlockSpec {
  kind: "statement" | "value";
  fields?: readonly string[];
  values?: readonly string[];
  statements?: readonly string[];
  /** For blocks whose input names are numbered (IF0, IF1 …, ADD0 …, ARG0 …). */
  valuePattern?: RegExp;
  statementPattern?: RegExp;
  /** Enumerated field values, checked at import. */
  enums?: Readonly<Record<string, readonly string[]>>;
}

export const PURCHASE_TYPES = ["DIGITMATCH", "DIGITDIFF", "DIGITOVER", "DIGITUNDER", "DIGITEVEN", "DIGITODD", "CALL", "PUT"] as const;
/** Purchase types that carry a predicted digit in Deriv's `barrier` field. */
export const BARRIER_DIGIT_TYPES: readonly string[] = ["DIGITMATCH", "DIGITDIFF", "DIGITOVER", "DIGITUNDER"];

const DURATION_UNITS = ["t", "s", "m", "h", "d"] as const;

const BLOCKS: Readonly<Record<string, BlockSpec>> = {
  // -- statements
  variables_set: { kind: "statement", fields: ["VAR", "TEXT"], values: ["VALUE"] }, // TEXT: a stray label some exports carry
  math_change: { kind: "statement", fields: ["VAR"], values: ["DELTA"] },
  controls_if: { kind: "statement", valuePattern: /^IF\d+$/, statementPattern: /^(DO\d+|ELSE)$/ },
  controls_whileUntil: { kind: "statement", fields: ["MODE"], values: ["BOOL"], statements: ["DO"], enums: { MODE: ["WHILE", "UNTIL"] } },
  controls_repeat_ext: { kind: "statement", values: ["TIMES"], statements: ["DO"] },
  notify: { kind: "statement", fields: ["NOTIFICATION_TYPE", "NOTIFICATION_SOUND"], values: ["MESSAGE"] },
  text_print: { kind: "statement", values: ["TEXT"] },
  timeout: { kind: "statement", values: ["SECONDS"], statements: ["TIMEOUTSTACK"] },
  trade_again: { kind: "statement" },
  purchase: { kind: "statement", fields: ["PURCHASE_LIST"], enums: { PURCHASE_LIST: PURCHASE_TYPES } },
  tradeOptions: {
    kind: "statement",
    fields: ["DURATIONTYPE_LIST", "CURRENCY_LIST", "BARRIEROFFSETTYPE_LIST", "SECONDBARRIEROFFSETTYPE_LIST"],
    values: ["DURATION", "AMOUNT", "PREDICTION"],
    enums: { DURATIONTYPE_LIST: DURATION_UNITS },
  },
  procedures_callnoreturn: { kind: "statement", valuePattern: /^ARG\d+$/ },
  // -- values
  math_number: { kind: "value", fields: ["NUM"] },
  text: { kind: "value", fields: ["TEXT"] },
  logic_boolean: { kind: "value", fields: ["BOOL"], enums: { BOOL: ["TRUE", "FALSE"] } },
  logic_null: { kind: "value" },
  variables_get: { kind: "value", fields: ["VAR"] },
  math_arithmetic: { kind: "value", fields: ["OP"], values: ["A", "B"], enums: { OP: ["ADD", "MINUS", "MULTIPLY", "DIVIDE", "POWER"] } },
  math_single: { kind: "value", fields: ["OP"], values: ["NUM"], enums: { OP: ["ROOT", "ABS", "NEG", "LN", "LOG10", "EXP", "POW10"] } },
  math_round: { kind: "value", fields: ["OP"], values: ["NUM"], enums: { OP: ["ROUND", "ROUNDUP", "ROUNDDOWN"] } },
  math_number_property: {
    kind: "value",
    fields: ["PROPERTY"],
    values: ["NUMBER_TO_CHECK", "DIVISOR"],
    enums: { PROPERTY: ["EVEN", "ODD", "PRIME", "WHOLE", "POSITIVE", "NEGATIVE", "DIVISIBLE_BY"] },
  },
  math_random_int: { kind: "value", values: ["FROM", "TO"] },
  logic_compare: { kind: "value", fields: ["OP"], values: ["A", "B"], enums: { OP: ["EQ", "NEQ", "LT", "LTE", "GT", "GTE"] } },
  logic_operation: { kind: "value", fields: ["OP"], values: ["A", "B"], enums: { OP: ["AND", "OR"] } },
  logic_negate: { kind: "value", values: ["BOOL"] },
  logic_ternary: { kind: "value", values: ["IF", "THEN", "ELSE"] },
  text_join: { kind: "value", valuePattern: /^ADD\d+$/ },
  text_prompt_ext: { kind: "value", fields: ["TYPE"], values: ["TEXT"], enums: { TYPE: ["NUMBER"] } },
  procedures_callreturn: { kind: "value", valuePattern: /^ARG\d+$/ },
  total_profit: { kind: "value" },
  total_runs: { kind: "value" },
  contract_check_result: { kind: "value", fields: ["CHECK_RESULT"], enums: { CHECK_RESULT: ["win", "loss"] } },
  read_details: { kind: "value", fields: ["DETAIL_INDEX"], enums: { DETAIL_INDEX: ["4"] } }, // 4 = profit (see README: assumption)
  last_digit: { kind: "value" },
};

/** Blocks that can be dropped at import ONLY if the admin explicitly agrees to it. Dropping one
 *  changes what the bot does compared with the original, so it is never done silently. */
export const IGNORABLE_BLOCKS: Readonly<Record<string, string>> = {
  sell_at_market: "sells the contract early; this engine always lets a contract run to expiry",
};

export function isKnownBlock(type: string): boolean {
  return Object.prototype.hasOwnProperty.call(BLOCKS, type);
}

type Stage = "init" | "submarket" | "before" | "during" | "after" | "proc";

interface Walk {
  issues: DbotIssue[];
  nodes: number;
  procs: Record<string, DbotProc>;
  calls: Array<{ name: string; argc: number; from: Stage }>;
  prompts: Set<string>;
  purchases: Set<string>;
  tradeOptions: number;
}

function issue(w: Walk, code: string, message: string, block?: string) {
  if (w.issues.length < 50) w.issues.push({ code, message, ...(block ? { block } : {}) });
}

function nameOk(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && name.length <= LIMITS.maxNameLength;
}

function walkNode(w: Walk, node: DbotNode, stage: Stage, depth: number, kind: "statement" | "value") {
  if (!node || typeof node !== "object" || typeof node.type !== "string") return issue(w, "malformed", "A block is malformed");
  if (++w.nodes > LIMITS.maxNodes) return issue(w, "too_large", `The program has more than ${LIMITS.maxNodes} blocks`);
  if (depth > LIMITS.maxDepth) return issue(w, "too_deep", `Blocks are nested more than ${LIMITS.maxDepth} levels deep`);

  const spec = Object.prototype.hasOwnProperty.call(BLOCKS, node.type) ? BLOCKS[node.type] : undefined;
  if (!spec) {
    const why = IGNORABLE_BLOCKS[node.type];
    return issue(
      w,
      why ? "ignorable_block" : "unsupported_block",
      why ? `Block "${node.type}" ${why}. Import again and agree to ignore it, or remove it in Deriv Bot first.` : `Block "${node.type}" isn't supported`,
      node.type,
    );
  }
  if (spec.kind !== kind) return issue(w, "wrong_position", `Block "${node.type}" is used as a ${kind} but it is a ${spec.kind} block`, node.type);

  // Fields
  for (const [name, value] of Object.entries(node.f ?? {})) {
    if (!spec.fields?.includes(name)) return issue(w, "unsupported_field", `Block "${node.type}" has an unsupported setting "${name}"`, node.type);
    if (typeof value !== "string" || value.length > LIMITS.maxTextLength) return issue(w, "bad_field", `Block "${node.type}": "${name}" is too long or not text`, node.type);
    const allowed = spec.enums?.[name];
    if (allowed && !allowed.includes(value)) {
      const hint = node.type === "read_details" ? " Only item 4 (profit) is supported." : "";
      return issue(w, "unsupported_option", `Block "${node.type}": option "${value}" for ${name} isn't supported.${hint}`, node.type);
    }
  }
  // Variable names
  if ((node.type === "variables_set" || node.type === "variables_get" || node.type === "math_change") && !nameOk(node.f?.VAR)) {
    return issue(w, "bad_variable", `Block "${node.type}" needs a variable name (1–${LIMITS.maxNameLength} characters)`, node.type);
  }
  // Numbers
  if (node.type === "math_number" && !Number.isFinite(Number(node.f?.NUM))) return issue(w, "bad_number", `A number block holds "${node.f?.NUM}", which isn't a number`, node.type);

  // Inputs
  for (const [name, child] of Object.entries(node.v ?? {})) {
    const ok = spec.values?.includes(name) || spec.valuePattern?.test(name);
    if (!ok) return issue(w, "unsupported_input", `Block "${node.type}" has an unsupported input "${name}"`, node.type);
    walkNode(w, child, stage, depth + 1, "value");
  }
  for (const [name, chain] of Object.entries(node.s ?? {})) {
    const ok = spec.statements?.includes(name) || spec.statementPattern?.test(name);
    if (!ok) return issue(w, "unsupported_input", `Block "${node.type}" has an unsupported input "${name}"`, node.type);
    if (!Array.isArray(chain)) return issue(w, "malformed", "A block is malformed");
    for (const child of chain) walkNode(w, child, stage, depth + 1, "statement");
  }

  // Block-specific rules
  switch (node.type) {
    case "purchase":
      if (stage === "init" || stage === "submarket" || stage === "after" || stage === "during") issue(w, "wrong_stage", 'The "purchase" block only works in the "before purchase" part', node.type);
      if (node.f?.PURCHASE_LIST) w.purchases.add(node.f.PURCHASE_LIST);
      break;
    case "trade_again":
      if (stage !== "after" && stage !== "proc") issue(w, "wrong_stage", 'The "trade again" block only works in the "after purchase" part', node.type);
      break;
    case "tradeOptions":
      if (stage !== "submarket") issue(w, "wrong_stage", 'The "trade options" block only works in the trade definition', node.type);
      w.tradeOptions += 1;
      if (node.v && !node.v.AMOUNT) issue(w, "missing_input", 'The "trade options" block has no stake (AMOUNT)', node.type);
      break;
    case "procedures_callnoreturn":
    case "procedures_callreturn": {
      const name = node.m?.name;
      if (!nameOk(name)) return issue(w, "bad_call", "A procedure call has no name", node.type);
      w.calls.push({ name, argc: Object.keys(node.v ?? {}).length, from: stage });
      break;
    }
    case "text_prompt_ext": {
      const label = node.v?.TEXT;
      if (!label || label.type !== "text" || typeof label.f?.TEXT !== "string" || label.f.TEXT.trim() === "") {
        issue(w, "dynamic_prompt", "A prompt block must have a fixed text label (the label becomes the setting the user fills in)", node.type);
      } else {
        w.prompts.add(label.f.TEXT.trim());
      }
      break;
    }
  }
}

export interface ValidationResult {
  issues: DbotIssue[];
  /** Labels of every prompt block reachable from the program's entry points, in order. */
  prompts: string[];
  contractTypes: string[];
}

export function validateProgram(input: unknown): ValidationResult {
  const w: Walk = { issues: [], nodes: 0, procs: {}, calls: [], prompts: new Set(), purchases: new Set(), tradeOptions: 0 };
  const p = input as Partial<DbotProgram> | null;
  const stacks = ["init", "submarket", "before", "during", "after"] as const;
  if (!p || typeof p !== "object" || typeof p.suggestedSymbol !== "string" || !p.procs || typeof p.procs !== "object" || !Array.isArray(p.ignored)) {
    issue(w, "malformed", "The program is malformed");
    return { issues: w.issues, prompts: [], contractTypes: [] };
  }
  if (!/^[A-Za-z0-9_]{2,30}$/.test(p.suggestedSymbol)) issue(w, "bad_symbol", `Symbol "${p.suggestedSymbol}" isn't valid`);
  for (const key of stacks) if (!Array.isArray(p[key])) issue(w, "malformed", `The "${key}" part is missing`);
  if (w.issues.length) return { issues: w.issues, prompts: [], contractTypes: [] };

  const entry = { init: p.init!, submarket: p.submarket!, before: p.before!, during: p.during!, after: p.after! };
  for (const key of stacks) for (const node of entry[key]) walkNode(w, node, key, 0, "statement");

  const procNames = Object.keys(p.procs);
  if (procNames.length > LIMITS.maxProcs) issue(w, "too_large", `More than ${LIMITS.maxProcs} procedures`);
  for (const name of procNames) {
    const proc = p.procs[name]!;
    if (!nameOk(name) || !proc || !Array.isArray(proc.body) || !Array.isArray(proc.args) || proc.args.length > LIMITS.maxProcArgs || !proc.args.every(nameOk)) {
      issue(w, "malformed", `Procedure "${name}" is malformed`);
      continue;
    }
    w.procs[name] = proc;
    for (const node of proc.body) walkNode(w, node, "proc", 0, "statement");
    if (proc.ret) walkNode(w, proc.ret, "proc", 0, "value");
  }
  for (const call of w.calls) {
    const target = w.procs[call.name];
    if (!target) issue(w, "unknown_procedure", `A block calls the procedure "${call.name}", which doesn't exist`);
    else if (target.args.length !== call.argc) issue(w, "bad_call", `Procedure "${call.name}" takes ${target.args.length} input(s) but is called with ${call.argc}`);
  }
  if (new Set(p.ignored).size !== p.ignored.length || p.ignored.some((b) => !Object.prototype.hasOwnProperty.call(IGNORABLE_BLOCKS, b))) {
    issue(w, "bad_ignored", "The list of ignored blocks is not valid");
  }

  // The program must be able to trade at all.
  if (w.purchases.size === 0) issue(w, "no_purchase", 'The program never uses a "purchase" block, so it could never trade');
  if (w.tradeOptions === 0) issue(w, "no_trade_options", 'The trade definition has no "trade options" block (stake, duration)');

  // Prompts: only those reachable from the entry points (dead procedures are ignored).
  const reachable = reachablePrompts(entry, w.procs);
  if (reachable.length > LIMITS.maxPrompts) issue(w, "too_many_prompts", `More than ${LIMITS.maxPrompts} prompts`);

  return { issues: w.issues, prompts: reachable, contractTypes: [...w.purchases] };
}

function reachablePrompts(entry: Record<string, DbotNode[]>, procs: Record<string, DbotProc>): string[] {
  const out: string[] = [];
  const seenProcs = new Set<string>();
  const visit = (node: DbotNode | undefined | null) => {
    if (!node) return;
    if (node.type === "text_prompt_ext") {
      const label = node.v?.TEXT?.f?.TEXT?.trim();
      if (label && !out.includes(label)) out.push(label);
    }
    if ((node.type === "procedures_callnoreturn" || node.type === "procedures_callreturn") && node.m?.name && !seenProcs.has(node.m.name)) {
      seenProcs.add(node.m.name);
      const proc = procs[node.m.name];
      if (proc) {
        proc.body.forEach(visit);
        visit(proc.ret);
      }
    }
    for (const child of Object.values(node.v ?? {})) visit(child);
    for (const chain of Object.values(node.s ?? {})) chain.forEach(visit);
  };
  for (const stack of Object.values(entry)) stack.forEach(visit);
  return out;
}

// ---- the stored definition -----------------------------------------------------------------------

export const dbotDefinitionSchema = z
  .object({
    kind: z.literal("dbot"),
    version: z.literal(1),
    program: z.unknown(),
  })
  .superRefine((def, ctx) => {
    const { issues } = validateProgram(def.program);
    for (const i of issues) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["program"], message: i.message });
  })
  .transform((def) => ({ kind: "dbot" as const, version: 1 as const, program: def.program as DbotProgram }));
export type DbotDefinition = z.infer<typeof dbotDefinitionSchema>;
