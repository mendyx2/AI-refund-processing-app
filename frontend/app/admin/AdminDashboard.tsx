"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

import {
  ApiError,
  api,
  type DecisionSource,
  type ReasoningStep,
  type RefundDetail,
  type RefundListItem,
  type Health,
  type RefundStatus,
} from "@/lib/api";
import {
  Bot,
  CircleCheck,
  CircleX,
  Clock,
  Hourglass,
  Inbox,
  RefreshCw,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";

import { Brand } from "@/components/ui";
import { dateTime, money } from "@/lib/format";

// ---------------------------------------------------------------------------
// Labels and styles
// ---------------------------------------------------------------------------

const STATUS: Record<RefundStatus, { label: string; cls: string }> = {
  APPROVED: { label: "Approved", cls: "bg-emerald-100 text-emerald-800" },
  DENIED: { label: "Denied", cls: "bg-rose-100 text-rose-800" },
  ESCALATED: { label: "Escalated", cls: "bg-amber-100 text-amber-800" },
  PENDING: { label: "Pending", cls: "bg-slate-100 text-slate-700" },
};

type Tile =
  | { kind: "status"; value: RefundStatus | "ALL"; label: string; icon: LucideIcon; chip: string }
  | { kind: "risk"; label: string; icon: LucideIcon; chip: string };

/** Summary tiles; each one filters the table. Status colors always come with an icon + label. */
const TILES: Tile[] = [
  { kind: "status", value: "ALL", label: "All requests", icon: Inbox, chip: "bg-slate-100 text-slate-600" },
  { kind: "status", value: "PENDING", label: "Awaiting decision", icon: Clock, chip: "bg-slate-100 text-slate-600" },
  { kind: "status", value: "APPROVED", label: "Approved", icon: CircleCheck, chip: "bg-emerald-50 text-emerald-600" },
  { kind: "status", value: "DENIED", label: "Denied", icon: CircleX, chip: "bg-rose-50 text-rose-600" },
  { kind: "status", value: "ESCALATED", label: "Escalated", icon: Hourglass, chip: "bg-amber-50 text-amber-600" },
  { kind: "risk", label: "Risk flags", icon: ShieldAlert, chip: "bg-rose-50 text-rose-600" },
];

const SOURCE: Record<DecisionSource, string> = {
  policy_engine: "Policy rules",
  injection_guard: "Injection guard",
  ai_assisted: "AI-assisted",
  ai_unavailable: "AI unavailable",
};

const humanize = (s: string) => s.replace(/_/g, " ");

const PROVIDER_LABEL: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Gemini",
  "openai-compatible": "OpenAI-compatible",
  none: "not configured",
};

/** "AI (OpenAI · gpt-4.1)"; older traces without a provider show just the model. */
const aiLabel = (step: { provider?: string; model: string }) => {
  const provider = step.provider ? (PROVIDER_LABEL[step.provider] ?? step.provider) : null;
  if (step.provider === "none") return "AI (not configured)";
  return `AI (${[provider, step.model].filter(Boolean).join(" · ")})`;
};

function flagStyle(flag: string): { label: string; cls: string } {
  if (flag.startsWith("injection:")) {
    return { label: `injection: ${humanize(flag.slice("injection:".length))}`, cls: "bg-rose-100 text-rose-800" };
  }
  if (flag === "suspicious_pattern") return { label: "suspicious pattern", cls: "bg-amber-100 text-amber-900" };
  if (flag === "conflicting_request") return { label: "conflicting request", cls: "bg-amber-100 text-amber-900" };
  if (flag.startsWith("ai_")) {
    return { label: AI_ERRORS[flag]?.short ?? humanize(flag), cls: "bg-slate-100 text-slate-700" };
  }
  return { label: humanize(flag), cls: "bg-sky-100 text-sky-800" }; // flags raised by the AI model
}

/** What each AI failure code means and what staff can do about it. */
const AI_ERRORS: Record<string, { short: string; explain: string }> = {
  ai_api_error_429: {
    short: "AI rate-limited",
    explain:
      "The AI provider rate-limited this request (HTTP 429): too many requests in a short time. Free models " +
      "allow only a few requests per minute and per day. Wait a minute and press Re-run decision, or switch to " +
      "a model or provider with higher limits (see README).",
  },
  ai_api_error_401: {
    short: "AI key rejected",
    explain: "The AI provider rejected the API key. Check the key in .env.",
  },
  ai_api_error_403: {
    short: "AI access denied",
    explain: "The AI provider refused access (HTTP 403). Check the key's permissions or network restrictions.",
  },
  ai_api_error_404: {
    short: "AI model not found",
    explain: "The configured model wasn't found (HTTP 404). Check AI_MODEL matches the provider's model id.",
  },
  ai_api_error_network: {
    short: "AI unreachable",
    explain: "The AI provider couldn't be reached. Check the internet connection, then Re-run.",
  },
  ai_client_error: { short: "AI client error", explain: "The AI request failed before reaching the provider." },
  ai_no_assessment: {
    short: "AI gave no assessment",
    explain:
      "The model replied without using the required assessment tool. Small or free models sometimes do this; " +
      "a stronger model is more reliable.",
  },
  ai_invalid_assessment: {
    short: "AI answer invalid",
    explain: "The model's answer didn't match the required format, so it was not used.",
  },
  ai_refused: { short: "AI declined", explain: "The model declined to assess this request." },
  ai_truncated: { short: "AI answer cut off", explain: "The model's answer was cut off before it finished." },
  ai_not_configured: { short: "AI not configured", explain: "No AI provider is configured (no API key set)." },
};

function aiErrorText(code: string | undefined): string {
  if (!code) return "The AI check could not run.";
  if (AI_ERRORS[code]) return AI_ERRORS[code].explain;
  if (/^ai_api_error_5\d\d$/.test(code)) return "The AI provider had a temporary server error. Re-run later.";
  return `The AI check could not run (${code}).`;
}

/** Injection, suspicion, and conflict signals: the ones worth a reviewer's attention first. */
const isRiskFlag = (f: string) =>
  f.startsWith("injection:") || f === "suspicious_pattern" || f === "conflicting_request";

const errorText = (err: unknown) => {
  if (!(err instanceof ApiError)) return "Something went wrong. Please try again.";
  if (err.code === "conflict") return "This request has already been decided. Refresh to see the latest.";
  if (err.code === "not_found") return "This request no longer exists. Refresh the list.";
  return err.message;
};

/** Only open requests can be re-run; approved and denied are final. */
const canRerun = (status: RefundStatus) => status === "PENDING" || status === "ESCALATED";

const toListItem = (d: RefundDetail): RefundListItem => ({
  id: d.id,
  status: d.status,
  reason: d.reason,
  amountCents: d.amountCents,
  requestedAt: d.requestedAt,
  resolvedAt: d.resolvedAt,
  decisionSource: d.decisionSource,
  injectionDetected: d.injectionDetected,
  flags: d.flags,
  customer: d.customer,
  order: {
    id: d.order.id,
    orderNumber: d.order.orderNumber,
    productName: d.order.productName,
    totalCents: d.order.totalCents,
  },
});

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

type RerunState = { state: "running" } | { state: "error"; message: string } | { state: "done"; status: RefundStatus };

type DetailState = { state: "loading" } | { state: "error"; message: string } | { state: "ok"; data: RefundDetail };

export default function AdminDashboard() {
  const [rows, setRows] = useState<RefundListItem[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<RefundStatus | "ALL">("ALL");
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [details, setDetails] = useState<Record<number, DetailState>>({});
  const [rerunState, setRerunState] = useState<Record<number, RerunState>>({});
  // Rows re-run since the last filter change stay visible even if their new
  // status no longer matches the filter, so the result doesn't vanish.
  const [pinned, setPinned] = useState<Set<number>>(new Set());
  const [ai, setAi] = useState<Health["ai"] | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    api
      .health(ctrl.signal)
      .then((h) => setAi(h.ai ?? null))
      .catch(() => {}); // informational only
    return () => ctrl.abort();
  }, []);

  const load = useCallback(async (signal?: AbortSignal) => {
    setRefreshing(true);
    setListError(null);
    try {
      setRows(await api.listRefundRequests(signal));
      setDetails({}); // decisions may have changed; refetch on expand
      setRerunState({});
      setPinned(new Set());
    } catch (err) {
      if (!signal?.aborted) setListError(errorText(err));
    } finally {
      if (!signal?.aborted) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  const loadDetail = useCallback(async (id: number) => {
    setDetails((d) => ({ ...d, [id]: { state: "loading" } }));
    try {
      const data = await api.getRefundRequest(id);
      setDetails((d) => ({ ...d, [id]: { state: "ok", data } }));
    } catch (err) {
      setDetails((d) => ({ ...d, [id]: { state: "error", message: errorText(err) } }));
    }
  }, []);

  async function rerun(id: number) {
    setRerunState((r) => ({ ...r, [id]: { state: "running" } }));
    setPinned((p) => new Set(p).add(id));
    try {
      const data = await api.rerunRefundRequest(id);
      setDetails((d) => ({ ...d, [id]: { state: "ok", data } }));
      setRows((rs) => rs?.map((r) => (r.id === id ? toListItem(data) : r)) ?? rs);
      setRerunState((r) => ({ ...r, [id]: { state: "done", status: data.status } }));
    } catch (err) {
      setRerunState((r) => ({ ...r, [id]: { state: "error", message: errorText(err) } }));
    }
  }

  function toggle(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (!expanded.has(id) && !details[id]) void loadDetail(id);
  }

  const counts = useMemo(() => {
    const c: Record<string, number> = { ALL: rows?.length ?? 0 };
    for (const r of rows ?? []) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  }, [rows]);

  const riskCount = useMemo(() => (rows ?? []).filter((r) => (r.flags ?? []).some(isRiskFlag)).length, [rows]);

  const visible = useMemo(
    () =>
      (rows ?? []).filter(
        (r) =>
          pinned.has(r.id) ||
          ((filter === "ALL" || r.status === filter) && (!flaggedOnly || (r.flags ?? []).some(isRiskFlag))),
      ),
    [rows, filter, flaggedOnly, pinned],
  );

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-slate-200/70 bg-white/80 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <Brand subtitle="Staff dashboard" />
          <div className="flex items-center gap-2">
            {ai && (
              <span
                className={`hidden items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ring-1 ring-inset sm:inline-flex ${
                  ai.configured
                    ? "bg-slate-50 text-slate-700 ring-slate-200"
                    : "bg-amber-50 text-amber-900 ring-amber-200"
                }`}
                title={
                  ai.configured
                    ? "LLM consulted for judgment calls"
                    : "Requests needing judgment are escalated to a human"
                }
              >
                <Bot className="h-3.5 w-3.5" aria-hidden />
                {ai.configured
                  ? `AI advisor: ${PROVIDER_LABEL[ai.provider] ?? ai.provider} · ${ai.model}`
                  : "AI advisor not configured"}
              </span>
            )}
            <button
              onClick={() => void load()}
              disabled={refreshing}
              className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-sm text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50 disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} aria-hidden />
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">Refund requests</h1>
          <p className="mt-1 text-slate-600">Every request, its decision, and exactly how it was reached.</p>
        </div>

        {/* Stat tiles double as the status filter */}
        <div
          role="group"
          aria-label="Filter by decision"
          className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6"
        >
          {TILES.map((t) => {
            const active = t.kind === "status" ? filter === t.value && !flaggedOnly : flaggedOnly;
            const count = t.kind === "status" ? (counts[t.value] ?? 0) : riskCount;
            const Icon = t.icon;
            return (
              <button
                key={t.label}
                onClick={() => {
                  if (t.kind === "status") {
                    setFilter(t.value);
                    setFlaggedOnly(false);
                  } else {
                    setFlaggedOnly((f) => !f);
                  }
                  setPinned(new Set());
                }}
                aria-pressed={active}
                className={`rounded-2xl bg-white p-4 text-left shadow-sm ring-1 transition hover:shadow-md ${
                  active ? "ring-2 ring-indigo-500" : "ring-slate-200 hover:ring-slate-300"
                }`}
              >
                <span className="flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-500">{t.label}</span>
                  <span className={`grid h-7 w-7 place-items-center rounded-lg ${t.chip}`}>
                    <Icon className="h-4 w-4" aria-hidden />
                  </span>
                </span>
                <span className="mt-2 block text-2xl font-semibold text-slate-900">{rows ? count : "–"}</span>
              </button>
            );
          })}
        </div>

        {listError && (
          <div role="alert" className="mb-4 rounded-xl bg-rose-50 p-3 text-sm text-rose-800 ring-1 ring-rose-200">
            {listError}{" "}
            <button onClick={() => void load()} className="font-medium underline">
              Try again
            </button>
          </div>
        )}

        <div className="overflow-x-auto rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50/80 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th scope="col" className="w-10 px-3 py-2">
                  <span className="sr-only">Expand</span>
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Customer
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Order
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Decision
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Submitted
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows === null && !listError ? (
                [0, 1, 2, 3, 4].map((i) => (
                  <tr key={i}>
                    <td colSpan={5} className="px-3 py-3">
                      <div className="h-5 animate-pulse rounded bg-slate-100" />
                    </td>
                  </tr>
                ))
              ) : visible.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-10 text-center text-slate-500">
                    {rows?.length ? "No requests match this filter." : "No refund requests yet."}
                  </td>
                </tr>
              ) : (
                visible.map((row) => {
                  const open = expanded.has(row.id);
                  const riskFlags = (row.flags ?? []).filter(isRiskFlag);
                  return (
                    <Fragment key={row.id}>
                      <tr
                        onClick={() => toggle(row.id)}
                        className={`cursor-pointer align-top hover:bg-slate-50 ${open ? "bg-slate-50" : ""}`}
                      >
                        <td className="px-3 py-3">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              toggle(row.id);
                            }}
                            aria-expanded={open}
                            aria-controls={`detail-${row.id}`}
                            aria-label={`${open ? "Collapse" : "Expand"} request #${row.id}`}
                            className="grid h-6 w-6 place-items-center rounded text-slate-500 hover:bg-slate-200"
                          >
                            <span className={`inline-block transition-transform ${open ? "rotate-90" : ""}`}>▸</span>
                          </button>
                        </td>
                        <td className="px-3 py-3">
                          <div className="font-medium">{row.customer.name}</div>
                          <div className="text-xs text-slate-500">{row.customer.email}</div>
                        </td>
                        <td className="px-3 py-3">
                          <div>{row.order.productName}</div>
                          <div className="text-xs text-slate-500">
                            {row.order.orderNumber} · {money(row.amountCents)}
                            {row.amountCents !== row.order.totalCents && ` of ${money(row.order.totalCents)}`}
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS[row.status].cls}`}>
                            {STATUS[row.status].label}
                          </span>
                          <div className="mt-1 text-xs text-slate-500">
                            {row.decisionSource
                              ? SOURCE[row.decisionSource]
                              : row.status === "PENDING"
                                ? "Awaiting decision"
                                : "Historical record"}
                          </div>
                          {riskFlags.length > 0 && (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {riskFlags.map((f) => (
                                <FlagChip key={f} flag={f} />
                              ))}
                            </div>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 text-slate-600">
                          <div>{dateTime(row.requestedAt)}</div>
                          <div className="text-xs text-slate-400">#{row.id}</div>
                        </td>
                      </tr>
                      {open && (
                        <tr id={`detail-${row.id}`} className="bg-slate-50">
                          <td colSpan={5} className="px-3 pb-5 pt-1 sm:pl-12">
                            <DetailPanel
                              detail={details[row.id]}
                              onRetry={() => void loadDetail(row.id)}
                              rerun={rerunState[row.id]}
                              onRerun={() => void rerun(row.id)}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Expanded row
// ---------------------------------------------------------------------------

function DetailPanel({
  detail,
  onRetry,
  rerun,
  onRerun,
}: {
  detail: DetailState | undefined;
  onRetry: () => void;
  rerun: RerunState | undefined;
  onRerun: () => void;
}) {
  if (!detail || detail.state === "loading") {
    return (
      <p className="py-3 text-sm text-slate-500" aria-busy="true">
        Loading details…
      </p>
    );
  }
  if (detail.state === "error") {
    return (
      <p role="alert" className="py-3 text-sm text-rose-700">
        {detail.message}{" "}
        <button onClick={onRetry} className="font-medium underline">
          Try again
        </button>
      </p>
    );
  }

  const d = detail.data;
  const aiStep = d.reasoningLog?.find((s): s is Extract<ReasoningStep, { stage: "ai" }> => s.stage === "ai");
  const flags = d.flags ?? [];

  const running = rerun?.state === "running";

  return (
    <div className="space-y-4">
      {(canRerun(d.status) || rerun) && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-white p-3 text-sm">
          {canRerun(d.status) && (
            <button
              onClick={onRerun}
              disabled={running}
              className="rounded-md bg-slate-900 px-3 py-1.5 font-medium text-white hover:bg-slate-700 disabled:opacity-50"
            >
              {running ? "Re-running…" : "Re-run decision"}
            </button>
          )}
          <span aria-live="polite" className="text-slate-600">
            {running && "Running the policy engine and AI layer again…"}
            {rerun?.state === "done" && (
              <>
                Re-run complete:{" "}
                <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS[rerun.status].cls}`}>
                  {STATUS[rerun.status].label}
                </span>
              </>
            )}
            {rerun?.state === "error" && <span className="text-rose-700">{rerun.message}</span>}
            {!rerun &&
              "Runs this request through the policy engine and AI layer again, judged as of its original date."}
          </span>
        </div>
      )}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="space-y-4">
          <Field label="Customer's message">
            {d.description ? (
              <blockquote className="whitespace-pre-wrap break-words rounded-lg border border-slate-200 bg-white p-3 text-slate-800">
                {d.description}
              </blockquote>
            ) : (
              <span className="text-slate-500">None</span>
            )}
          </Field>
          <Field label="Reason code">{humanize(d.reason).toLowerCase()}</Field>
          <Field label="Confidence">
            <Confidence step={aiStep} />
          </Field>
          <Field label="Flags">
            {flags.length ? (
              <div className="flex flex-wrap gap-1">
                {flags.map((f) => (
                  <FlagChip key={f} flag={f} />
                ))}
              </div>
            ) : (
              <span className="text-slate-500">None</span>
            )}
          </Field>
          {d.customerMessage && <Field label="Told the customer">{d.customerMessage}</Field>}
        </div>

        <Field label="Reasoning trace">
          {d.reasoningLog?.length ? (
            <Trace steps={d.reasoningLog} />
          ) : (
            <p className="text-slate-500">
              No decision trace. This request came from the seed data, not through the decision pipeline.
              {d.decisionNotes && <span className="mt-1 block text-slate-700">Notes: {d.decisionNotes}</span>}
            </p>
          )}
        </Field>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="text-sm">
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      {children}
    </div>
  );
}

function FlagChip({ flag }: { flag: string }) {
  const { label, cls } = flagStyle(flag);
  return <span className={`rounded-full px-2 py-0.5 text-xs ${cls}`}>{label}</span>;
}

function Confidence({ step }: { step: Extract<ReasoningStep, { stage: "ai" }> | undefined }) {
  if (!step) return <span className="text-slate-500">n/a</span>;
  if (!step.consulted) return <span className="text-slate-500">n/a: AI not consulted</span>;
  if (step.confidence === undefined) return <span className="text-slate-500">n/a: no assessment</span>;

  const pct = Math.round(step.confidence * 100);
  const bar = pct >= 80 ? "bg-emerald-500" : pct >= 50 ? "bg-amber-500" : "bg-rose-500";
  return (
    <div className="flex items-center gap-2">
      <div
        className="h-2 w-40 overflow-hidden rounded-full bg-slate-200"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label="AI confidence"
      >
        <div className={`h-full ${bar}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="tabular-nums">{pct}%</span>
    </div>
  );
}

function Trace({ steps }: { steps: ReasoningStep[] }) {
  return (
    <ol className="space-y-3 border-l-2 border-slate-200 pl-4">
      {steps.map((step, i) => (
        <li key={i} className="relative">
          <span className="absolute -left-[1.4rem] top-1 h-2.5 w-2.5 rounded-full border-2 border-white bg-slate-400" />
          <TraceStep step={step} />
        </li>
      ))}
    </ol>
  );
}

function TraceStep({ step }: { step: ReasoningStep }) {
  switch (step.stage) {
    case "rerun":
      return (
        <div>
          <StepTitle>
            Re-run by staff <span className="text-slate-500">· {dateTime(step.at)}</span>
          </StepTitle>
          <p className="mt-1 text-slate-600">
            Previously {step.previousStatus.toLowerCase()}
            {step.previousSource
              ? ` via ${SOURCE[step.previousSource as DecisionSource] ?? humanize(step.previousSource)}`
              : ""}
            . Judged as of {dateTime(step.evaluatedAsOf)}.
          </p>
        </div>
      );
    case "policy_engine":
      return (
        <div>
          <StepTitle>
            Policy engine: <b>{step.decision}</b>
            {step.rule && <span className="text-slate-500"> ({humanize(step.rule).toLowerCase()})</span>}
          </StepTitle>
          <ul className="mt-1 list-disc pl-5 text-slate-700">
            {step.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      );
    case "injection_scan":
      return (
        <div>
          <StepTitle>
            Injection scan:{" "}
            {step.detected ? <b className="text-rose-700">detected</b> : <span className="text-slate-600">clean</span>}
          </StepTitle>
          {step.detected && (
            <div className="mt-1 flex flex-wrap gap-1">
              {step.labels.map((l) => (
                <FlagChip key={l} flag={`injection:${l}`} />
              ))}
            </div>
          )}
        </div>
      );
    case "ai":
      if (!step.consulted) {
        return (
          <div>
            <StepTitle>
              AI: <span className="text-slate-600">not consulted</span>
            </StepTitle>
            <p className="mt-1 text-slate-600">{step.skippedBecause}</p>
          </div>
        );
      }
      if (step.outcome === "unavailable") {
        return (
          <div>
            <StepTitle>
              {aiLabel(step)}
              {step.mode === "consistency_check" ? " consistency check" : ""}:{" "}
              <b className="text-slate-700">unavailable</b>
            </StepTitle>
            <p className="mt-1 text-slate-600">{aiErrorText(step.error)}</p>
            <p className="mt-1 text-xs text-slate-500">
              While the AI is unavailable, clear-cut approvals and denials keep the rules&apos; decision; other requests
              go to a human.
            </p>
          </div>
        );
      }
      return (
        <div>
          <StepTitle>
            {step.mode === "consistency_check" ? (
              <>{aiLabel(step)} consistency check of a reason-dependent denial: </>
            ) : (
              <>{aiLabel(step)} </>
            )}
            recommends <b>{step.recommendation}</b>
            {step.confidence !== undefined && (
              <span className="text-slate-500"> · {Math.round(step.confidence * 100)}% confident</span>
            )}
          </StepTitle>
          {step.reasoning && <p className="mt-1 whitespace-pre-wrap text-slate-700">{step.reasoning}</p>}
          {!!step.flags?.length && (
            <div className="mt-1 flex flex-wrap gap-1">
              {step.flags.map((f) => (
                <FlagChip key={f} flag={f} />
              ))}
            </div>
          )}
        </div>
      );
    case "final":
      return (
        <div>
          <StepTitle>
            Final: <b>{step.decision}</b>{" "}
            <span className="text-slate-500">via {SOURCE[step.source as DecisionSource] ?? humanize(step.source)}</span>
          </StepTitle>
          {step.conflict && (
            <p className="mt-1 rounded-md bg-amber-50 p-2 text-amber-900">Rule overrode AI: {step.conflict}</p>
          )}
        </div>
      );
  }
}

function StepTitle({ children }: { children: React.ReactNode }) {
  return <div className="text-slate-900">{children}</div>;
}
