"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import {
  ApiError,
  api,
  type Customer,
  type CustomerOrders,
  type NewRefundRequest,
  type Order,
  type RefundReason,
  type RefundResult,
} from "@/lib/api";
import { date, money } from "@/lib/format";

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

const REASONS: { value: RefundReason; label: string }[] = [
  { value: "OTHER", label: "Something else" },
  { value: "DEFECTIVE", label: "It's defective or stopped working" },
  { value: "DAMAGED_IN_TRANSIT", label: "It arrived damaged" },
  { value: "WRONG_ITEM", label: "I received the wrong item" },
  { value: "NOT_AS_DESCRIBED", label: "It's not as described" },
  { value: "LATE_DELIVERY", label: "It hasn't arrived or arrived late" },
  { value: "CHANGED_MIND", label: "I changed my mind" },
  { value: "NO_LONGER_NEEDED", label: "I no longer need it" },
];
const reasonLabel = (r: RefundReason) => REASONS.find((x) => x.value === r)?.label ?? r;


const MAX_MESSAGE = 4000;

/** An order with an open request can't take another one (the API returns 409). */
const openRequest = (order: Order) =>
  order.refundRequests.find((r) => r.status === "PENDING" || r.status === "ESCALATED");

const DECISION_STYLE = {
  APPROVED: { label: "Approved", badge: "bg-emerald-100 text-emerald-800", ring: "border-emerald-200" },
  DENIED: { label: "Not eligible", badge: "bg-rose-100 text-rose-800", ring: "border-rose-200" },
  ESCALATED: { label: "Under review", badge: "bg-amber-100 text-amber-800", ring: "border-amber-200" },
  PENDING: { label: "Under review", badge: "bg-amber-100 text-amber-800", ring: "border-amber-200" },
} as const;

// ---------------------------------------------------------------------------
// Chat model
// ---------------------------------------------------------------------------

type ChatMessage =
  | { id: string; role: "assistant"; kind: "text"; text: string }
  | { id: string; role: "customer"; kind: "text"; text: string; reason: RefundReason; orderLabel: string }
  | { id: string; role: "assistant"; kind: "decision"; result: RefundResult }
  | { id: string; role: "assistant"; kind: "error"; text: string; retry: NewRefundRequest };

let nextId = 0;
const uid = () => `m${++nextId}`;
const say = (text: string): ChatMessage => ({ id: uid(), role: "assistant", kind: "text", text });

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function SupportChat() {
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [customersError, setCustomersError] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState<number | null>(null);

  const [account, setAccount] = useState<CustomerOrders | null>(null);
  const [ordersError, setOrdersError] = useState<string | null>(null);
  const [ordersLoading, setOrdersLoading] = useState(false);

  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null);
  const [reason, setReason] = useState<RefundReason>("OTHER");
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const logRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);

  // --- data loading --------------------------------------------------------

  const loadCustomers = useCallback((signal?: AbortSignal) => {
    setCustomersError(null);
    setCustomers(null);
    api
      .listCustomers(signal)
      .then(setCustomers)
      .catch((err) => {
        if (!signal?.aborted) setCustomersError(errorText(err));
      });
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    loadCustomers(ctrl.signal);
    return () => ctrl.abort();
  }, [loadCustomers]);

  const loadOrders = useCallback(async (id: number, signal?: AbortSignal) => {
    setOrdersLoading(true);
    setOrdersError(null);
    try {
      setAccount(await api.customerOrders(id, signal));
    } catch (err) {
      if (!signal?.aborted) setOrdersError(errorText(err));
    } finally {
      if (!signal?.aborted) setOrdersLoading(false);
    }
  }, []);

  useEffect(() => {
    if (customerId === null) return;
    const ctrl = new AbortController();
    void loadOrders(customerId, ctrl.signal);
    return () => ctrl.abort();
  }, [customerId, loadOrders]);

  // Keep the newest message in view.
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, submitting]);

  // --- actions --------------------------------------------------------------

  function signIn(id: number | null) {
    setCustomerId(id);
    setAccount(null);
    setSelectedOrderId(null);
    setDraft("");
    setReason("OTHER");
    const customer = customers?.find((c) => c.id === id);
    setMessages(
      customer
        ? [say(`Hi ${customer.name.split(" ")[0]}! Which order do you need help with? Pick one from your orders.`)]
        : [],
    );
  }

  function selectOrder(order: Order) {
    if (submitting || openRequest(order)) return;
    setSelectedOrderId(order.id);
    setMessages((m) => [
      ...m,
      say(`Got it: ${order.productName} (${order.orderNumber}). What went wrong? Tell us in your own words.`),
    ]);
    draftRef.current?.focus();
  }

  async function send(payload: NewRefundRequest) {
    setSubmitting(true);
    try {
      const result = await api.submitRefundRequest(payload);
      setMessages((m) => [
        ...m,
        { id: uid(), role: "assistant", kind: "decision", result },
        say("Is there anything else I can help with? You can pick another order."),
      ]);
      setSelectedOrderId(null);
      setReason("OTHER");
      void loadOrders(payload.customerId); // statuses may have changed
    } catch (err) {
      setMessages((m) => [...m, { id: uid(), role: "assistant", kind: "error", text: errorText(err), retry: payload }]);
    } finally {
      setSubmitting(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const message = draft.trim();
    const order = account?.orders.find((o) => o.id === selectedOrderId);
    if (!message || !order || customerId === null || submitting) return;

    setMessages((m) => [
      ...m,
      { id: uid(), role: "customer", kind: "text", text: message, reason, orderLabel: `${order.productName} · ${order.orderNumber}` },
    ]);
    setDraft("");
    void send({ customerId, orderId: order.id, message, reason });
  }

  function retry(msg: Extract<ChatMessage, { kind: "error" }>) {
    setMessages((m) => m.filter((x) => x.id !== msg.id));
    void send(msg.retry);
  }

  const selectedOrder = account?.orders.find((o) => o.id === selectedOrderId) ?? null;

  // --- render ---------------------------------------------------------------

  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col px-4 py-6 sm:py-10">
      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Refund support</h1>
          <p className="text-sm text-slate-600">Get help with a refund for one of your orders.</p>
        </div>
        <CustomerPicker
          customers={customers}
          error={customersError}
          value={customerId}
          disabled={submitting}
          onChange={signIn}
          onRetry={() => loadCustomers()}
        />
      </header>

      {customerId === null ? (
        <div className="flex flex-1 items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center">
          <div>
            <p className="font-medium">Sign in to get started</p>
            <p className="mt-1 text-sm text-slate-600">
              Choose a customer account above. This demo has no passwords.
            </p>
          </div>
        </div>
      ) : (
        <div className="grid flex-1 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <OrderList
            account={account}
            loading={ordersLoading}
            error={ordersError}
            selectedOrderId={selectedOrderId}
            disabled={submitting}
            onSelect={selectOrder}
            onRetry={() => void loadOrders(customerId)}
          />

          <section className="flex min-h-[32rem] flex-col rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div
              ref={logRef}
              role="log"
              aria-live="polite"
              aria-label="Conversation"
              className="flex-1 space-y-3 overflow-y-auto p-4 sm:p-5"
            >
              {messages.map((msg) => (
                <Bubble key={msg.id} message={msg} onRetry={retry} retryDisabled={submitting} />
              ))}
              {submitting && <TypingBubble />}
            </div>

            <form onSubmit={onSubmit} className="space-y-3 border-t border-slate-200 p-4">
              {selectedOrder ? (
                <p className="text-xs text-slate-500">
                  About: <span className="font-medium text-slate-700">{selectedOrder.productName}</span> ·{" "}
                  {selectedOrder.orderNumber}
                </p>
              ) : (
                <p className="text-xs text-slate-500">Select an order to start a refund request.</p>
              )}
              <label className="block">
                <span className="sr-only">Reason</span>
                <select
                  value={reason}
                  onChange={(e) => setReason(e.target.value as RefundReason)}
                  disabled={!selectedOrder || submitting}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm disabled:bg-slate-100 disabled:text-slate-400"
                >
                  {REASONS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex items-end gap-2">
                <label className="flex-1">
                  <span className="sr-only">Message</span>
                  <textarea
                    ref={draftRef}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        e.currentTarget.form?.requestSubmit();
                      }
                    }}
                    maxLength={MAX_MESSAGE}
                    rows={2}
                    disabled={!selectedOrder || submitting}
                    placeholder={selectedOrder ? "Describe the problem…" : "Select an order first"}
                    className="w-full resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-100"
                  />
                </label>
                <button
                  type="submit"
                  disabled={!selectedOrder || submitting || draft.trim() === ""}
                  className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  {submitting ? "Sending…" : "Send"}
                </button>
              </div>
              {draft.length > MAX_MESSAGE - 200 && (
                <p className="text-right text-xs text-slate-500">
                  {draft.length}/{MAX_MESSAGE}
                </p>
              )}
            </form>
          </section>
        </div>
      )}
    </div>
  );
}

function errorText(err: unknown): string {
  return err instanceof ApiError ? err.message : "Something went wrong. Please try again.";
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function CustomerPicker(props: {
  customers: Customer[] | null;
  error: string | null;
  value: number | null;
  disabled: boolean;
  onChange: (id: number | null) => void;
  onRetry: () => void;
}) {
  if (props.error) {
    return (
      <div role="alert" className="flex items-center gap-3 text-sm text-rose-700">
        {props.error}
        <button onClick={props.onRetry} className="rounded-md border border-rose-300 px-2 py-1 hover:bg-rose-50">
          Retry
        </button>
      </div>
    );
  }
  return (
    <label className="flex flex-col gap-1 text-sm sm:items-end">
      <span className="text-slate-600">Signed in as</span>
      <select
        value={props.value ?? ""}
        onChange={(e) => props.onChange(e.target.value ? Number(e.target.value) : null)}
        disabled={props.customers === null || props.disabled}
        className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 sm:w-72"
      >
        <option value="">{props.customers === null ? "Loading customers…" : "Choose a customer…"}</option>
        {props.customers?.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name} ({c.email})
          </option>
        ))}
      </select>
    </label>
  );
}

function OrderList(props: {
  account: CustomerOrders | null;
  loading: boolean;
  error: string | null;
  selectedOrderId: number | null;
  disabled: boolean;
  onSelect: (order: Order) => void;
  onRetry: () => void;
}) {
  const { account, loading, error } = props;
  return (
    <section aria-labelledby="orders-heading" className="flex flex-col">
      <h2 id="orders-heading" className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
        Your orders {loading && account && <span className="font-normal normal-case">· refreshing…</span>}
      </h2>

      {error ? (
        <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          <p>{error}</p>
          <button onClick={props.onRetry} className="mt-2 font-medium underline">
            Try again
          </button>
        </div>
      ) : !account ? (
        <ul className="space-y-2" aria-busy="true" aria-label="Loading orders">
          {[0, 1, 2].map((i) => (
            <li key={i} className="h-20 animate-pulse rounded-xl bg-slate-200/70" />
          ))}
        </ul>
      ) : account.orders.length === 0 ? (
        <p className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600">No orders yet.</p>
      ) : (
        <ul className="space-y-2">
          {account.orders.map((order) => {
            const open = openRequest(order);
            const selected = order.id === props.selectedOrderId;
            return (
              <li key={order.id}>
                <button
                  type="button"
                  onClick={() => props.onSelect(order)}
                  disabled={props.disabled || Boolean(open)}
                  aria-pressed={selected}
                  className={`w-full rounded-xl border bg-white p-3 text-left text-sm shadow-sm transition ${
                    selected ? "border-indigo-500 ring-2 ring-indigo-200" : "border-slate-200 hover:border-slate-300"
                  } disabled:cursor-not-allowed disabled:opacity-60`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-medium">{order.productName}</span>
                    <span className="shrink-0 tabular-nums">{money(order.totalCents)}</span>
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    {order.orderNumber} · ordered {date(order.orderedAt)}
                    {order.deliveredAt ? ` · delivered ${date(order.deliveredAt)}` : ""}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
                    <Tag>{order.status.toLowerCase()}</Tag>
                    {order.isFinalSale && <Tag tone="warn">final sale</Tag>}
                    {open && <Tag tone="info">refund request in progress</Tag>}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Tag({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "warn" | "info" }) {
  const cls = {
    neutral: "bg-slate-100 text-slate-700",
    warn: "bg-orange-100 text-orange-800",
    info: "bg-sky-100 text-sky-800",
  }[tone];
  return <span className={`rounded-full px-2 py-0.5 ${cls}`}>{children}</span>;
}

function Bubble({
  message,
  onRetry,
  retryDisabled,
}: {
  message: ChatMessage;
  onRetry: (m: Extract<ChatMessage, { kind: "error" }>) => void;
  retryDisabled: boolean;
}) {
  if (message.role === "customer") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-indigo-600 px-4 py-2.5 text-sm text-white">
          <p className="whitespace-pre-wrap break-words">{message.text}</p>
          <p className="mt-1 text-xs text-indigo-200">
            {reasonLabel(message.reason)} · {message.orderLabel}
          </p>
        </div>
      </div>
    );
  }

  if (message.kind === "decision") {
    const { result } = message;
    const style = DECISION_STYLE[result.status];
    return (
      <AssistantRow>
        <div className={`rounded-2xl rounded-bl-sm border bg-white px-4 py-3 text-sm ${style.ring}`}>
          <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${style.badge}`}>
            {style.label}
          </span>
          <p className="mt-2">{result.customerMessage ?? "Your request has been recorded."}</p>
          <p className="mt-2 text-xs text-slate-500">Reference #{result.id}</p>
        </div>
      </AssistantRow>
    );
  }

  if (message.kind === "error") {
    return (
      <AssistantRow>
        <div role="alert" className="rounded-2xl rounded-bl-sm border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          <p>{message.text}</p>
          <button
            onClick={() => onRetry(message)}
            disabled={retryDisabled}
            className="mt-2 font-medium underline disabled:opacity-50"
          >
            Try again
          </button>
        </div>
      </AssistantRow>
    );
  }

  return (
    <AssistantRow>
      <div className="rounded-2xl rounded-bl-sm bg-slate-100 px-4 py-2.5 text-sm">{message.text}</div>
    </AssistantRow>
  );
}

function AssistantRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-end gap-2">
      <div aria-hidden className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-indigo-100 text-xs font-semibold text-indigo-700">
        S
      </div>
      <div className="max-w-[85%]">{children}</div>
    </div>
  );
}

function TypingBubble() {
  return (
    <AssistantRow>
      <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm bg-slate-100 px-4 py-2.5 text-sm text-slate-600">
        <span className="flex gap-1" aria-hidden>
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:-0.2s]" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:-0.1s]" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400" />
        </span>
        Reviewing your request…
      </div>
    </AssistantRow>
  );
}
