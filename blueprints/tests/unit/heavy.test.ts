// Page renders and PDF exports take turns (render/heavy.ts): first come,
// first served, one at a time, and ending a turn twice can't start two.

import { describe, expect, it } from "vitest";
import { heavyTurn } from "../../src/server/render/heavy";

describe("heavyTurn", () => {
  it("one at a time, in the order asked", async () => {
    const log: string[] = [];
    const job = async (name: string, ms: number) => {
      const done = await heavyTurn();
      log.push(`${name} start`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`${name} end`);
      done();
      done(); // a second call does nothing
    };
    await Promise.all([job("render", 30), job("export", 5), job("render 2", 5)]);
    expect(log).toEqual(["render start", "render end", "export start", "export end", "render 2 start", "render 2 end"]);
  });
});
