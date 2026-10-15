// The order pages are shown in, shared by the device (the page list) and the
// server (where a duplicate goes): by sortOrder, then — for equal orders —
// oldest first, then their order in the uploaded file, then id.

import type { PageRow } from "./types";

export function comparePages(a: PageRow, b: PageRow): number {
  return a.sortOrder - b.sortOrder || a.createdAt - b.createdAt || a.sourceIndex - b.sourceIndex || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
