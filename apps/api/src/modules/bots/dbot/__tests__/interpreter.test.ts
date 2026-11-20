import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ProgramError, runStage, type StageContext, type Vars } from "../interpreter.js";
import { validateProgram, type DbotNode, type DbotProgram } from "../program.js";

const load = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.program.json`, import.meta.url), "utf8")) as DbotProgram;
const over = load("digits-over-recovery");
const differs = load("digits-differs-random");
const martingale = load("digits-differs-martingale-timeouts");

function ctx(over: Partial<StageContext> = {}): StageContext {
  return { totalProfit: 0, totalRuns: 0, last: null, lastDigit: 7, input: () => undefined, random: () => 0.5, ...over };
}

// ---- tiny program builder for the safety tests ----------------------------------------------------
const num = (n: number): DbotNode => ({ type: "math_number", f: { NUM: String(n) } });
const get = (name: string): DbotNode => ({ type: "variables_get", f: { VAR: name } });
const set = (name: string, value: DbotNode): DbotNode => ({ type: "variables_set", f: { VAR: name }, v: { VALUE: value } });
function prog(partial: Partial<DbotProgram>): DbotProgram {
  return { suggestedSymbol: "R_50", init: [], submarket: [], before: [], during: [], after: [], procs: {}, ignored: [], ...partial };
}

describe("bot 1 — digits over, recover a loss then reset (digits-over-recovery)", () => {
  it("starts with the stake and prediction the XML sets", () => {
    const init = runStage(over, "init", {}, ctx());
    expect(init.vars).toMatchObject({ Stake: 2, "stake 2": 2, Loss: 1000, "Target Profit": 607 });
    const sub = runStage(over, "submarket", init.vars, ctx());
    expect(sub.tradeOptions).toMatchObject({ durationUnit: "t", duration: 1, amount: 2, prediction: 5 });
    const before = runStage(over, "before", init.vars, ctx());
    expect(before.purchase).toEqual({ contractType: "DIGITOVER", atMs: 0 });
  });

  it("after a win: stake returns to 'stake 2' and the bot trades again while under the profit target", () => {
    const vars: Vars = { Stake: 9, "stake 2": 2, Loss: 1000, "Target Profit": 607 };
    const r = runStage(over, "after", vars, ctx({ totalProfit: 1.95, totalRuns: 1, last: { profit: 1.95 } }));
    expect(r.vars.Stake).toBe(2);
    expect(r.tradeAgain).not.toBeNull();
    expect(r.logs.map((l) => l.text)).toContain("Ganhou: 1.95");
  });

  it("after a loss: stake grows by the amount lost, and the bot trades again", () => {
    const vars: Vars = { Stake: 2, "stake 2": 2, Loss: 1000, "Target Profit": 607 };
    const r = runStage(over, "after", vars, ctx({ totalProfit: -2, totalRuns: 1, last: { profit: -2 } }));
    expect(r.vars.Stake).toBe(4); // 2 + |-2| * 1
    expect(r.tradeAgain).not.toBeNull();
    expect(r.logs.map((l) => l.text)).toContain("Perdeu: 2");
  });

  it("a loss at or beyond the 'Loss' threshold resets the stake", () => {
    const vars: Vars = { Stake: 900, "stake 2": 2, Loss: 1000, "Target Profit": 607 };
    const r = runStage(over, "after", vars, ctx({ totalProfit: -1200, totalRuns: 3, last: { profit: -1200 } }));
    expect(r.vars.Stake).toBe(2);
  });

  it("reaching the profit target ends the bot: no trade-again", () => {
    const vars: Vars = { Stake: 2, "stake 2": 2, Loss: 1000, "Target Profit": 607 };
    const r = runStage(over, "after", vars, ctx({ totalProfit: 607.5, totalRuns: 500, last: { profit: 1.95 } }));
    expect(r.tradeAgain).toBeNull();
    expect(r.logs.some((l) => l.text.startsWith("Dollars Printed Successfully : 607.5"))).toBe(true);
  });

  it("does not change the variables it was given (the caller decides whether to keep the result)", () => {
    const vars: Vars = { Stake: 2, "stake 2": 2, Loss: 1000, "Target Profit": 607 };
    runStage(over, "after", vars, ctx({ totalProfit: -2, last: { profit: -2 } }));
    expect(vars.Stake).toBe(2);
  });
});

describe("bot 2 — digits differs with a random digit (digits-differs-random)", () => {
  it("picks the predicted digit from the random block and stakes the initial amount", () => {
    const init = runStage(differs, "init", {}, ctx({ random: () => 0.5 }));
    expect(init.vars).toMatchObject({ "Initial Amount": 0.35, "Win Amount": 0.35, LDP: 5, slos: false, JlhLos: 0 });
    const sub = runStage(differs, "submarket", init.vars, ctx());
    expect(sub.tradeOptions).toMatchObject({ amount: 0.35, duration: 1, prediction: 5 });
    expect(runStage(differs, "before", init.vars, ctx()).purchase?.contractType).toBe("DIGITDIFF");
  });

  it("the random digit always lands in 0–9", () => {
    for (const r of [0, 0.0999, 0.5, 0.9999999]) {
      const v = runStage(differs, "init", {}, ctx({ random: () => r })).vars.LDP as number;
      expect(Number.isInteger(v) && v >= 0 && v <= 9).toBe(true);
    }
  });

  it("a win adds the profit to the next stake; two losses in a row go back to the win amount", () => {
    const start: Vars = { "Max Loss Amount": 30, "Expected Profit": 20, "Win Amount": 0.35, "Initial Amount": 0.35, slos: false, JlhLos: 0, LDP: 3 };
    const won = runStage(differs, "after", start, ctx({ totalProfit: 0.33, totalRuns: 1, last: { profit: 0.33 } }));
    expect(won.vars["Initial Amount"]).toBeCloseTo(0.68, 10);
    expect(won.tradeAgain).not.toBeNull();

    const lost1 = runStage(differs, "after", start, ctx({ totalProfit: -0.35, totalRuns: 1, last: { profit: -0.35 } }));
    expect(lost1.vars.JlhLos).toBe(1);
    expect(lost1.vars.slos).toBe(true);
    expect(lost1.vars["Initial Amount"]).toBeCloseTo(0.35 + 0.35 * 10, 10); // += |stake| * 10

    const lost2 = runStage(differs, "after", { ...lost1.vars }, ctx({ totalProfit: -4, totalRuns: 2, last: { profit: -3.85 } }));
    expect(lost2.vars.JlhLos).toBe(0);
    expect(lost2.vars["Initial Amount"]).toBe(0.35);
  });
});

describe("bot 3 — 12× martingale on digits differs with delayed actions (digits-differs-martingale-timeouts)", () => {
  const vars0 = () => runStage(martingale, "init", {}, ctx()).vars;

  it("starts with the XML's numbers", () => {
    expect(vars0()).toMatchObject({ stake: 10, "stake win": 10, martingale: 12, "take profit": 80 });
  });

  it("chooses duration by whether the run count and last digit are even or odd", () => {
    const cases: Array<[number, number, number, number]> = [
      // totalRuns, lastDigit, expected duration, expected prediction
      [0, 2, 6, 4],
      [0, 3, 3, 0],
      [1, 4, 2, 0],
      [1, 5, 1, 0],
    ];
    for (const [runs, digit, duration, prediction] of cases) {
      const r = runStage(martingale, "submarket", vars0(), ctx({ totalRuns: runs, lastDigit: digit }));
      expect(r.tradeOptions, `${runs}/${digit}`).toMatchObject({ duration, prediction, amount: 10, durationUnit: "t" });
    }
  });

  it("waits one second (plus a hair) before buying — the delay is reported, never slept inside the program", () => {
    const r = runStage(martingale, "before", vars0(), ctx());
    expect(r.purchase?.contractType).toBe("DIGITDIFF");
    expect(r.purchase!.atMs).toBeCloseTo(1000.001, 3);
  });

  it("a loss multiplies the stake by 12, but only after the program's 1 s delay; the bot trades again", () => {
    const r = runStage(martingale, "after", vars0(), ctx({ totalProfit: -10, totalRuns: 1, last: { profit: -10 } }));
    expect(r.vars.stake).toBe(120);
    expect(r.tradeAgain).toEqual({ atMs: 0 });
    expect(r.maxDelayMs).toBe(1000);
  });

  it("a win resets the stake; reaching the take-profit ends the bot", () => {
    const vars = { ...vars0(), stake: 120 };
    const won = runStage(martingale, "after", vars, ctx({ totalProfit: 9, totalRuns: 4, last: { profit: 9 } }));
    expect(won.vars.stake).toBe(10);
    expect(won.tradeAgain).not.toBeNull();
    const done = runStage(martingale, "after", vars, ctx({ totalProfit: 80, totalRuns: 9, last: { profit: 9 } }));
    expect(done.tradeAgain).toBeNull();
    expect(done.logs.some((l) => l.text === "Take Profit Level has reached.")).toBe(true);
  });

  it("needs a price tick to read the last digit", () => {
    expect(() => runStage(martingale, "submarket", vars0(), ctx({ lastDigit: null }))).toThrow(/No price tick/);
  });
});

describe("the interpreter can't be made to hang, crash the server or leak", () => {
  const fail = (p: DbotProgram, stage: "init" | "after" = "init", c: Partial<StageContext> = {}) => {
    try {
      runStage(p, stage, {}, ctx(c));
    } catch (err) {
      expect(err).toBeInstanceOf(ProgramError);
      return (err as ProgramError).code;
    }
    throw new Error("expected a ProgramError");
  };

  it("stops a loop that never ends", () => {
    const loop: DbotNode = { type: "controls_whileUntil", f: { MODE: "UNTIL" }, v: { BOOL: { type: "logic_boolean", f: { BOOL: "FALSE" } } }, s: { DO: [] } };
    expect(fail(prog({ init: [loop] }))).toBe("loop_limit");
  });

  it("stops a loop that does a lot of work per turn (step budget)", () => {
    const busy = Array.from({ length: 30 }, () => set("x", num(1)));
    const loop: DbotNode = { type: "controls_repeat_ext", v: { TIMES: num(1000) }, s: { DO: busy } };
    expect(fail(prog({ init: [loop] }))).toBe("step_limit");
  });

  it("stops a procedure that calls itself forever", () => {
    const call: DbotNode = { type: "procedures_callnoreturn", m: { name: "loop" } };
    expect(fail(prog({ init: [call], procs: { loop: { args: [], body: [call], ret: null } } }))).toBe("call_depth");
  });

  it("refuses division by zero and non-numbers instead of producing NaN", () => {
    const div: DbotNode = { type: "math_arithmetic", f: { OP: "DIVIDE" }, v: { A: num(1), B: num(0) } };
    expect(fail(prog({ init: [set("x", div)] }))).toBe("divide_by_zero");
    const bad: DbotNode = { type: "math_arithmetic", f: { OP: "ADD" }, v: { A: { type: "text", f: { TEXT: "abc" } }, B: num(1) } };
    expect(fail(prog({ init: [set("x", bad)] }))).toBe("not_a_number");
    const huge: DbotNode = { type: "math_arithmetic", f: { OP: "POWER" }, v: { A: num(10), B: num(1000) } };
    expect(fail(prog({ init: [set("x", huge)] }))).toBe("bad_calculation");
  });

  it("fires delayed actions in order of their delay, ties in creation order, and nested delays add up", () => {
    const later: DbotNode = { type: "timeout", v: { SECONDS: num(2) }, s: { TIMEOUTSTACK: [set("x", num(1))] } };
    const sooner: DbotNode = { type: "timeout", v: { SECONDS: num(1) }, s: { TIMEOUTSTACK: [set("x", num(2)), set("a", num(1))] } };
    const r = runStage(prog({ init: [later, sooner] }), "init", {}, ctx());
    expect(r.vars.x).toBe(1); // the 2 s action ran last
    expect(r.maxDelayMs).toBe(2000);

    const nested: DbotNode = { type: "timeout", v: { SECONDS: num(1) }, s: { TIMEOUTSTACK: [{ type: "timeout", v: { SECONDS: num(0.5) }, s: { TIMEOUTSTACK: [{ type: "purchase", f: { PURCHASE_LIST: "DIGITEVEN" } }] } }] } };
    const p = runStage(prog({ before: [nested] }), "before", {}, ctx());
    expect(p.purchase).toEqual({ contractType: "DIGITEVEN", atMs: 1500 });

    const tie = (v: number): DbotNode => ({ type: "timeout", v: { SECONDS: num(1) }, s: { TIMEOUTSTACK: [set("t", num(v))] } });
    expect(runStage(prog({ init: [tie(1), tie(2)] }), "init", {}, ctx()).vars.t).toBe(2);
  });

  it("caps delayed actions and their length", () => {
    const t = (s: number): DbotNode => ({ type: "timeout", v: { SECONDS: num(s) }, s: { TIMEOUTSTACK: [] } });
    expect(fail(prog({ init: [t(3600)] }))).toBe("bad_timeout");
    expect(fail(prog({ init: Array.from({ length: 51 }, () => t(1)) }))).toBe("timer_limit");
  });

  it("rejects a bad stake, duration or digit before anything is bought", () => {
    const opts = (amount: number, duration: number, prediction?: number): DbotNode => ({
      type: "tradeOptions",
      f: { DURATIONTYPE_LIST: "t" },
      v: { AMOUNT: num(amount), DURATION: num(duration), ...(prediction === undefined ? {} : { PREDICTION: num(prediction) }) },
    });
    const run = (n: DbotNode) => {
      try {
        runStage(prog({ submarket: [n] }), "submarket", {}, ctx());
      } catch (e) {
        return (e as ProgramError).code;
      }
      return "ok";
    };
    expect(run(opts(0, 1))).toBe("bad_stake");
    expect(run(opts(1, 0))).toBe("bad_duration");
    expect(run(opts(1, 1.5))).toBe("bad_duration");
    expect(run(opts(1, 1, 10))).toBe("bad_prediction");
    expect(run(opts(1, 1, 9))).toBe("ok");
  });

  it("asks for the user's values and refuses to guess missing ones", () => {
    const prompt: DbotNode = { type: "text_prompt_ext", f: { TYPE: "NUMBER" }, v: { TEXT: { type: "text", f: { TEXT: "Max stake" } } } };
    const p = prog({ init: [set("m", prompt)] });
    expect(fail(p)).toBe("missing_input");
    const ok = runStage(p, "init", {}, ctx({ input: (l) => (l === "Max stake" ? 25 : undefined) }));
    expect(ok.vars.m).toBe(25);
  });

  it("does not let the contract-result blocks be read before there is a result", () => {
    const check: DbotNode = { type: "contract_check_result", f: { CHECK_RESULT: "win" } };
    expect(fail(prog({ init: [set("w", check)] }))).toBe("no_result");
  });

  it("procedure arguments are local to the call", () => {
    const p = prog({
      init: [set("x", num(1)), { type: "procedures_callnoreturn", m: { name: "p" }, v: { ARG0: num(99) } }],
      procs: { p: { args: ["x"], body: [set("x", num(5)), set("y", get("x"))], ret: null } },
    });
    const r = runStage(p, "init", {}, ctx());
    expect(r.vars.x).toBe(1); // the parameter shadowed the global
    expect(r.vars.y).toBe(5);
  });

  it("only ever runs blocks the rulebook lists", () => {
    expect(validateProgram(prog({ init: [{ type: "console_log" }] })).issues[0]?.code).toBe("unsupported_block");
    expect(fail(prog({ init: [{ type: "console_log" }] }))).toBe("unsupported_block");
  });

  it("variable names like __proto__ can't touch the prototype", () => {
    const r = runStage(prog({ init: [set("__proto__", num(1))] }), "init", {}, ctx());
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(r.vars)).toBe(Object.prototype);
  });
});
