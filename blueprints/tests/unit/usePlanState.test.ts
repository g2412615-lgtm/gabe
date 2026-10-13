// The React binding, rendered on the server side (no DOM needed): the
// selected slice reaches the component and the selector cache is consistent.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createPlanStore } from "../../src/client/sync/store";
import type { PlanState } from "../../src/client/sync/types";
import { usePlanState } from "../../src/client/sync/usePlanState";
import { FakeEnv, FakeNet, FakeServer, MemoryStorage } from "./fakes";

describe("usePlanState", () => {
  it("renders the selected slice of the store", async () => {
    const server = new FakeServer({ pages: 3, name: "Spring concert" });
    const store = createPlanStore(server.planId, { transport: new FakeNet(server).transport, storage: new MemoryStorage(), env: new FakeEnv(), notify: () => {} });
    await store.load();

    let renders = 0;
    function Header() {
      renders++;
      const name = usePlanState(store, (s) => s.plan?.name ?? "");
      // a selector that builds a new object every call must not loop
      const summary = usePlanState(
        store,
        (s: PlanState) => ({ pages: s.pages.length, state: s.save.state }),
        (a, b) => a.pages === b.pages && a.state === b.state,
      );
      return createElement("h1", null, `${name} · ${summary.pages} pages · ${summary.state}`);
    }
    expect(renderToStaticMarkup(createElement(Header))).toBe("<h1>Spring concert · 3 pages · saved</h1>");
    expect(renders).toBe(1);
    store.dispose();
  });
});
