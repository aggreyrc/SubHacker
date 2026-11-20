import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import request from "supertest";

// Only the session lookup is faked; the real app, middleware, validation and importer run.
vi.mock("../../lib/prisma.js", () => ({
  prisma: {
    adminSession: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === "11111111-1111-1111-1111-111111111111"
          ? { id: where.id, adminUserId: "a1", expiresAt: new Date(Date.now() + 60_000), adminUser: { id: "a1", email: "ops@example.com", status: "ACTIVE" } }
          : null,
    },
    auditLog: { create: async () => ({}) },
  },
}));

import { createApp } from "../../app.js";

const COOKIE = "derivdesk_admin_session=11111111-1111-1111-1111-111111111111";
const fixture = (n: string) => readFileSync(new URL(`./dbot/__tests__/fixtures/${n}.xml`, import.meta.url), "utf8");
const app = createApp();
const post = (body: unknown, cookie: string | null = COOKIE) => {
  const r = request(app).post("/api/admin/bot-strategies/import-dbot");
  return (cookie ? r.set("Cookie", cookie) : r).send(body as object);
};

describe("POST /api/admin/bot-strategies/import-dbot", () => {
  it("is for signed-in admins only", async () => {
    expect((await post({ xml: "<xml/>" }, null)).status).toBe(401);
    expect((await post({ xml: "<xml/>" }, "derivdesk_admin_session=22222222-2222-2222-2222-222222222222")).status).toBe(401);
  });

  it("returns a reviewable definition and summary for a good file, and stores nothing", async () => {
    const res = await post({ xml: fixture("digits-over-recovery") });
    expect(res.status).toBe(200);
    expect(res.body.data.ok).toBe(true);
    expect(res.body.data.definition.kind).toBe("dbot");
    expect(res.body.data.summary.contractTypes).toEqual(["DIGITOVER"]);
    expect(res.body.data.warnings.length).toBeGreaterThan(0);
  });

  it("explains what's wrong with a file it can't run — as data, not an error page", async () => {
    const res = await post({ xml: fixture("digits-differs-martingale-timeouts") });
    expect(res.status).toBe(200);
    expect(res.body.data.ok).toBe(false);
    expect(JSON.stringify(res.body.data.issues)).toMatch(/sell_at_market/);

    const accepted = await post({ xml: fixture("digits-differs-martingale-timeouts"), ignore: ["sell_at_market"] });
    expect(accepted.body.data.ok).toBe(true);
    expect(accepted.body.data.definition.program.ignored).toEqual(["sell_at_market"]);
  });

  it("only lets an admin ignore the blocks the rulebook allows", async () => {
    const res = await post({ xml: fixture("digits-over-recovery"), ignore: ["purchase"] });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/can't be ignored/);
  });

  it("rejects missing or oversized input and hostile XML cleanly", async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ xml: "x".repeat(230_000) })).status).toBe(400);
    const bomb = await post({ xml: `<!DOCTYPE x [<!ENTITY a "aaaa">]><xml>&a;&a;</xml>` });
    expect(bomb.status).toBe(200);
    expect(bomb.body.data.ok).toBe(false);
  });

  it("a saved program is validated again by the create-strategy schema (a tampered one is refused)", async () => {
    const preview = await post({ xml: fixture("digits-over-recovery") });
    const def = preview.body.data.definition;
    const { createStrategySchema } = await import("./bots.schemas.js");
    expect(createStrategySchema.safeParse({ key: "x-bot", name: "n", description: "d", definition: def }).success).toBe(true);
    const tampered = JSON.parse(JSON.stringify(def));
    tampered.program.before[0] = { type: "eval_js", f: { CODE: "process.exit(1)" } };
    const r = createStrategySchema.safeParse({ key: "x-bot", name: "n", description: "d", definition: tampered });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]!.message).toMatch(/eval_js/);
  });
});
