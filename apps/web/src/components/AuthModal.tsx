/**
 * Sign in / create account modal (opened from anywhere via the store's
 * `openAuth` event). Inline validation mirrors the server rules: usernames
 * 3-20 chars [A-Za-z0-9_], passwords 8-100 chars. Server ack errors render
 * inside the modal rather than as toasts.
 */
import { useState } from "react";
import { call } from "../socket";
import { persistAccountToken, useApp } from "../store";
import { Modal } from "./Modal";

type Tab = "login" | "register";

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

function usernameError(username: string): string | null {
  if (username.length === 0) return "Pick a username";
  if (!USERNAME_RE.test(username)) return "3–20 characters: letters, numbers and underscores only";
  return null;
}

function passwordError(password: string): string | null {
  if (password.length === 0) return "Enter a password";
  if (password.length < 8) return "At least 8 characters";
  if (password.length > 100) return "At most 100 characters";
  return null;
}

export function AuthModal(): JSX.Element {
  const { dispatch, pushToast } = useApp();
  const [tab, setTab] = useState<Tab>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const uErr = usernameError(username.trim());
  const pErr = passwordError(password);
  const valid = uErr === null && pErr === null;

  const close = (): void => dispatch({ type: "closeAuth" });

  const submit = async (): Promise<void> => {
    setTouched(true);
    if (!valid || busy) return;
    setBusy(true);
    setServerError(null);
    const args = { username: username.trim(), password };
    const r = tab === "login" ? await call("login", args) : await call("register", args);
    setBusy(false);
    if (r.ok && r.data) {
      persistAccountToken(r.data.token);
      dispatch({ type: "accountState", account: { account: r.data.account, rating: r.data.rating } });
      pushToast(
        tab === "login"
          ? `Welcome back, ${r.data.account.username}!`
          : `Account created — welcome, ${r.data.account.username}!`,
        "success"
      );
      close();
    } else {
      setServerError(r.error ?? (tab === "login" ? "Sign in failed" : "Could not create the account"));
    }
  };

  return (
    <Modal
      title={tab === "login" ? "Sign in" : "Create account"}
      onClose={close}
      onConfirm={() => void submit()}
      confirmLabel={busy ? "One moment…" : tab === "login" ? "Sign in" : "Create account"}
      confirmDisabled={busy || (touched && !valid)}
      width="sm"
    >
      {/* Tabs */}
      <div className="mb-4 grid grid-cols-2 gap-1 rounded-lg bg-white/[0.04] p-1">
        {(["login", "register"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => {
              setTab(t);
              setServerError(null);
              setTouched(false);
            }}
            className={`rounded-md py-1.5 text-xs font-bold transition-all duration-150 ${
              tab === t
                ? "bg-gradient-to-b from-brass-300 to-brass-500 text-amber-950 shadow-card"
                : "text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200"
            }`}
          >
            {t === "login" ? "Sign in" : "Create account"}
          </button>
        ))}
      </div>

      <div className="space-y-3">
        <div>
          <label className="label" htmlFor="auth-username">Username</label>
          <input
            id="auth-username"
            className="input"
            placeholder="planeswalker_42"
            value={username}
            maxLength={20}
            autoFocus
            autoComplete="username"
            onChange={(e) => setUsername(e.target.value)}
            onBlur={() => setTouched(true)}
          />
          {touched && uErr ? (
            <p className="mt-1 text-[11px] text-red-400">{uErr}</p>
          ) : (
            tab === "register" && <p className="mt-1 text-[11px] text-zinc-500">3–20 characters: letters, numbers, underscores.</p>
          )}
        </div>
        <div>
          <label className="label" htmlFor="auth-password">Password</label>
          <input
            id="auth-password"
            type="password"
            className="input"
            placeholder="••••••••"
            value={password}
            maxLength={100}
            autoComplete={tab === "login" ? "current-password" : "new-password"}
            onChange={(e) => setPassword(e.target.value)}
            onBlur={() => setTouched(true)}
          />
          {touched && pErr ? (
            <p className="mt-1 text-[11px] text-red-400">{pErr}</p>
          ) : (
            tab === "register" && <p className="mt-1 text-[11px] text-zinc-500">8–100 characters.</p>
          )}
        </div>

        {serverError && (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {serverError}
          </div>
        )}

        <p className="text-[11px] text-zinc-500">
          {tab === "login"
            ? "Your rank, ranked history and saved cubes ride along with your account."
            : "An account unlocks saved cubes and ranked matchmaking — everything else works without one."}
        </p>
      </div>
    </Modal>
  );
}
