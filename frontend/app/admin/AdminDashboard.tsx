"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

import {
  ApiError,
  api,
  type DecisionSource,
  type ReasoningStep,
  type RefundDetail,
  type RefundListItem,
  type RefundStatus,
} from "@/lib/api";
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

const FILTERS: { value: RefundStatus | "ALL"; label: string }[] = [
  { value: "ALL", label: "All" },
  { value: "PENDING", label: "Pending" },
  { value: "APPROVED", label: "Approved" },
  { value: "DENIED", label: "Denied" },
  { value: "ESCALATED", label: "Escalated" },
];

const SOURCE: Record<DecisionSource, string> = {
  policy_engine: "Policy rules",
  injection_guard: "Injection guard",
  ai_assisted: "AI-assisted",
  ai_unavailable: "AI unavailable",
};

const humanize = (s: string) => s.replace(/_/g, " ");

function flagStyle(flag: string): { label: string; cls: string } {
  if (flag.startsWith("injection:")) {
    return { label: `injection: ${humanize(flag.slice("injection:".length))}`, cls: "bg-rose-100 text-rose-800" };
  }
  if (flag === "suspicious_pattern") return { label: "suspicious pattern", cls: "bg-amber-100 text-amber-900" };
  if (flag.startsWith("ai_")) return { label: humanize(flag), cls: "bg-slate-100 text-slate-700" };
  return { label: humanize(flag), cls: "bg-sky-100 text-sky-800" }; // flags raised by Claude
}

/** Injection or suspicion signals: the ones worth a reviewer's attention first. */
const isRiskFlag = (f: string) => f.startsWith("injection:") || f === "suspicious_pattern";

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

  const load = useCallback(async (signal?: AbortSignal) => {
    setRefreshing(true);
    setListError(null);
    try {
      setRows(await api.listRefundRequests(signal));
      setDetails({}); // decisions may have changed; refetch on expand
      setRerunState({});
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

  const visible = useMemo(
    () =>
      (rows ?? []).filter(
        (r) => (filter === "ALL" || r.status === filter) && (!flaggedOnly || (r.flags ?? []).some(isRiskFlag)),
      ),
    [rows, filter, flaggedOnly],
  );

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:py-10">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Refund requests</h1>
          <p className="text-sm text-slate-600">Every request with its decision and how it was reached.</p>
        </div>
        <button
          onClick={() => void load()}
          disabled={refreshing}
          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50"
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="Filter by decision" className="flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              aria-pressed={filter === f.value}
              className={`rounded-md px-3 py-1 text-sm ${
                filter === f.value ? "bg-white font-medium shadow-sm" : "text-slate-600 hover:text-slate-900"
              }`}
            >
              {f.label}
              {rows && <span className="ml-1.5 text-xs tabular-nums text-slate-500">{counts[f.value] ?? 0}</span>}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={flaggedOnly}
            onChange={(e) => setFlaggedOnly(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300"
          />
          Only injection / suspicion flags
        </label>
      </div>

      {listError && (
        <div role="alert" className="mb-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          {listError}{" "}
          <button onClick={() => void load()} className="font-medium underline">
            Try again
          </button>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
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
  if (!step.consulted) return <span className="text-slate-500">n/a: Claude not consulted</span>;
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
              Claude: <span className="text-slate-600">not consulted</span>
            </StepTitle>
            <p className="mt-1 text-slate-600">{step.skippedBecause}</p>
          </div>
        );
      }
      if (step.outcome === "unavailable") {
        return (
          <div>
            <StepTitle>
              Claude ({step.model}): <b className="text-slate-700">unavailable</b>
            </StepTitle>
            <p className="mt-1 text-slate-600">Escalated to a human. Error: {step.error}</p>
          </div>
        );
      }
      return (
        <div>
          <StepTitle>
            Claude ({step.model}) recommends <b>{step.recommendation}</b>
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
