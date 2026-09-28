"use client";

import { LogOut } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { Brand } from "@/components/ui";
import { initials } from "@/lib/format";
import { clearSession, loadSession, saveSession, type Session } from "@/lib/session";

import Portal from "./Portal";
import SignIn from "./SignIn";

export default function HelpCenter() {
  // undefined = not read from storage yet (avoids a sign-in flash on refresh)
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => setSession(loadSession()), []);

  const signIn = (s: Session) => {
    saveSession(s);
    setNotice(null);
    setSession(s);
  };

  const signOut = useCallback((reason?: string) => {
    clearSession();
    setNotice(reason ?? null);
    setSession(null);
  }, []);

  const expire = useCallback(() => signOut("Your session expired. Please sign in again."), [signOut]);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-10 border-b border-slate-200/70 bg-white/80 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
          <Brand subtitle="Help Center" />
          {session && (
            <div className="flex items-center gap-3">
              <span className="hidden text-right sm:block">
                <span className="block text-sm font-medium text-slate-900">{session.customer.name}</span>
                <span className="block text-xs text-slate-500">{session.customer.email}</span>
              </span>
              <span
                aria-hidden
                className="grid h-9 w-9 place-items-center rounded-full bg-indigo-100 text-sm font-semibold text-indigo-700"
              >
                {initials(session.customer.name)}
              </span>
              <button
                onClick={() => signOut()}
                aria-label="Sign out"
                className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50 hover:text-slate-900"
              >
                <LogOut className="h-4 w-4" aria-hidden /> <span className="hidden sm:inline">Sign out</span>
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="flex-1">
        {session === undefined ? null : session ? (
          <Portal
            key={session.token}
            token={session.token}
            firstName={session.customer.name.split(" ")[0] ?? session.customer.name}
            onSessionExpired={expire}
          />
        ) : (
          <SignIn onSignedIn={signIn} notice={notice} />
        )}
      </main>

      <footer className="border-t border-slate-200/70 py-6 text-center text-xs text-slate-500">
        © Shopwell (demo store) ·{" "}
        <Link href="/admin" className="underline-offset-2 hover:text-slate-700 hover:underline">
          Staff dashboard
        </Link>
      </footer>
    </div>
  );
}
