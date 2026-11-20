// A small, deterministic interpreter for imported Deriv Bot programs (see program.ts).
//
// Safety properties:
//  * It walks plain JSON data. Nothing is evaluated as code, and the only blocks that exist are the
//    ones in program.ts's catalogue (re-validated by the caller before a program ever runs).
//  * Every stage has a step budget, every loop an iteration cap, procedure calls a depth cap and
//    timers a count and delay cap — a runaway or hostile program fails with a ProgramError instead
//    of hanging the server.
//  * It is pure: it never touches the network or the database. The bot runner supplies the facts it
//    may read (profit so far, the last tick's digit, the user's inputs) through StageContext and
//    acts on the StageResult (buy / trade again) itself, so the user's own limits stay in charge.
//
// Timers: Deriv Bot's "timeout" block runs its stack later while the rest keeps going. Here a stage
// runs its main stack first, then fires its timers in order of due time (ties: the order they were
// created). A timer's delay is VIRTUAL — it is reported back as `atMs` / `maxDelayMs` and the runner
// waits that long before acting — so the program itself never sleeps. Documented deviation: the
// next trade starts only after a stage's timers have all fired; Deriv Bot could overlap them.

import { LIMITS, type DbotNode, type DbotProgram } from "./program.js";

export type Value = number | string | boolean | null;
export type Vars = Record<string, Value>;

export type Stage = "init" | "submarket" | "before" | "after";

export class ProgramError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProgramError";
  }
}

export interface StageContext {
  totalProfit: number;
  totalRuns: number;
  /** Set only for the "after purchase" stage: the contract that just settled. */
  last: { profit: number } | null;
  /** Last digit of the most recent tick's quote, or null if none has been seen yet. */
  lastDigit: number | null;
  /** The user's value for a prompt label, if they gave one. */
  input(label: string): number | undefined;
  /** Uniform in [0, 1). */
  random(): number;
}

export interface LogLine {
  kind: "notify" | "print";
  level: string;
  text: string;
}

export interface TradeOptions {
  durationUnit: "t" | "s" | "m" | "h" | "d";
  duration: number;
  amount: number;
  /** The predicted digit (Deriv `barrier`) when the program supplied one. */
  prediction: number | null;
  atMs: number;
}

export interface StageResult {
  vars: Vars;
  logs: LogLine[];
  tradeOptions: TradeOptions | null;
  purchase: { contractType: string; atMs: number } | null;
  tradeAgain: { atMs: number } | null;
  /** Latest virtual time any timer fired at (0 if none). */
  maxDelayMs: number;
  steps: number;
}

type Frame = Map<string, Value>;
interface Timer {
  due: number;
  seq: number;
  stack: DbotNode[];
  frames: Frame[];
}

const MAX_LOGS = 50;
const MAX_LOG_TEXT = 200;
const MAX_STRING = 2000;

function toNumber(v: Value | undefined, what: string): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  throw new ProgramError("not_a_number", `${what} is not a number (it is ${v === null || v === undefined ? "empty" : JSON.stringify(v)})`);
}

function checked(n: number, what: string): number {
  if (!Number.isFinite(n)) throw new ProgramError("bad_calculation", `${what} produced an invalid number`);
  return n;
}

function toText(v: Value): string {
  if (v === null) return "";
  const s = String(v);
  return s.length > MAX_STRING ? s.slice(0, MAX_STRING) : s;
}

function looseEquals(a: Value, b: Value): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a === typeof b) return a === b;
  if (typeof a === "boolean" || typeof b === "boolean") return Number(a) === Number(b);
  return Number(a) === Number(b); // number vs numeric text, like JavaScript's ==
}

function isPrime(n: number): boolean {
  if (!Number.isInteger(n) || n < 2) return false;
  for (let i = 2; i * i <= n; i++) if (n % i === 0) return false;
  return true;
}

function numberedInputs(node: DbotNode, prefix: string): DbotNode[] {
  return Object.entries(node.v ?? {})
    .filter(([name]) => name.startsWith(prefix))
    .sort((a, b) => Number(a[0].slice(prefix.length)) - Number(b[0].slice(prefix.length)))
    .map(([, child]) => child);
}

class Machine {
  steps = 0;
  logs: LogLine[] = [];
  tradeOptions: TradeOptions | null = null;
  purchase: { contractType: string; atMs: number } | null = null;
  tradeAgain: { atMs: number } | null = null;
  maxDelayMs = 0;
  private now = 0;
  private seq = 0;
  private timers: Timer[] = [];
  private frames: Frame[] = [];
  private callDepth = 0;

  constructor(
    private readonly program: DbotProgram,
    readonly vars: Vars,
    private readonly ctx: StageContext,
    private readonly stage: Stage,
  ) {}

  run(stack: DbotNode[]): void {
    this.exec(stack);
    // Fire timers in virtual-time order. New timers created while firing are queued the same way.
    while (this.timers.length > 0) {
      this.timers.sort((a, b) => a.due - b.due || a.seq - b.seq);
      const t = this.timers.shift()!;
      this.now = t.due;
      this.maxDelayMs = Math.max(this.maxDelayMs, t.due);
      this.frames = t.frames;
      this.exec(t.stack);
    }
  }

  private tick(): void {
    if (++this.steps > LIMITS.maxStepsPerStage) throw new ProgramError("step_limit", "The program ran too many steps in one go and was stopped");
  }

  private getVar(name: string): Value {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i]!;
      if (f.has(name)) return f.get(name)!;
    }
    return Object.prototype.hasOwnProperty.call(this.vars, name) ? this.vars[name]! : null;
  }

  private setVar(name: string, value: Value): void {
    if (typeof value === "string" && value.length > MAX_STRING) value = value.slice(0, MAX_STRING);
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i]!;
      if (f.has(name)) {
        f.set(name, value);
        return;
      }
    }
    if (!Object.prototype.hasOwnProperty.call(this.vars, name) && Object.keys(this.vars).length >= 200) {
      throw new ProgramError("too_many_variables", "The program uses too many variables");
    }
    this.vars[name] = value;
  }

  private log(kind: LogLine["kind"], level: string, text: string): void {
    if (this.logs.length < MAX_LOGS) this.logs.push({ kind, level, text: text.length > MAX_LOG_TEXT ? text.slice(0, MAX_LOG_TEXT) : text });
  }

  private exec(nodes: DbotNode[]): void {
    for (const node of nodes) this.execOne(node);
  }

  private input(node: DbotNode, name: string): DbotNode {
    const child = node.v?.[name];
    if (!child) throw new ProgramError("missing_input", `Block "${node.type}" is missing its "${name}" input`);
    return child;
  }

  private execOne(node: DbotNode): void {
    this.tick();
    switch (node.type) {
      case "variables_set":
        this.setVar(node.f!.VAR!, this.eval(this.input(node, "VALUE")));
        return;
      case "math_change": {
        const name = node.f!.VAR!;
        const current = this.getVar(name);
        const delta = toNumber(this.eval(this.input(node, "DELTA")), "The amount to change by");
        this.setVar(name, checked(toNumber(current === null ? 0 : current, `Variable "${name}"`) + delta, `Changing "${name}"`));
        return;
      }
      case "controls_if": {
        for (let i = 0; node.v?.[`IF${i}`]; i++) {
          if (this.truthy(this.eval(node.v[`IF${i}`]!))) {
            this.exec(node.s?.[`DO${i}`] ?? []);
            return;
          }
        }
        this.exec(node.s?.ELSE ?? []);
        return;
      }
      case "controls_whileUntil": {
        const until = node.f?.MODE === "UNTIL";
        for (let n = 0; ; n++) {
          if (n >= LIMITS.maxLoopIterations) throw new ProgramError("loop_limit", "A loop ran too many times and was stopped");
          const cond = this.truthy(this.eval(this.input(node, "BOOL")));
          if (until ? cond : !cond) break;
          this.exec(node.s?.DO ?? []);
        }
        return;
      }
      case "controls_repeat_ext": {
        const times = Math.floor(toNumber(this.eval(this.input(node, "TIMES")), "The repeat count"));
        if (times > LIMITS.maxLoopIterations) throw new ProgramError("loop_limit", "A loop ran too many times and was stopped");
        for (let n = 0; n < times; n++) this.exec(node.s?.DO ?? []);
        return;
      }
      case "notify":
        this.log("notify", node.f?.NOTIFICATION_TYPE ?? "info", toText(this.eval(this.input(node, "MESSAGE"))));
        return;
      case "text_print":
        this.log("print", "info", toText(this.eval(this.input(node, "TEXT"))));
        return;
      case "timeout": {
        const seconds = toNumber(this.eval(this.input(node, "SECONDS")), "The delay");
        if (seconds < 0 || seconds > LIMITS.maxTimerSeconds) throw new ProgramError("bad_timeout", `A delay of ${seconds} seconds isn't allowed (0–${LIMITS.maxTimerSeconds})`);
        if (this.timers.length >= LIMITS.maxTimersPerStage) throw new ProgramError("timer_limit", "The program scheduled too many delayed actions");
        this.timers.push({ due: this.now + seconds * 1000, seq: this.seq++, stack: node.s?.TIMEOUTSTACK ?? [], frames: [...this.frames] });
        return;
      }
      case "trade_again":
        if (!this.tradeAgain) this.tradeAgain = { atMs: this.now };
        return;
      case "purchase":
        if (!this.purchase) this.purchase = { contractType: node.f!.PURCHASE_LIST!, atMs: this.now };
        return;
      case "tradeOptions": {
        const duration = toNumber(this.eval(this.input(node, "DURATION")), "The trade duration");
        const amount = toNumber(this.eval(this.input(node, "AMOUNT")), "The stake");
        if (!Number.isInteger(duration) || duration <= 0) throw new ProgramError("bad_duration", `The trade duration ${duration} must be a whole number above 0`);
        if (amount <= 0) throw new ProgramError("bad_stake", `The stake ${amount} must be above 0`);
        let prediction: number | null = null;
        if (node.v?.PREDICTION) {
          prediction = toNumber(this.eval(node.v.PREDICTION), "The predicted digit");
          if (!Number.isInteger(prediction) || prediction < 0 || prediction > 9) throw new ProgramError("bad_prediction", `The predicted digit ${prediction} must be a whole number from 0 to 9`);
        }
        this.tradeOptions = { durationUnit: (node.f?.DURATIONTYPE_LIST ?? "t") as TradeOptions["durationUnit"], duration, amount, prediction, atMs: this.now };
        return;
      }
      case "procedures_callnoreturn":
        this.call(node);
        return;
      default:
        throw new ProgramError("unsupported_block", `Block "${node.type}" can't run here`);
    }
  }

  private truthy(v: Value): boolean {
    return v !== null && v !== false && v !== 0 && v !== "";
  }

  private call(node: DbotNode): Value {
    const name = node.m?.name ?? "";
    const proc = this.program.procs[name];
    if (!proc) throw new ProgramError("unknown_procedure", `Procedure "${name}" doesn't exist`);
    if (++this.callDepth > LIMITS.maxCallDepth) throw new ProgramError("call_depth", "Procedures call each other too deeply");
    const frame: Frame = new Map();
    numberedInputs(node, "ARG").forEach((arg, i) => {
      const argName = proc.args[i];
      if (argName !== undefined) frame.set(argName, this.eval(arg));
    });
    this.frames.push(frame);
    try {
      this.exec(proc.body);
      return proc.ret ? this.eval(proc.ret) : null;
    } finally {
      this.frames.pop();
      this.callDepth--;
    }
  }

  private eval(node: DbotNode): Value {
    this.tick();
    switch (node.type) {
      case "math_number":
        return Number(node.f!.NUM);
      case "text":
        return node.f?.TEXT ?? "";
      case "logic_boolean":
        return node.f?.BOOL === "TRUE";
      case "logic_null":
        return null;
      case "variables_get":
        return this.getVar(node.f!.VAR!);
      case "math_arithmetic": {
        const a = toNumber(this.eval(this.input(node, "A")), "The first number");
        const b = toNumber(this.eval(this.input(node, "B")), "The second number");
        switch (node.f?.OP) {
          case "ADD":
            return checked(a + b, "Adding");
          case "MINUS":
            return checked(a - b, "Subtracting");
          case "MULTIPLY":
            return checked(a * b, "Multiplying");
          case "DIVIDE":
            if (b === 0) throw new ProgramError("divide_by_zero", "The program divided by zero");
            return checked(a / b, "Dividing");
          default:
            return checked(Math.pow(a, b), "The power");
        }
      }
      case "math_single": {
        const n = toNumber(this.eval(this.input(node, "NUM")), "The number");
        switch (node.f?.OP) {
          case "ABS":
            return Math.abs(n);
          case "NEG":
            return -n;
          case "ROOT":
            if (n < 0) throw new ProgramError("bad_calculation", "Square root of a negative number");
            return Math.sqrt(n);
          case "LN":
            if (n <= 0) throw new ProgramError("bad_calculation", "Logarithm of a number that isn't above 0");
            return Math.log(n);
          case "LOG10":
            if (n <= 0) throw new ProgramError("bad_calculation", "Logarithm of a number that isn't above 0");
            return Math.log10(n);
          case "EXP":
            return checked(Math.exp(n), "exp");
          default:
            return checked(Math.pow(10, n), "10 to the power");
        }
      }
      case "math_round": {
        const n = toNumber(this.eval(this.input(node, "NUM")), "The number");
        return node.f?.OP === "ROUNDUP" ? Math.ceil(n) : node.f?.OP === "ROUNDDOWN" ? Math.floor(n) : Math.round(n);
      }
      case "math_number_property": {
        const n = toNumber(this.eval(this.input(node, "NUMBER_TO_CHECK")), "The number");
        switch (node.f?.PROPERTY) {
          case "EVEN":
            return n % 2 === 0;
          case "ODD":
            return Math.abs(n % 2) === 1;
          case "PRIME":
            return isPrime(n);
          case "WHOLE":
            return n % 1 === 0;
          case "POSITIVE":
            return n > 0;
          case "NEGATIVE":
            return n < 0;
          default: {
            const d = toNumber(this.eval(this.input(node, "DIVISOR")), "The divisor");
            if (d === 0) throw new ProgramError("divide_by_zero", "The program divided by zero");
            return n % d === 0;
          }
        }
      }
      case "math_random_int": {
        let from = Math.floor(toNumber(this.eval(this.input(node, "FROM")), "The lowest number"));
        let to = Math.floor(toNumber(this.eval(this.input(node, "TO")), "The highest number"));
        if (from > to) [from, to] = [to, from];
        return from + Math.floor(this.ctx.random() * (to - from + 1));
      }
      case "logic_compare": {
        const a = this.eval(this.input(node, "A"));
        const b = this.eval(this.input(node, "B"));
        switch (node.f?.OP) {
          case "EQ":
            return looseEquals(a, b);
          case "NEQ":
            return !looseEquals(a, b);
          default: {
            const x = toNumber(a, "The first value");
            const y = toNumber(b, "The second value");
            return node.f?.OP === "LT" ? x < y : node.f?.OP === "LTE" ? x <= y : node.f?.OP === "GT" ? x > y : x >= y;
          }
        }
      }
      case "logic_operation": {
        const a = this.truthy(this.eval(this.input(node, "A")));
        if (node.f?.OP === "AND") return a ? this.truthy(this.eval(this.input(node, "B"))) : false;
        return a ? true : this.truthy(this.eval(this.input(node, "B")));
      }
      case "logic_negate":
        return !this.truthy(this.eval(this.input(node, "BOOL")));
      case "logic_ternary":
        return this.truthy(this.eval(this.input(node, "IF"))) ? this.eval(this.input(node, "THEN")) : this.eval(this.input(node, "ELSE"));
      case "text_join":
        return numberedInputs(node, "ADD")
          .map((c) => toText(this.eval(c)))
          .join("")
          .slice(0, MAX_STRING);
      case "text_prompt_ext": {
        const label = node.v?.TEXT?.f?.TEXT?.trim() ?? "";
        const value = this.ctx.input(label);
        if (value === undefined) throw new ProgramError("missing_input", `No value was set for "${label}"`);
        return value;
      }
      case "procedures_callreturn":
        return this.call(node);
      case "total_profit":
        return this.ctx.totalProfit;
      case "total_runs":
        return this.ctx.totalRuns;
      case "contract_check_result":
        if (!this.ctx.last) throw new ProgramError("no_result", 'The "contract result" block can only be used after a purchase');
        return node.f?.CHECK_RESULT === "win" ? this.ctx.last.profit > 0 : this.ctx.last.profit <= 0;
      case "read_details":
        if (!this.ctx.last) throw new ProgramError("no_result", 'The "contract details" block can only be used after a purchase');
        return this.ctx.last.profit; // item 4 = profit (the only item the importer accepts)
      case "last_digit":
        if (this.ctx.lastDigit === null) throw new ProgramError("no_tick", "No price tick has been received yet");
        return this.ctx.lastDigit;
      default:
        throw new ProgramError("unsupported_block", `Block "${node.type}" can't be used as a value here`);
    }
  }
}

const STACKS: Record<Stage, keyof Pick<DbotProgram, "init" | "submarket" | "before" | "after">> = {
  init: "init",
  submarket: "submarket",
  before: "before",
  after: "after",
};

/** Runs one stage of a program against the given variables. Never mutates `vars` — the updated
 *  variables come back in the result (and are only meant to be stored if the caller carries on). */
export function runStage(program: DbotProgram, stage: Stage, vars: Vars, ctx: StageContext): StageResult {
  const working: Vars = { ...vars };
  const machine = new Machine(program, working, ctx, stage);
  machine.run(program[STACKS[stage]]);
  return {
    vars: working,
    logs: machine.logs,
    tradeOptions: machine.tradeOptions,
    purchase: machine.purchase,
    tradeAgain: machine.tradeAgain,
    maxDelayMs: machine.maxDelayMs,
    steps: machine.steps,
  };
}

/** True if any block of the given type appears anywhere in the program (all stacks and procedures). */
export function usesBlock(program: DbotProgram, type: string): boolean {
  const visit = (n: DbotNode): boolean => {
    if (n.type === type) return true;
    for (const c of Object.values(n.v ?? {})) if (visit(c)) return true;
    for (const stack of Object.values(n.s ?? {})) if (stack.some(visit)) return true;
    return false;
  };
  const stacks = [program.init, program.submarket, program.before, program.during, program.after];
  for (const proc of Object.values(program.procs)) {
    stacks.push(proc.body);
    if (proc.ret && visit(proc.ret)) return true;
  }
  return stacks.some((stack) => stack.some(visit));
}
