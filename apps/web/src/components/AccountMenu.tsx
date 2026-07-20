/**
 * Account chip shown in the top bar on every screen. Signed out: a "Sign in"
 * button that opens the auth modal. Signed in: username + rank badge + rating
 * with a dropdown (Profile / My cubes / Sign out). Also owns the auth,
 * profile and my-cubes modals so they are reachable from anywhere.
 */
import { useEffect, useRef, useState } from "react";
import { useApp } from "../store";
import { AuthModal } from "./AuthModal";
import { Modal } from "./Modal";
import { MyCubesList } from "./MyCubes";
import { ProfileModal } from "./ProfileModal";
import { RankBadge } from "./RankBadge";

export function AccountMenu(): JSX.Element {
  const { state, dispatch, pushToast, signOut } = useApp();
  const [open, setOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [cubesOpen, setCubesOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close the dropdown on any outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const acct = state.account;

  const itemClasses =
    "flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold text-zinc-200 transition-colors duration-150 hover:bg-white/[0.07]";

  return (
    <div className="relative" ref={rootRef}>
      {acct ? (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex items-center gap-2 rounded-full border border-amber-100/15 bg-white/[0.05] py-1 pl-3 pr-2 text-xs transition-colors duration-150 hover:border-amber-200/30 hover:bg-white/[0.09]"
            title="Account"
          >
            <span className="max-w-[9rem] truncate font-bold text-zinc-100">{acct.account.username}</span>
            <RankBadge rank={acct.rating.rank} />
            <span className="font-bold tabular-nums text-brass-300">{acct.rating.rating}</span>
            <svg
              viewBox="0 0 24 24"
              className={`h-3 w-3 fill-zinc-400 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
            >
              <path d="M12 15.5 5.5 9l1.4-1.4L12 12.7l5.1-5.1L18.5 9 12 15.5Z" />
            </svg>
          </button>

          {open && (
            <div className="absolute right-0 top-full z-50 mt-1.5 w-44 animate-pop-in overflow-hidden rounded-xl border border-amber-100/15 bg-felt-900 py-1 shadow-card-lg">
              <button
                type="button"
                className={itemClasses}
                onClick={() => {
                  setOpen(false);
                  setProfileOpen(true);
                }}
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-zinc-400">
                  <path d="M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Zm0 2c-4 0-8 2-8 5v2h16v-2c0-3-4-5-8-5Z" />
                </svg>
                Profile
              </button>
              <button
                type="button"
                className={itemClasses}
                onClick={() => {
                  setOpen(false);
                  setCubesOpen(true);
                }}
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-zinc-400">
                  <path d="M12 1.5 3 6.75v10.5L12 22.5l9-5.25V6.75L12 1.5Zm0 2.3 7 4.08v8.24l-7 4.08-7-4.08V7.88l7-4.08Z" />
                </svg>
                My cubes
              </button>
              {acct.account.isAdmin && (
                <button
                  type="button"
                  className={itemClasses}
                  onClick={() => {
                    setOpen(false);
                    dispatch({ type: "openAdmin" });
                  }}
                >
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-brass-400/90">
                    <path d="M12 1.75 4 5v6c0 5.05 3.41 9.76 8 11.25 4.59-1.49 8-6.2 8-11.25V5l-8-3.25Zm-1.2 14.3-3.3-3.3 1.4-1.4 1.9 1.9 4.3-4.3 1.4 1.4-5.7 5.7Z" />
                  </svg>
                  Admin portal
                </button>
              )}
              <div className="my-1 border-t border-amber-100/[0.08]" />
              <button
                type="button"
                className={`${itemClasses} text-red-300 hover:!bg-red-500/10`}
                onClick={() => {
                  setOpen(false);
                  signOut();
                  pushToast("Signed out — see you on the ladder", "info");
                }}
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current">
                  <path d="M10 3h4v2h-4v14h4v2h-6V3h2Zm7.5 4.5L16 9l2 2h-8v2h8l-2 2 1.5 1.5L22 12l-4.5-4.5Z" />
                </svg>
                Sign out
              </button>
            </div>
          )}
        </>
      ) : (
        <button
          type="button"
          className="btn-ghost !px-3 !py-1.5 !text-xs"
          onClick={() => dispatch({ type: "openAuth" })}
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current">
            <path d="M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Zm0 2c-4 0-8 2-8 5v2h16v-2c0-3-4-5-8-5Z" />
          </svg>
          Sign in
        </button>
      )}

      {state.authOpen && <AuthModal />}
      {profileOpen && <ProfileModal onClose={() => setProfileOpen(false)} />}
      {cubesOpen && (
        <Modal title="My cubes" onClose={() => setCubesOpen(false)} width="md" noFooter>
          <MyCubesList />
        </Modal>
      )}
    </div>
  );
}
