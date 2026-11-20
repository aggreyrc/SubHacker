import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

// apps/admin-api and apps/api each keep their own copy of the DBot rulebook and the compiled
// fixtures (they are separate deployments that never import each other). This test fails the
// moment the copies drift.
const mine = new URL("../", import.meta.url);
const theirs = new URL("../../../../../../api/src/modules/bots/dbot/", import.meta.url);

describe("the DBot rulebook is identical in apps/api and apps/admin-api", () => {
  it("program.ts is byte-for-byte the same", () => {
    expect(readFileSync(new URL("program.ts", mine), "utf8")).toBe(readFileSync(new URL("program.ts", theirs), "utf8"));
  });

  it("the compiled program fixtures are the same", () => {
    const names = readdirSync(new URL("__tests__/fixtures/", mine)).filter((n) => n.endsWith(".program.json"));
    expect(names.length).toBeGreaterThanOrEqual(3);
    for (const n of names) {
      expect(readFileSync(new URL(`__tests__/fixtures/${n}`, mine), "utf8")).toBe(readFileSync(new URL(`__tests__/fixtures/${n}`, theirs), "utf8"));
    }
  });
});
