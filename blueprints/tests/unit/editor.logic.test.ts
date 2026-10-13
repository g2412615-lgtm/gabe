// Small editor decisions that don't need a browser: when the comments panel
// holds still, whether a circle is under the panel, which keys belong to a
// focused field, and the timing of names saved while typing.

import { afterEach, describe, expect, it, vi } from "vitest";
import { holdsTyping, panelBusy, underCover } from "../../src/client/editor/panelLogic";
import { keyBelongsToField } from "../../src/client/editor/useEditorKeys";
import { cleanName, TYPING_COMMIT_MS, typingCommitter } from "../../src/client/ui/InlineRename";

describe("the comments panel holding still (busy)", () => {
  const idle = { pointerInPanel: false, editing: false, typing: false };

  it("an empty composer that merely has focus doesn't hold it — hover keeps switching circles", () => {
    // after adding a circle or a comment with a mouse, the composer has focus and no text
    expect(panelBusy({ ...idle, typing: holdsTyping(true, "") })).toBe(false);
    expect(panelBusy({ ...idle, typing: holdsTyping(true, "  \n ") })).toBe(false);
  });

  it("typing in a focused field, an open comment editor or the pointer over the panel hold it", () => {
    expect(panelBusy({ ...idle, typing: holdsTyping(true, "Gate A") })).toBe(true);
    expect(panelBusy({ ...idle, editing: true })).toBe(true);
    expect(panelBusy({ ...idle, pointerInPanel: true })).toBe(true);
  });

  it("text in a field that has lost focus doesn't hold it", () => {
    expect(holdsTyping(false, "draft")).toBe(false);
  });
});

describe("a circle under the floating panel", () => {
  // a 1000 × 500 page drawn 1:1 at the stage's top left; the stage is 1000 × 800
  const page = { width: 1000, height: 500 };
  const view = { scale: 1, tx: 0, ty: 0 };
  const stage = { w: 1000, h: 800 };
  const panel = { right: 340, bottom: 0 };
  const r = 20 / 1000; // 20 px

  it("is under it when any of it reaches into the panel's strip", () => {
    expect(underCover({ x: 0.85, y: 0.5, r }, page, view, stage, panel)).toBe(true);
    expect(underCover({ x: 0.65, y: 0.5, r }, page, view, stage, panel)).toBe(true); // 650 + 20 > 660
    expect(underCover({ x: 0.6, y: 0.5, r }, page, view, stage, panel)).toBe(false);
  });

  it("follows the view, and ignores circles off the stage", () => {
    expect(underCover({ x: 0.85, y: 0.5, r }, page, { scale: 1, tx: -400, ty: 0 }, stage, panel)).toBe(false);
    expect(underCover({ x: 0.85, y: 0.5, r }, page, { scale: 1, tx: 300, ty: 0 }, stage, panel)).toBe(false); // right of the stage
    expect(underCover({ x: 0.85, y: 0.5, r }, page, view, stage, { right: 0, bottom: 0 })).toBe(false);
  });

  it("the phone's bottom sheet covers the bottom", () => {
    const sheet = { right: 0, bottom: 480 };
    expect(underCover({ x: 0.5, y: 0.9, r }, page, { scale: 1, tx: 0, ty: 300 }, stage, sheet)).toBe(true);
    expect(underCover({ x: 0.5, y: 0.1, r }, page, view, stage, sheet)).toBe(false);
  });
});

describe("keys while something in the editor has focus", () => {
  const range = { tagName: "INPUT", type: "range" };

  it("a focused size slider keeps only the keys it moves with", () => {
    for (const k of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]) expect(keyBelongsToField(range, k)).toBe(true);
    // ⌘/Ctrl+Z, Esc and the letter shortcuts work right after a drag (Chrome leaves focus on the slider)
    for (const k of ["z", "y", "Escape", "v", "c", "f", "[", "]", "+", "-", "0", "Delete"]) expect(keyBelongsToField(range, k)).toBe(false);
  });

  it("buttons and checkboxes keep none; text fields keep them all", () => {
    expect(keyBelongsToField({ tagName: "BUTTON" }, "z")).toBe(false);
    expect(keyBelongsToField({ tagName: "INPUT", type: "checkbox" }, "Escape")).toBe(false);
    expect(keyBelongsToField({ tagName: "INPUT", type: "button" }, "v")).toBe(false);
    expect(keyBelongsToField({ tagName: "INPUT", type: "text" }, "z")).toBe(true);
    expect(keyBelongsToField({ tagName: "INPUT", type: "search" }, "Escape")).toBe(true);
    expect(keyBelongsToField({ tagName: "INPUT" }, "v")).toBe(true); // no type: text
    expect(keyBelongsToField({ tagName: "TEXTAREA" }, "Escape")).toBe(true);
    expect(keyBelongsToField({ tagName: "SELECT" }, "ArrowDown")).toBe(true);
    expect(keyBelongsToField({ tagName: "DIV", isContentEditable: true }, "z")).toBe(true);
    expect(keyBelongsToField({ tagName: "DIV" }, "z")).toBe(false);
    expect(keyBelongsToField(null, "z")).toBe(false);
  });
});

describe("names saved while typing (InlineRename commitWhileTyping)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("commits after a pause in the typing, once, with the latest text", () => {
    vi.useFakeTimers();
    const commits: string[] = [];
    const typed = typingCommitter((t) => commits.push(t));
    for (const t of ["H", "Ho", "Hom", "Home"]) {
      typed.change(t);
      vi.advanceTimersByTime(TYPING_COMMIT_MS / 2);
    }
    expect(commits).toEqual([]);
    vi.advanceTimersByTime(TYPING_COMMIT_MS);
    expect(commits).toEqual(["Home"]);
    typed.change("Home opener");
    vi.advanceTimersByTime(TYPING_COMMIT_MS);
    expect(commits).toEqual(["Home", "Home opener"]);
  });

  it("flush sends a waiting change at once (blur, unmount); cancel drops it (Enter/Escape commit themselves)", () => {
    vi.useFakeTimers();
    const commits: string[] = [];
    const typed = typingCommitter((t) => commits.push(t));
    typed.flush();
    expect(commits).toEqual([]);
    typed.change("North parking");
    typed.flush();
    expect(commits).toEqual(["North parking"]);
    typed.change("North parking lot");
    typed.cancel();
    vi.advanceTimersByTime(TYPING_COMMIT_MS * 2);
    expect(commits).toEqual(["North parking"]);
  });

  it("a name is trimmed and capped; a blank one isn't a name", () => {
    expect(cleanName("  Spring concert  ")).toBe("Spring concert");
    expect(cleanName("abcdef", 3)).toBe("abc");
    expect(cleanName("   ")).toBe("");
  });
});
