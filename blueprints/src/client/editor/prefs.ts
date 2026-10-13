// Small per-device editor preferences in localStorage. Storage can throw
// (private mode, blocked, full), so every access is guarded and falls back
// to the default.

export const PREF_LEFT_COLLAPSED = "bpn-left-collapsed";
export const PREF_NOTES_SCOPE = "bpn-notes-scope";

export function readPref(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* storage off: the preference just isn't remembered */
  }
}
