import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileDbotXml } from "../compile.js";
import { parseXml, XmlError } from "../xml.js";
import { dbotDefinitionSchema, validateProgram, type DbotProgram } from "../program.js";

const fx = (name: string, ext: "xml" | "program.json") => readFileSync(new URL(`./fixtures/${name}.${ext}`, import.meta.url), "utf8");
const FIXTURES = ["digits-over-recovery", "digits-differs-random", "digits-differs-martingale-timeouts"] as const;

const wrap = (inner: string) => `<xml xmlns="http://www.w3.org/1999/xhtml">${inner}</xml>`;
// A minimal complete bot; `before` and `submarket` can be swapped to test single blocks.
function bot(opts: { before?: string; after?: string; submarket?: string; init?: string } = {}) {
  return wrap(`
  <block type="trade" id="t">
    <field name="SYMBOL_LIST">R_50</field>
    <statement name="INITIALIZATION">${opts.init ?? ""}</statement>
    <statement name="SUBMARKET">${
      opts.submarket ??
      `<block type="tradeOptions"><field name="DURATIONTYPE_LIST">t</field>
        <value name="DURATION"><block type="math_number"><field name="NUM">1</field></block></value>
        <value name="AMOUNT"><block type="math_number"><field name="NUM">1</field></block></value></block>`
    }</statement>
  </block>
  <block type="before_purchase"><statement name="BEFOREPURCHASE_STACK">${opts.before ?? `<block type="purchase"><field name="PURCHASE_LIST">DIGITEVEN</field></block>`}</statement></block>
  <block type="after_purchase"><statement name="AFTERPURCHASE_STACK">${opts.after ?? `<block type="trade_again"></block>`}</statement></block>`);
}

describe("importing the real Deriv Bot exports", () => {
  it("imports the two plain bots as they are", () => {
    for (const name of ["digits-over-recovery", "digits-differs-random"]) {
      const r = compileDbotXml(fx(name, "xml"));
      expect(r.ok, name).toBe(true);
    }
  });

  it("summarises what the admin needs to review", () => {
    const r = compileDbotXml(fx("digits-over-recovery", "xml"));
    if (!r.ok) throw new Error("expected ok");
    expect(r.summary.suggestedSymbol).toBe("R_100");
    expect(r.summary.contractTypes).toEqual(["DIGITOVER"]);
    expect(r.summary.startingValues).toEqual([
      { name: "Loss", value: 1000 },
      { name: "Target Profit", value: 607 },
      { name: "Stake", value: 2 },
      { name: "stake 2", value: 2 },
    ]);
    expect(r.warnings.join(" ")).toMatch(/Restart on error/);
    expect(r.warnings.join(" ")).toMatch(/disabled block/);
  });

  it("refuses the third bot unless the early-sell block is explicitly ignored, and says why", () => {
    const refused = compileDbotXml(fx("digits-differs-martingale-timeouts", "xml"));
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    const msg = refused.issues.map((i) => i.message).join(" | ");
    expect(msg).toMatch(/sell_at_market/);
    expect(msg).toMatch(/agree to ignore/);

    const accepted = compileDbotXml(fx("digits-differs-martingale-timeouts", "xml"), { ignore: ["sell_at_market"] });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.program.ignored).toEqual(["sell_at_market"]);
    expect(accepted.warnings.join(" ")).toMatch(/Ignored block "sell_at_market"/);
    expect(accepted.summary.prompts).toEqual([]); // the prompts live in procedures nothing calls
  });

  it("produces exactly the programs the API's interpreter tests run against", () => {
    for (const name of FIXTURES) {
      const r = compileDbotXml(fx(name, "xml"), { ignore: ["sell_at_market"] });
      if (!r.ok) throw new Error(name);
      expect(JSON.parse(JSON.stringify(r.program)), name).toEqual(JSON.parse(fx(name, "program.json")));
    }
  });

  it("every stored program passes the shared validator and the definition schema", () => {
    for (const name of FIXTURES) {
      const program = JSON.parse(fx(name, "program.json")) as DbotProgram;
      expect(validateProgram(program).issues, name).toEqual([]);
      expect(dbotDefinitionSchema.safeParse({ kind: "dbot", version: 1, program }).success, name).toBe(true);
    }
  });
});

describe("refusing what can't be run faithfully", () => {
  it("names an unsupported block instead of skipping it", () => {
    const r = compileDbotXml(bot({ before: `<block type="bb_indicator"><next><block type="purchase"><field name="PURCHASE_LIST">DIGITEVEN</field></block></next></block>` }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]).toMatchObject({ code: "unsupported_block", block: "bb_indicator" });
  });

  it("reports every problem, not just the first", () => {
    const r = compileDbotXml(bot({ before: `<block type="aaa"><next><block type="bbb"></block></next></block>` }));
    if (r.ok) throw new Error("expected failure");
    const names = r.issues.map((i) => i.block);
    expect(names).toContain("aaa");
    expect(names).toContain("bbb");
  });

  it("only supports contract-detail item 4 (profit)", () => {
    const r = compileDbotXml(bot({ after: `<block type="notify"><field name="NOTIFICATION_TYPE">info</field><value name="MESSAGE"><block type="read_details"><field name="DETAIL_INDEX">7</field></block></value></block>` }));
    if (r.ok) throw new Error("expected failure");
    expect(r.issues[0]!.message).toMatch(/Only item 4 \(profit\)/);
  });

  it("refuses purchase types it can't price (and unknown ones)", () => {
    const r = compileDbotXml(bot({ before: `<block type="purchase"><field name="PURCHASE_LIST">TOUCH</field></block>` }));
    expect(r.ok).toBe(false);
  });

  it("requires a fixed prompt label, because the label becomes a setting the user fills in", () => {
    const r = compileDbotXml(
      bot({ init: `<block type="variables_set"><field name="VAR">x</field><value name="VALUE"><block type="text_prompt_ext"><field name="TYPE">NUMBER</field><value name="TEXT"><block type="variables_get"><field name="VAR">y</field></block></value></block></value></block>` }),
    );
    if (r.ok) throw new Error("expected failure");
    expect(r.issues.some((i) => i.code === "dynamic_prompt")).toBe(true);
  });

  it("lists reachable prompts as settings, but not prompts in procedures nothing calls", () => {
    const prompt = (label: string) => `<block type="text_prompt_ext"><field name="TYPE">NUMBER</field><value name="TEXT"><block type="text"><field name="TEXT">${label}</field></block></value></block>`;
    const xml = bot({ init: `<block type="variables_set"><field name="VAR">x</field><value name="VALUE">${prompt("Stake please")}</value></block>` }).replace(
      "</xml>",
      `<block type="procedures_defnoreturn"><field name="NAME">dead</field><statement name="STACK"><block type="variables_set"><field name="VAR">y</field><value name="VALUE">${prompt("Never asked")}</value></block></statement></block></xml>`,
    );
    const r = compileDbotXml(xml);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    expect(r.summary.prompts).toEqual(["Stake please"]);
  });

  it("rejects calls to procedures that don't exist or with the wrong number of inputs", () => {
    const r = compileDbotXml(bot({ init: `<block type="procedures_callnoreturn"><mutation name="ghost"></mutation></block>` }));
    if (r.ok) throw new Error("expected failure");
    expect(r.issues.some((i) => i.code === "unknown_procedure")).toBe(true);
  });

  it("needs a purchase and trade options, or the bot could never trade", () => {
    const r = compileDbotXml(bot({ before: "", submarket: "" }));
    if (r.ok) throw new Error("expected failure");
    const codes = r.issues.map((i) => i.code);
    expect(codes).toContain("no_purchase");
    expect(codes).toContain("no_trade_options");
  });

  it("refuses files that aren't a complete bot", () => {
    const r = compileDbotXml(wrap(`<block type="trade"></block>`));
    if (r.ok) throw new Error("expected failure");
    expect(r.issues.map((i) => i.block)).toEqual(expect.arrayContaining(["before_purchase", "after_purchase"]));
  });

  it("leaves out loose and disabled blocks, and says so", () => {
    const xml = bot().replace("</xml>", `<block type="math_number" x="1" y="2"><field name="NUM">5</field></block><block type="purchase" disabled="true"><field name="PURCHASE_LIST">CALL</field></block></xml>`);
    const r = compileDbotXml(xml);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    expect(r.warnings.join(" ")).toMatch(/1 loose block/);
    expect(r.warnings.join(" ")).toMatch(/1 disabled block/);
  });
});

describe("hostile or broken files", () => {
  it.each([
    ["not xml at all", "hello"],
    ["the wrong root", "<html></html>"],
    ["an unclosed tag", "<xml><block type='trade'></xml>"],
    ["mismatched tags", "<xml><block></xml></block>"],
    ["an entity declaration", `<?xml version="1.0"?><!DOCTYPE xml [<!ENTITY a "boom">]><xml>&a;</xml>`],
    ["a billion-laughs doctype", `<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]><xml>&lol2;</xml>`],
    ["an unknown entity", "<xml><block type='a'>&nbsp;</block></xml>"],
    ["CDATA", "<xml><![CDATA[x]]></xml>"],
    ["a processing instruction", "<xml><?php echo 1 ?></xml>"],
    ["trailing content", "<xml></xml><xml></xml>"],
    ["an unquoted attribute", "<xml a=b></xml>"],
    ["an empty file", "   "],
  ])("rejects %s without throwing", (_name, input) => {
    const r = compileDbotXml(input);
    expect(r.ok).toBe(false);
  });

  it("rejects oversized and over-nested files before doing any work", () => {
    expect(() => parseXml("<xml>" + "a".repeat(250 * 1024) + "</xml>")).toThrow(XmlError);
    expect(() => parseXml("<xml>" + "<a>".repeat(300) + "</a>".repeat(300) + "</xml>")).toThrow(/nested too deeply/);
  });

  it("decodes the allowed character references and nothing else", () => {
    const el = parseXml(`<xml a="&lt;&amp;&#65;&#x42;">x &gt; y &quot;&apos;</xml>`);
    expect(el.attrs.a).toBe("<&AB");
    expect(el.text).toBe(`x > y "'`);
  });
});
