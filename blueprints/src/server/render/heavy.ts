// One heavy worker at a time: a page render or a "Download PDF" export.
// Each can take several hundred MB (an export of big scans over a GB), and
// the machine has 2 GB and no swap — run together, the kernel would kill one
// of them. So each waits for its turn, first come first served: an export
// waits at most for the page being prepared, and the render queue takes its
// next page once the export is made.

let tail: Promise<void> = Promise.resolve();

/** Resolves when it's the caller's turn, with the function that ends it (call it exactly once; later calls do nothing). */
export function heavyTurn(): Promise<() => void> {
  const before = tail;
  let end!: () => void;
  tail = new Promise<void>((resolve) => (end = resolve));
  let ended = false;
  return before.then(() => () => {
    if (ended) return;
    ended = true;
    end();
  });
}
