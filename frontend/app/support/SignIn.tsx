"use client";

import { ArrowRight, BadgeCheck, CircleAlert, Lock, Mail, Receipt, ShieldCheck, Sparkles, Users } from "lucide-react";
import { useState, type FormEvent } from "react";

import { Spinner } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import type { Session } from "@/lib/session";

const POLICY = [
  { title: "30 days", body: "to return any item for any reason, from the day it's delivered." },
  { title: "60 days", body: "if it arrived defective, damaged, or wasn't what you ordered." },
  { title: "Final sale", body: "items can only be refunded if they arrived defective or damaged." },
  { title: "Over $500", body: "refunds are always checked by a member of our team." },
];

export default function SignIn({ onSignedIn, notice }: { onSignedIn: (s: Session) => void; notice?: string | null }) {
  const [email, setEmail] = useState("");
  const [orderNumber, setOrderNumber] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      onSignedIn(await api.signIn(email, orderNumber));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-10 px-4 py-10 sm:px-6 lg:grid-cols-[1.1fr_1fr] lg:gap-16 lg:py-16">
      {/* Hero */}
      <section className="flex flex-col justify-center">
        <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-700 ring-1 ring-inset ring-indigo-100">
          <Sparkles className="h-3.5 w-3.5" aria-hidden /> Refund help center
        </span>
        <h1 className="mt-5 text-4xl font-semibold tracking-tight text-slate-900 sm:text-5xl">
          Refunds, sorted{" "}
          <span className="bg-gradient-to-r from-indigo-600 to-violet-600 bg-clip-text text-transparent">
            in minutes.
          </span>
        </h1>
        <p className="mt-4 max-w-lg text-lg text-slate-600">
          Tell us what went wrong with your order. Most requests get an answer straight away, and anything that needs a
          closer look goes to a real person.
        </p>

        <ul className="mt-8 grid gap-4 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
          {[
            { icon: BadgeCheck, title: "Instant answers", body: "Clear-cut requests are decided on the spot." },
            { icon: Users, title: "Human when it matters", body: "Unusual cases are reviewed by our team." },
            { icon: ShieldCheck, title: "Fair and consistent", body: "Every request follows the same refund policy." },
          ].map(({ icon: Icon, title, body }) => (
            <li key={title} className="flex gap-3 xl:flex-col">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white text-indigo-600 shadow-sm ring-1 ring-slate-200">
                <Icon className="h-5 w-5" aria-hidden />
              </span>
              <span>
                <span className="block text-sm font-semibold text-slate-900">{title}</span>
                <span className="block text-sm text-slate-600">{body}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      {/* Sign-in card: first on phones, so the form is above the fold */}
      <section className="order-first flex flex-col justify-center lg:order-none">
        <div className="rounded-3xl bg-white p-6 shadow-xl shadow-slate-900/5 ring-1 ring-slate-200 sm:p-8">
          <h2 className="text-xl font-semibold tracking-tight text-slate-900">Find your order</h2>
          <p className="mt-1 text-sm text-slate-600">
            Sign in with the email you ordered with and any order number from your confirmation email.
          </p>

          {notice && !error && (
            <p className="mt-4 flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {notice}
            </p>
          )}

          <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
            <Field
              id="email"
              label="Email address"
              icon={Mail}
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={setEmail}
            />
            <Field
              id="order"
              label="Order number"
              icon={Receipt}
              autoComplete="off"
              placeholder="e.g. ORD-10001"
              hint="You'll find it in your order confirmation email."
              value={orderNumber}
              onChange={setOrderNumber}
            />

            {error && (
              <p
                role="alert"
                className="flex items-start gap-2 rounded-xl bg-rose-50 p-3 text-sm text-rose-800 ring-1 ring-rose-200"
              >
                <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {error}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting || !email.trim() || !orderNumber.trim()}
              className="group flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 px-4 py-3 text-sm font-semibold text-white shadow-md shadow-indigo-600/25 transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
            >
              {submitting ? (
                <>
                  <Spinner /> Finding your orders…
                </>
              ) : (
                <>
                  Continue <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" aria-hidden />
                </>
              )}
            </button>
          </form>

          <p className="mt-5 flex items-center justify-center gap-1.5 text-xs text-slate-500">
            <Lock className="h-3.5 w-3.5" aria-hidden /> We only use these details to find your orders.
          </p>
        </div>

        <details className="group mt-6 rounded-2xl bg-white/70 p-5 ring-1 ring-slate-200 backdrop-blur">
          <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-semibold text-slate-900">
            Our refund policy at a glance
            <ArrowRight className="h-4 w-4 text-slate-400 transition group-open:rotate-90" aria-hidden />
          </summary>
          <dl className="mt-4 grid gap-3 sm:grid-cols-2">
            {POLICY.map((p) => (
              <div key={p.title} className="rounded-xl bg-slate-50 p-3">
                <dt className="text-sm font-semibold text-indigo-700">{p.title}</dt>
                <dd className="mt-0.5 text-sm text-slate-600">{p.body}</dd>
              </div>
            ))}
          </dl>
        </details>
      </section>
    </div>
  );
}

function Field(props: {
  id: string;
  label: string;
  icon: typeof Mail;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  autoComplete?: string;
  hint?: string;
}) {
  const Icon = props.icon;
  return (
    <div>
      <label htmlFor={props.id} className="block text-sm font-medium text-slate-700">
        {props.label}
      </label>
      <div className="relative mt-1.5">
        <Icon
          className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
          aria-hidden
        />
        <input
          id={props.id}
          type={props.type ?? "text"}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          placeholder={props.placeholder}
          autoComplete={props.autoComplete}
          aria-describedby={props.hint ? `${props.id}-hint` : undefined}
          required
          className="block w-full rounded-xl border-0 bg-slate-50 py-3 pl-10 pr-3 text-sm text-slate-900 ring-1 ring-inset ring-slate-200 placeholder:text-slate-400 focus:bg-white focus:ring-2 focus:ring-indigo-500"
        />
      </div>
      {props.hint && (
        <p id={`${props.id}-hint`} className="mt-1.5 text-xs text-slate-500">
          {props.hint}
        </p>
      )}
    </div>
  );
}
