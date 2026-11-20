// Turns an uploaded Deriv Bot (Blockly) XML export into a DbotProgram — or refuses it, naming
// every block it can't handle. Nothing is skipped silently: the only things dropped are
//   * blocks Blockly itself treats as inactive (disabled="true"),
//   * loose blocks that aren't connected to the bot (Blockly never runs those), and
//   * blocks listed in IGNORABLE_BLOCKS, and only when the admin explicitly asked to ignore them.
// All three are reported back as warnings so the admin sees exactly what happened.

import { IGNORABLE_BLOCKS, validateProgram, type DbotIssue, type DbotNode, type DbotProc, type DbotProgram } from "./program.js";
import { parseXml, XmlError, type XmlElement } from "./xml.js";

export interface ImportSummary {
  suggestedSymbol: string;
  contractTypes: string[];
  /** Labels the user will be asked to fill in when they create a bot. */
  prompts: string[];
  /** Variables the program sets to a fixed value when it starts (e.g. Stake = 10). */
  startingValues: Array<{ name: string; value: string | number | boolean }>;
  procedures: string[];
  blockCount: number;
}

export type CompileResult =
  | { ok: true; program: DbotProgram; summary: ImportSummary; warnings: string[] }
  | { ok: false; issues: DbotIssue[] };

const tagOf = (el: XmlElement) => el.name.replace(/^.*:/, "");
const children = (el: XmlElement, name: string) => el.children.filter((c) => tagOf(c) === name);
const isDisabled = (el: XmlElement) => el.attrs.disabled === "true";

class Ctx {
  issues: DbotIssue[] = [];
  warnings: string[] = [];
  ignored = new Set<string>();
  constructor(readonly allowIgnore: ReadonlySet<string>) {}
  issue(code: string, message: string, block?: string) {
    if (this.issues.length < 50) this.issues.push({ code, message, ...(block ? { block } : {}) });
  }
}

function convertBlock(ctx: Ctx, el: XmlElement): DbotNode | null {
  const type = el.attrs.type;
  if (!type) {
    ctx.issue("malformed", "A block has no type");
    return null;
  }
  const node: DbotNode = { type };

  for (const child of el.children) {
    switch (tagOf(child)) {
      case "field": {
        const name = child.attrs.name;
        if (!name) {
          ctx.issue("malformed", `A setting on block "${type}" has no name`, type);
          break;
        }
        (node.f ??= {})[name] = child.text;
        break;
      }
      case "mutation": {
        node.m = { ...child.attrs };
        const args = children(child, "arg").map((a) => a.attrs.name ?? "");
        if (args.length) node.args = args;
        break;
      }
      case "value": {
        const name = child.attrs.name;
        if (!name) break;
        const real = children(child, "block").find((b) => !isDisabled(b));
        const inner = real ?? children(child, "shadow")[0];
        if (!inner) break; // an empty socket: the interpreter reports a missing input if it is ever read
        const converted = convertBlock(ctx, inner);
        if (converted) (node.v ??= {})[name] = converted;
        break;
      }
      case "statement": {
        const name = child.attrs.name;
        if (!name) break;
        (node.s ??= {})[name] = chain(ctx, children(child, "block")[0]);
        break;
      }
      case "next":
      case "comment":
      case "data":
        break; // `next` is followed by chain(); comments carry no behaviour
      default:
        ctx.issue("unsupported_element", `Block "${type}" contains an unexpected <${tagOf(child)}> element`, type);
    }
  }
  return node;
}

/** A statement chain: the block, then whatever hangs off its <next>, skipping disabled blocks. */
function chain(ctx: Ctx, first: XmlElement | undefined): DbotNode[] {
  const out: DbotNode[] = [];
  let el = first;
  let guard = 0;
  while (el) {
    if (++guard > 10_000) {
      ctx.issue("too_large", "A block stack is too long");
      break;
    }
    if (!isDisabled(el)) {
      const type = el.attrs.type ?? "";
      if (Object.prototype.hasOwnProperty.call(IGNORABLE_BLOCKS, type) && ctx.allowIgnore.has(type)) {
        ctx.ignored.add(type);
      } else {
        const node = convertBlock(ctx, el);
        if (node) out.push(node);
      }
    }
    const next = children(el, "next")[0];
    el = next ? children(next, "block")[0] : undefined;
  }
  return pruneEmptyTimeouts(ctx, out);
}

/** A "timeout" whose only content was an ignored block does nothing, so it goes too. */
function pruneEmptyTimeouts(ctx: Ctx, nodes: DbotNode[]): DbotNode[] {
  if (ctx.ignored.size === 0) return nodes;
  return nodes.filter((n) => !(n.type === "timeout" && (n.s?.TIMEOUTSTACK?.length ?? 0) === 0 && n.s?.TIMEOUTSTACK !== undefined));
}

function countNodes(nodes: DbotNode[]): number {
  let total = 0;
  const visit = (n: DbotNode) => {
    total++;
    for (const c of Object.values(n.v ?? {})) visit(c);
    for (const s of Object.values(n.s ?? {})) s.forEach(visit);
  };
  nodes.forEach(visit);
  return total;
}

export function compileDbotXml(xml: string, options: { ignore?: readonly string[] } = {}): CompileResult {
  let root: XmlElement;
  try {
    root = parseXml(xml);
  } catch (err) {
    const msg = err instanceof XmlError ? err.message : "The file couldn't be read as XML";
    return { ok: false, issues: [{ code: "xml", message: `This isn't a readable Deriv Bot file: ${msg}` }] };
  }
  if (tagOf(root) !== "xml") {
    return { ok: false, issues: [{ code: "xml", message: "This isn't a Deriv Bot export (the file's top element should be <xml>)" }] };
  }

  const ctx = new Ctx(new Set(options.ignore ?? []));
  const tops = children(root, "block");
  const active = tops.filter((b) => !isDisabled(b));

  const one = (type: string, required: boolean): XmlElement | undefined => {
    const found = active.filter((b) => b.attrs.type === type);
    if (found.length > 1) ctx.issue("duplicate_block", `The file has more than one "${type}" block`, type);
    if (found.length === 0 && required) ctx.issue("missing_block", `The file has no "${type}" block, so it isn't a complete bot`, type);
    return found[0];
  };

  const trade = one("trade", true);
  const beforeEl = one("before_purchase", true);
  const afterEl = one("after_purchase", true);
  const duringEl = one("during_purchase", false);

  const stmt = (el: XmlElement | undefined, name: string): DbotNode[] => {
    const holder = el ? children(el, "statement").find((s) => s.attrs.name === name) : undefined;
    return holder ? chain(ctx, children(holder, "block")[0]) : [];
  };

  let suggestedSymbol = "R_100";
  if (trade) {
    const sym = children(trade, "field").find((f) => f.attrs.name === "SYMBOL_LIST")?.text;
    if (sym) suggestedSymbol = sym;
    const restart = children(trade, "field").find((f) => f.attrs.name === "RESTARTONERROR")?.text;
    if (restart === "TRUE") ctx.warnings.push('"Restart on error" is on in the original. Here a bot stops after 5 errors in a row instead of retrying forever.');
    const tm = children(trade, "field").find((f) => f.attrs.name === "TIME_MACHINE_ENABLED")?.text;
    if (tm === "TRUE") ctx.issue("unsupported_option", "The trade's \"time machine\" option isn't supported", "trade");
  }

  const procs: Record<string, DbotProc> = {};
  for (const b of active) {
    const type = b.attrs.type;
    if (type !== "procedures_defnoreturn" && type !== "procedures_defreturn") continue;
    const name = children(b, "field").find((f) => f.attrs.name === "NAME")?.text ?? "";
    if (!name) {
      ctx.issue("malformed", "A procedure has no name", type);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(procs, name)) {
      ctx.issue("duplicate_procedure", `Two procedures are named "${name}"`, type);
      continue;
    }
    const mutation = children(b, "mutation")[0];
    const args = mutation ? children(mutation, "arg").map((a) => a.attrs.name ?? "") : [];
    const retHolder = children(b, "value").find((v) => v.attrs.name === "RETURN");
    const retEl = retHolder ? (children(retHolder, "block")[0] ?? children(retHolder, "shadow")[0]) : undefined;
    procs[name] = { args, body: stmt(b, "STACK"), ret: retEl ? convertBlock(ctx, retEl) : null };
  }

  const known = new Set(["trade", "before_purchase", "during_purchase", "after_purchase", "procedures_defnoreturn", "procedures_defreturn"]);
  const loose = active.filter((b) => !known.has(b.attrs.type ?? "")).length;
  if (loose > 0) ctx.warnings.push(`${loose} loose block(s) not connected to the bot were left out (Deriv Bot never runs those either).`);
  const disabledCount = tops.length - active.length;
  if (disabledCount > 0) ctx.warnings.push(`${disabledCount} disabled block(s) were left out.`);

  const program: DbotProgram = {
    suggestedSymbol,
    init: stmt(trade, "INITIALIZATION"),
    submarket: stmt(trade, "SUBMARKET"),
    before: stmt(beforeEl, "BEFOREPURCHASE_STACK"),
    during: stmt(duringEl, "DURING_PURCHASE_STACK"),
    after: stmt(afterEl, "AFTERPURCHASE_STACK"),
    procs,
    ignored: [...ctx.ignored].sort(),
  };

  if (program.during.length > 0) {
    ctx.issue("during_purchase_unsupported", 'The "during purchase" part has blocks this engine can\'t run (it only waits for the contract to finish)', "during_purchase");
  }
  for (const b of ctx.ignored) ctx.warnings.push(`Ignored block "${b}": ${IGNORABLE_BLOCKS[b]}.`);

  const validation = validateProgram(program);
  const issues = [...ctx.issues, ...validation.issues];
  if (issues.length > 0) return { ok: false, issues: dedupe(issues) };

  const startingValues: ImportSummary["startingValues"] = [];
  for (const n of program.init) {
    const value = n.type === "variables_set" ? n.v?.VALUE : undefined;
    if (!value) continue;
    const name = n.f?.VAR ?? "";
    if (value.type === "math_number") startingValues.push({ name, value: Number(value.f?.NUM) });
    else if (value.type === "text") startingValues.push({ name, value: value.f?.TEXT ?? "" });
    else if (value.type === "logic_boolean") startingValues.push({ name, value: value.f?.BOOL === "TRUE" });
  }

  return {
    ok: true,
    program,
    warnings: ctx.warnings,
    summary: {
      suggestedSymbol,
      contractTypes: validation.contractTypes,
      prompts: validation.prompts,
      startingValues,
      procedures: Object.keys(procs),
      blockCount: countNodes([...program.init, ...program.submarket, ...program.before, ...program.after, ...Object.values(procs).flatMap((p) => p.body)]),
    },
  };
}

function dedupe(issues: DbotIssue[]): DbotIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const key = `${i.code}|${i.block ?? ""}|${i.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
