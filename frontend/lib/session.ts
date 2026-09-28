/**
 * The customer's help-center session, kept in sessionStorage: it survives a
 * page refresh and is cleared when the tab closes. The token expires
 * server-side after 2 hours regardless.
 */
import type { SignInResult } from "./api";

const KEY = "helpcenter.session";

export type Session = SignInResult;

export function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const session = JSON.parse(raw) as Session;
    return new Date(session.expiresAt).getTime() > Date.now() ? session : null;
  } catch {
    return null;
  }
}

export function saveSession(session: Session): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(session));
  } catch {
    // Storage unavailable (private mode): the session just won't survive a refresh.
  }
}

export function clearSession(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
