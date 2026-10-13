// A tiny history-API router: three screens don't need a library.
//
//   /                 home (event plans)
//   /plans/:id        the editor (?page=<pageId>&circle=<circleId> deep-links)
//   /login            sign in (?next=<path>)

import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react";

export type Route =
  | { name: "home" }
  | { name: "plan"; planId: string; pageId: string | null; circleId: string | null }
  | { name: "login"; next: string }
  | { name: "notFound" };

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
if (typeof window !== "undefined") window.addEventListener("popstate", notify);

/** Hooks that must run before leaving a screen (e.g. flush unsaved edits). Return false to cancel. */
const leaveGuards = new Set<() => boolean>();
export function addLeaveGuard(fn: () => boolean): () => void {
  leaveGuards.add(fn);
  return () => leaveGuards.delete(fn);
}

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  for (const g of leaveGuards) if (!g()) return;
  if (opts.replace) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  window.scrollTo(0, 0);
  notify();
}

/** Update the query string without a new history entry or a re-route (e.g. remember the open page). */
export function replaceQuery(params: Record<string, string | null>) {
  const url = new URL(window.location.href);
  for (const [k, v] of Object.entries(params)) {
    if (v === null) url.searchParams.delete(k);
    else url.searchParams.set(k, v);
  }
  const next = url.pathname + (url.searchParams.toString() ? `?${url.searchParams}` : "");
  if (next !== window.location.pathname + window.location.search) window.history.replaceState(null, "", next);
}

function parse(): Route {
  const { pathname, search } = window.location;
  const q = new URLSearchParams(search);
  if (pathname === "/" || pathname === "") return { name: "home" };
  if (pathname === "/login") return { name: "login", next: safeNext(q.get("next")) };
  const m = /^\/plans\/([A-Za-z0-9_-]{1,64})\/?$/.exec(pathname);
  if (m) return { name: "plan", planId: m[1], pageId: q.get("page"), circleId: q.get("circle") };
  return { name: "notFound" };
}

/** Only same-site paths are allowed as a post-login destination. */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\") || raw.startsWith("/login")) return "/";
  return raw.slice(0, 500);
}

let cachedKey = "";
let cachedRoute: Route = { name: "home" };
function snapshot(): Route {
  const key = window.location.pathname + window.location.search;
  if (key !== cachedKey) {
    cachedKey = key;
    cachedRoute = parse();
  }
  return cachedRoute;
}

export function useRoute(): Route {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    snapshot,
    snapshot,
  );
}

/** Send the browser to the sign-in screen, coming back here afterwards. */
export function goToLogin() {
  const here = window.location.pathname + window.location.search;
  navigate(`/login?next=${encodeURIComponent(here)}`, { replace: true });
}

export function Link({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  return (
    <a
      href={to}
      {...rest}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to);
      }}
    />
  );
}
