// Sign in: one password (the app has a single owner). Minimal and square in
// the Kilowatt Events look: a thin gold bar along the top of a plain page,
// the lockup (black on the light theme, white on the dark), the product name
// in Montserrat Black, the field and a black "Sign in" with gold text. After
// signing in, the browser goes back to where it was headed (`next`).

import { useRef, useState, type FormEvent } from "react";
import { api, ApiError } from "../api";
import { navigate } from "../router";
import { PRODUCT_NAME } from "../../shared/constants";
import Logo from "../ui/Logo";
import Spinner from "../ui/Spinner";

function loginError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 0) return "Couldn't reach the server — check the connection and try again.";
    if (err.status >= 500 && !err.message) return "The server had a problem — try again in a moment.";
    return err.message || "That didn't work — try again.";
  }
  return "That didn't work — try again.";
}

export default function LoginPage({ next }: { next: string }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const passwordRef = useRef<HTMLInputElement>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError("");
    try {
      await api.login(password);
      navigate(next, { replace: true });
    } catch (err) {
      setError(loginError(err));
      setBusy(false);
      // ready for another try
      requestAnimationFrame(() => passwordRef.current?.select());
    }
  }

  return (
    <main className="login-page">
      <form className="login-card" onSubmit={submit} noValidate>
        <Logo variant="lockup" tone="page" height={44} className="login-logo" />
        <h1>{PRODUCT_NAME}</h1>
        <p className="muted">Enter the app password to open your event plans.</p>

        {/* Password managers pair a password with a username; there's only one owner. */}
        <input type="text" name="username" autoComplete="username" value="owner" readOnly tabIndex={-1} aria-hidden="true" className="sr-only" />

        <label htmlFor="login-password">Password</label>
        <input
          ref={passwordRef}
          id="login-password"
          name="password"
          type="password"
          autoComplete="current-password"
          autoFocus
          enterKeyHint="go"
          value={password}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "login-error" : undefined}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && (
          <div id="login-error" className="error-text login-error" role="alert">
            {error}
          </div>
        )}
        <button type="submit" className={`primary${busy ? " busy" : ""}`} disabled={busy || !password}>
          {busy ? (
            <>
              <Spinner /> Signing in…
            </>
          ) : (
            "Sign in"
          )}
        </button>
        <p className="login-foot">This device stays signed in until you sign out.</p>
      </form>
    </main>
  );
}
