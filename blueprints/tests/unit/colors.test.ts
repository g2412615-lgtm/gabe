// The circle palette (Kilowatt Events: gold, black, red, blue, green) and the
// pre-rebrand names it still accepts ("amber" → gold, "purple" → black).

import { describe, expect, it } from "vitest";
import { cleanPatch, isColor, toColor } from "../../src/client/sync/clean";
import { CIRCLE_COLOR_ORDER, CIRCLE_COLORS, circleColorOf, DEFAULT_CIRCLE_COLOR, LEGACY_CIRCLE_COLORS } from "../../src/shared/constants";

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrastOnWhite = (hex: string) => 1.05 / (luminance(hex) + 0.05);

describe("the palette", () => {
  it("is gold, black, red, blue, green — gold first and the default", () => {
    expect(CIRCLE_COLOR_ORDER).toEqual(["gold", "black", "red", "blue", "green"]);
    expect(Object.keys(CIRCLE_COLORS).sort()).toEqual([...CIRCLE_COLOR_ORDER].sort());
    expect(DEFAULT_CIRCLE_COLOR).toBe("gold");
    expect(CIRCLE_COLOR_ORDER.map((c) => CIRCLE_COLORS[c].label)).toEqual(["Gold", "Black", "Red", "Blue", "Green"]);
  });

  it("every stroke reads on white paper (and under the white number on its badge)", () => {
    for (const c of CIRCLE_COLOR_ORDER) {
      const { stroke, fill, glow } = CIRCLE_COLORS[c];
      expect(stroke, c).toMatch(/^#[0-9a-f]{6}$/i);
      expect(contrastOnWhite(stroke), c).toBeGreaterThanOrEqual(4.5);
      // fills stay translucent so the blueprint shows through
      for (const v of [fill, glow]) expect(Number(v.match(/rgba\([^)]*,\s*([\d.]+)\)$/)?.[1]), `${c} ${v}`).toBeLessThan(1);
    }
    // gold is KW Gold as a highlighter fill, drawn with a black line (gold lines on white don't read)
    expect(CIRCLE_COLORS.gold).toMatchObject({ stroke: "#000000", fill: expect.stringMatching(/^rgba\(254, 224, 0, /) });
  });
});

describe("pre-rebrand colour names", () => {
  it("map to today's colours; current names map to themselves", () => {
    expect(circleColorOf("amber")).toBe("gold");
    expect(circleColorOf("purple")).toBe("black");
    for (const c of CIRCLE_COLOR_ORDER) expect(circleColorOf(c)).toBe(c);
    expect(toColor("amber")).toBe("gold");
    expect(toColor("purple")).toBe("black");
  });

  it("every old name points at a colour that exists, and none is still a current name", () => {
    expect([...LEGACY_CIRCLE_COLORS.keys()]).toEqual(["amber", "purple"]);
    for (const [old, now] of LEGACY_CIRCLE_COLORS) {
      expect(CIRCLE_COLOR_ORDER).toContain(now);
      expect(Object.prototype.hasOwnProperty.call(CIRCLE_COLORS, old)).toBe(false);
    }
  });

  it("anything else names no colour", () => {
    for (const v of ["pink", "Amber", "GOLD", "", "constructor", "__proto__", "toString", 3, null, undefined, {}, ["gold"]]) {
      expect(circleColorOf(v), String(v)).toBeUndefined();
      expect(toColor(v), String(v)).toBeUndefined();
    }
  });

  it("isColor only accepts current names (the UI looks palettes up by them)", () => {
    expect(isColor("gold")).toBe(true);
    expect(isColor("amber")).toBe(false);
    expect(isColor("purple")).toBe(false);
  });

  it("cleanPatch saves an old name as the new colour, like the server does, and still drops unknown ones", () => {
    expect(cleanPatch("circle", { color: "amber" })).toEqual({ color: "gold" });
    expect(cleanPatch("circle", { color: "purple", x: 0.5 })).toEqual({ color: "black", x: 0.5 });
    expect(cleanPatch("circle", { color: "black" })).toEqual({ color: "black" });
    expect(cleanPatch("circle", { color: "pink" })).toEqual({});
    expect(cleanPatch("circle", { color: 4 })).toEqual({});
  });
});
