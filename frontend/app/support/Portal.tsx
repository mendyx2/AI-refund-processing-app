"use client";

import {
  ArrowLeft,
  Bot,
  CircleCheck,
  CircleX,
  Hourglass,
  Inbox,
  RefreshCw,
  SendHorizontal,
  Tag,
  Truck,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import { CategoryIcon, Spinner } from "@/components/ui";
import {
  ApiError,
  api,
  type CustomerOrders,
  type NewRefundRequest,
  type Order,
  type RefundReason,
  type RefundResult,
} from "@/lib/api";
import { date, money, relativeDays } from "@/lib/format";

// ---------------------------------------------------------------------------
// Reasons (quick replies)
// ---------------------------------------------------------------------------

const REASONS: { value: RefundReason; label: string }[] = [
  { value: "DEFECTIVE", label: "It's defective or stopped working" },
  { value: "DAMAGED_IN_TRANSIT", label: "It arrived damaged" },
  { value: "WRONG_ITEM", label: "I received the wrong item" },
  { value: "NOT_AS_DESCRIBED", label: "It's not as described" },
  { value: "LATE_DELIVERY", label: "It hasn't arrived / arrived late" },
  { value: "CHANGED_MIND", label: "I changed my mind" },
  { value: "NO_LONGER_NEEDED", label: "I no longer need it" },
  { value: "OTHER", label: "Something else" },
];
const reasonLabel = (r: RefundReason) => REASONS.find((x) => x.value === r)?.label ?? "Something else";

const MAX_MESSAGE = 4000;

// ---------------------------------------------------------------------------
// Order state helpers
// ---------------------------------------------------------------------------

const latestRequest = (o: Order) => o.refundRequests[0] ?? null; // API returns newest first
const openRequest = (o: Order) => o.refundRequests.find((r) => r.status === "PENDING" || r.status === "ESCALATED");

function deliveryLine(o: Order): string {
  switch (o.status) {
    case "DELIVERED":
      return o.deliveredAt ? `Delivered ${relativeDays(o.deliveredAt)}` : "Delivered";
    case "SHIPPED":
      return `On its way · ordered ${relativeDays(o.orderedAt)}`;
    case "PROCESSING":
      return `Processing · ordered ${relativeDays(o.orderedAt)}`;
    case "REFUNDED":
      return `Refunded · ordered ${date(o.orderedAt)}`;
    case "CANCELLED":
      return `Cancelled · ordered ${date(o.orderedAt)}`;
  }
}

function refundBadge(o: Order): { label: string; cls: string } | null {
  if (openRequest(o)) return { label: "Refund under review", cls: "bg-amber-50 text-amber-800 ring-amber-200" };
  const last = latestRequest(o);
  if (o.status === "REFUNDED" || last?.status === "APPROVED")
    return { label: "Refunded", cls: "bg-emerald-50 text-emerald-700 ring-emerald-200" };
  if (last?.status === "DENIED") return { label: "Refund declined", cls: "bg-slate-100 text-slate-600 ring-slate-200" };
  return null;
}

// ---------------------------------------------------------------------------
// Chat model
// ---------------------------------------------------------------------------

type ChatMessage =
  | { id: string; from: "assistant"; kind: "text"; text: string }
  | { id: string; from: "customer"; kind: "text"; text: string }
  | { id: string; from: "assistant"; kind: "decision"; result: RefundResult; order: Order }
  | { id: string; from: "assistant"; kind: "error"; text: string; retry: NewRefundRequest; order: Order };

let seq = 0;
const uid = () => `m${++seq}`;
const say = (text: string): ChatMessage => ({ id: uid(), from: "assistant", kind: "text", text });
const me = (text: string): ChatMessage => ({ id: uid(), from: "customer", kind: "text", text });

// ---------------------------------------------------------------------------
// Portal
// ---------------------------------------------------------------------------

export default function Portal({
  token,
  firstName,
  onSessionExpired,
}: {
  token: string;
  firstName: string;
  onSessionExpired: () => void;
}) {
  const [account, setAccount] = useState<CustomerOrders | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [reason, setReason] = useState<RefundReason | null>(null);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    say(`Hi ${firstName}! I'm here to help with refunds. Choose the order you need help with.`),
  ]);

  const logRef = useRef<HTMLDivElement>(null);
  const chatRef = useRef<HTMLElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);

  const handleError = useCallback(
    (err: unknown): string => {
      if (err instanceof ApiError && err.status === 401) onSessionExpired();
      return err instanceof ApiError ? err.message : "Something went wrong. Please try again.";
    },
    [onSessionExpired],
  );

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setRefreshing(true);
      setLoadError(null);
      try {
        setAccount(await api.me(token, signal));
      } catch (err) {
        if (!signal?.aborted) setLoadError(handleError(err));
      } finally {
        if (!signal?.aborted) setRefreshing(false);
      }
    },
    [token, handleError],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, submitting]);

  const selected = account?.orders.find((o) => o.id === selectedId) ?? null;
  const canSend = Boolean(selected) && !submitting && (reason !== null || draft.trim() !== "");

  // --- actions --------------------------------------------------------------

  function selectOrder(order: Order) {
    if (submitting) return;
    const open = openRequest(order);
    if (open) {
      // Only one open request per order: explain instead of silently ignoring the click.
      setSelectedId(null);
      setReason(null);
      setMessages((m) => [
        ...m,
        me(`What's happening with my ${order.productName}?`),
        say(
          `Your refund request for the ${order.productName} is already with our team (reference #${open.id}, ` +
            `sent ${date(open.requestedAt)}). We'll email you as soon as there's an update, so there's nothing ` +
            "more you need to do. You can choose another order in the meantime.",
        ),
      ]);
      return;
    }
    setSelectedId(order.id);
    setReason(null);
    setDraft("");
    setMessages((m) => [
      ...m,
      me(`I need help with my ${order.productName}.`),
      say(
        `Sorry to hear that. What's wrong with your ${order.productName}? Pick the closest option, or describe it in your own words.`,
      ),
    ]);
    // On small screens the chat sits below the order list.
    if (window.matchMedia("(max-width: 1023px)").matches) {
      chatRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function chooseReason(r: RefundReason) {
    if (!selected || submitting) return;
    setReason(r);
    setMessages((m) => [
      ...m,
      me(reasonLabel(r)),
      say("Thanks. Anything else we should know? Add details if you like, then press Send. Details are optional."),
    ]);
    draftRef.current?.focus();
  }

  function cancelSelection() {
    setSelectedId(null);
    setReason(null);
    setDraft("");
    setMessages((m) => [...m, say("No problem. Choose another order whenever you're ready.")]);
  }

  async function submit(payload: NewRefundRequest, order: Order) {
    setSubmitting(true);
    try {
      const result = await api.submitRefundRequest(token, payload);
      setMessages((m) => [
        ...m,
        { id: uid(), from: "assistant", kind: "decision", result, order },
        say("Is there anything else I can help with? You can choose another order."),
      ]);
      setSelectedId(null);
      setReason(null);
      void load();
    } catch (err) {
      setMessages((m) => [
        ...m,
        { id: uid(), from: "assistant", kind: "error", text: handleError(err), retry: payload, order },
      ]);
    } finally {
      setSubmitting(false);
    }
  }

  function onSubmit(e?: FormEvent) {
    e?.preventDefault();
    if (!canSend || !selected) return;
    const text = draft.trim();
    const chosen = reason ?? "OTHER";
    if (text) setMessages((m) => [...m, me(text)]);
    setDraft("");
    void submit({ orderId: selected.id, reason: chosen, message: text || reasonLabel(chosen) }, selected);
  }

  function retry(msg: Extract<ChatMessage, { kind: "error" }>) {
    setMessages((m) => m.filter((x) => x.id !== msg.id));
    void submit(msg.retry, msg.order);
  }

  // --- render ---------------------------------------------------------------

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:py-10">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">Welcome back, {firstName}</h1>
        <p className="mt-1 text-slate-600">
          Choose an order to start a refund request, or check on one you&apos;ve already sent.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        {/* Orders */}
        <section aria-labelledby="orders-heading">
          <div className="mb-3 flex items-center justify-between">
            <h2 id="orders-heading" className="text-sm font-semibold text-slate-900">
              Your orders {account && <span className="font-normal text-slate-500">({account.orders.length})</span>}
            </h2>
            <button
              onClick={() => void load()}
              disabled={refreshing}
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-slate-500 hover:bg-white hover:text-slate-700 disabled:opacity-50"
              aria-label="Refresh orders"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} aria-hidden /> Refresh
            </button>
          </div>

          {loadError ? (
            <div role="alert" className="rounded-2xl bg-rose-50 p-4 text-sm text-rose-800 ring-1 ring-rose-200">
              <p>{loadError}</p>
              <button onClick={() => void load()} className="mt-2 font-semibold underline">
                Try again
              </button>
            </div>
          ) : !account ? (
            <ul className="space-y-3" aria-busy="true" aria-label="Loading your orders">
              {[0, 1, 2].map((i) => (
                <li key={i} className="h-[104px] animate-pulse rounded-2xl bg-white ring-1 ring-slate-200" />
              ))}
            </ul>
          ) : account.orders.length === 0 ? (
            <div className="rounded-2xl bg-white p-8 text-center ring-1 ring-slate-200">
              <Inbox className="mx-auto h-8 w-8 text-slate-300" aria-hidden />
              <p className="mt-2 text-sm text-slate-600">No orders yet.</p>
            </div>
          ) : (
            <ul className="space-y-3">
              {account.orders.map((order) => (
                <li key={order.id}>
                  <OrderCard
                    order={order}
                    selected={order.id === selectedId}
                    disabled={submitting}
                    onSelect={() => selectOrder(order)}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Chat */}
        <section
          ref={chatRef}
          aria-label="Refund assistant"
          className="flex min-h-[560px] flex-col overflow-hidden rounded-3xl bg-white shadow-xl shadow-slate-900/5 ring-1 ring-slate-200 lg:h-[calc(100vh-13rem)] lg:min-h-[600px]"
        >
          <header className="flex items-center gap-3 border-b border-slate-100 px-5 py-4">
            <span className="relative grid h-10 w-10 place-items-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-white">
              <Bot className="h-5 w-5" aria-hidden />
              <span className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full bg-emerald-400 ring-2 ring-white" />
            </span>
            <div>
              <p className="text-sm font-semibold text-slate-900">Refund assistant</p>
              <p className="text-xs text-slate-500">Answers most requests instantly · our team handles the rest</p>
            </div>
          </header>

          <div
            ref={logRef}
            role="log"
            aria-live="polite"
            aria-label="Conversation"
            className="flex-1 space-y-4 overflow-y-auto bg-slate-50/60 px-4 py-5 sm:px-6"
          >
            {messages.map((msg) => (
              <Bubble key={msg.id} message={msg} onRetry={retry} retryDisabled={submitting} />
            ))}
            {submitting && <Typing />}
          </div>

          {/* Composer */}
          <div className="border-t border-slate-100 bg-white p-4">
            {selected ? (
              <div className="mb-3 flex items-center justify-between gap-2 rounded-xl bg-indigo-50/70 px-3 py-2 text-xs ring-1 ring-inset ring-indigo-100">
                <span className="flex min-w-0 items-center gap-2 text-indigo-900">
                  <CategoryIcon category={selected.category} size="sm" />
                  <span className="truncate">
                    <span className="font-semibold">{selected.productName}</span> · {selected.orderNumber}
                    {reason && <span className="text-indigo-700"> · {reasonLabel(reason)}</span>}
                  </span>
                </span>
                <button
                  onClick={cancelSelection}
                  disabled={submitting}
                  className="inline-flex shrink-0 items-center gap-1 font-medium text-indigo-700 hover:text-indigo-900 disabled:opacity-50"
                >
                  <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Change
                </button>
              </div>
            ) : (
              <p className="mb-3 text-xs text-slate-500">Choose an order from your list to get started.</p>
            )}

            {selected && reason === null && !submitting && (
              <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="What's the problem?">
                {REASONS.map((r) => (
                  <button
                    key={r.value}
                    onClick={() => chooseReason(r.value)}
                    className="rounded-full bg-white px-3 py-1.5 text-xs font-medium text-slate-700 ring-1 ring-slate-200 transition hover:bg-indigo-50 hover:text-indigo-800 hover:ring-indigo-200"
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            )}

            <form onSubmit={onSubmit} className="flex items-end gap-2">
              <label className="flex-1">
                <span className="sr-only">Message</span>
                <textarea
                  ref={draftRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      onSubmit();
                    }
                  }}
                  maxLength={MAX_MESSAGE}
                  rows={2}
                  disabled={!selected || submitting}
                  placeholder={
                    !selected
                      ? "Choose an order first"
                      : reason
                        ? "Add details (optional), then press Send…"
                        : "Pick an option above, or describe the problem…"
                  }
                  className="block w-full resize-none rounded-xl border-0 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-900 ring-1 ring-inset ring-slate-200 placeholder:text-slate-400 focus:bg-white focus:ring-2 focus:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
                />
              </label>
              <button
                type="submit"
                disabled={!canSend}
                className="inline-flex h-11 items-center gap-1.5 rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 px-4 text-sm font-semibold text-white shadow-md shadow-indigo-600/25 transition hover:brightness-110 disabled:cursor-not-allowed disabled:from-slate-300 disabled:to-slate-300 disabled:shadow-none"
              >
                {submitting ? <Spinner /> : <SendHorizontal className="h-4 w-4" aria-hidden />}
                Send
              </button>
            </form>
          </div>
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function OrderCard({
  order,
  selected,
  disabled,
  onSelect,
}: {
  order: Order;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const badge = refundBadge(order);
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      className={`group w-full rounded-2xl bg-white p-4 text-left shadow-sm ring-1 transition ${
        selected
          ? "ring-2 ring-indigo-500 shadow-indigo-500/10"
          : "ring-slate-200 hover:-translate-y-0.5 hover:shadow-md hover:ring-slate-300"
      } disabled:translate-y-0 disabled:cursor-not-allowed disabled:shadow-none disabled:hover:ring-slate-200`}
    >
      <div className="flex gap-3">
        <CategoryIcon category={order.category} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="truncate font-medium text-slate-900">{order.productName}</p>
            <p className="shrink-0 text-sm font-semibold tabular-nums text-slate-900">{money(order.totalCents)}</p>
          </div>
          <p className="mt-0.5 flex items-center gap-1 text-xs text-slate-500">
            <Truck className="h-3.5 w-3.5" aria-hidden /> {deliveryLine(order)}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600">
              {order.orderNumber}
            </span>
            {order.isFinalSale && (
              <span className="inline-flex items-center gap-1 rounded-full bg-orange-50 px-2 py-0.5 text-orange-800 ring-1 ring-inset ring-orange-200">
                <Tag className="h-3 w-3" aria-hidden /> Final sale
              </span>
            )}
            {badge && <span className={`rounded-full px-2 py-0.5 ring-1 ring-inset ${badge.cls}`}>{badge.label}</span>}
          </div>
        </div>
      </div>
    </button>
  );
}

const DECISION = {
  APPROVED: {
    icon: CircleCheck,
    title: "Refund approved",
    ring: "ring-emerald-200",
    iconCls: "bg-emerald-100 text-emerald-600",
    bar: "from-emerald-400 to-teal-400",
  },
  DENIED: {
    icon: CircleX,
    title: "Not eligible for a refund",
    ring: "ring-rose-200",
    iconCls: "bg-rose-100 text-rose-600",
    bar: "from-rose-400 to-pink-400",
  },
  ESCALATED: {
    icon: Hourglass,
    title: "Sent to our support team",
    ring: "ring-amber-200",
    iconCls: "bg-amber-100 text-amber-600",
    bar: "from-amber-400 to-orange-400",
  },
  PENDING: {
    icon: Hourglass,
    title: "Request received",
    ring: "ring-amber-200",
    iconCls: "bg-amber-100 text-amber-600",
    bar: "from-amber-400 to-orange-400",
  },
} as const;

function Bubble({
  message,
  onRetry,
  retryDisabled,
}: {
  message: ChatMessage;
  onRetry: (m: Extract<ChatMessage, { kind: "error" }>) => void;
  retryDisabled: boolean;
}) {
  if (message.from === "customer") {
    return (
      <div className="flex justify-end">
        <p className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-gradient-to-br from-indigo-600 to-violet-600 px-4 py-2.5 text-sm text-white shadow-sm">
          {message.text}
        </p>
      </div>
    );
  }

  if (message.kind === "decision") {
    const { result, order } = message;
    const d = DECISION[result.status];
    const Icon = d.icon;
    return (
      <AssistantRow>
        <div className={`overflow-hidden rounded-2xl rounded-bl-md bg-white shadow-sm ring-1 ${d.ring}`}>
          <div className={`h-1 bg-gradient-to-r ${d.bar}`} />
          <div className="p-4">
            <div className="flex items-center gap-3">
              <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-full ${d.iconCls}`}>
                <Icon className="h-5 w-5" aria-hidden />
              </span>
              <div>
                <p className="font-semibold text-slate-900">{d.title}</p>
                <p className="text-xs text-slate-500">
                  {order.productName} · {money(result.amountCents)}
                </p>
              </div>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-slate-700">
              {result.customerMessage ?? "We've recorded your request."}
            </p>
            <p className="mt-3 text-xs text-slate-400">Reference #{result.id}</p>
          </div>
        </div>
      </AssistantRow>
    );
  }

  if (message.kind === "error") {
    return (
      <AssistantRow>
        <div
          role="alert"
          className="rounded-2xl rounded-bl-md bg-rose-50 px-4 py-3 text-sm text-rose-800 ring-1 ring-rose-200"
        >
          <p>{message.text}</p>
          <button
            onClick={() => onRetry(message)}
            disabled={retryDisabled}
            className="mt-2 inline-flex items-center gap-1 font-semibold underline disabled:opacity-50"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Try again
          </button>
        </div>
      </AssistantRow>
    );
  }

  return (
    <AssistantRow>
      <p className="rounded-2xl rounded-bl-md bg-white px-4 py-2.5 text-sm text-slate-800 shadow-sm ring-1 ring-slate-200">
        {message.text}
      </p>
    </AssistantRow>
  );
}

function AssistantRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-end gap-2.5">
      <span
        aria-hidden
        className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-white"
      >
        <Bot className="h-3.5 w-3.5" />
      </span>
      <div className="max-w-[85%]">{children}</div>
    </div>
  );
}

function Typing() {
  return (
    <AssistantRow>
      <div className="flex items-center gap-2.5 rounded-2xl rounded-bl-md bg-white px-4 py-3 text-sm text-slate-600 shadow-sm ring-1 ring-slate-200">
        <span className="flex gap-1" aria-hidden>
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-indigo-400 [animation-delay:-0.2s]" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-indigo-400 [animation-delay:-0.1s]" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-indigo-400" />
        </span>
        Checking your order against our refund policy…
      </div>
    </AssistantRow>
  );
}
