import { deriveLedger, makeEvent, parseEventLog } from "./domain.js";

const SESSION_KEY = "the-black-ledger.session.v1";
const TOKEN_KEY = "the-black-ledger.access.v1";
const LEGACY_KEY = "the-black-ledger.events.v1";
const api = (sessionId = "") => `/api/sessions${sessionId ? `/${encodeURIComponent(sessionId)}` : ""}`;
const updates = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("the-black-ledger-sync-v1");
let appendWarnings = [];
let accessContext = { role: "organizer", memberId: null };

async function request(path, options) {
  const accessToken = localStorage.getItem(TOKEN_KEY);
  const response = await fetch(path, { ...options, headers: { ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}), ...(options?.body ? { "content-type": "application/json" } : {}), ...(options?.headers ?? {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Ledger request failed (${response.status}).`);
  return body;
}

export async function loadLedger() {
  const invite = /^#join\/([a-zA-Z0-9_-]{1,100})\/([A-Za-z0-9_-]{32,100})$/.exec(location.hash);
  if (invite) {
    localStorage.setItem(SESSION_KEY, invite[1]);
    localStorage.setItem(TOKEN_KEY, invite[2]);
    history.replaceState(null, "", `${location.pathname}${location.search}#home`);
  }
  let sessionId = localStorage.getItem(SESSION_KEY);
  if (sessionId) {
    try {
      const response = await request(api(sessionId));
      accessContext = response.access ?? { role: "organizer", memberId: null };
      return parseEventLog(response.events);
    }
    catch (error) {
      const message = String(error.message);
      const missingSession = message.includes("Session not found");
      const tokenlessLegacySession = message.includes("valid session access token") && localStorage.getItem(TOKEN_KEY) === null;
      if (!missingSession && !tokenlessLegacySession) throw error;
      localStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(TOKEN_KEY);
      sessionId = null;
    }
  }
  const oldRaw = localStorage.getItem(LEGACY_KEY);
  const legacy = oldRaw === null ? [] : parseEventLog(JSON.parse(oldRaw));
  const created = await request(api(), { method: "POST", body: JSON.stringify({ name: "The Black Ledger", baseCurrency: "USD" }) });
  localStorage.setItem(SESSION_KEY, created.sessionId);
  localStorage.setItem(TOKEN_KEY, created.accessToken);
  accessContext = { role: "organizer", memberId: null };
  let events = [created.event];
  for (const event of legacy) {
    const result = await request(`${api(created.sessionId)}/events`, { method: "POST", headers: { "Idempotency-Key": `migration-${event.id}` }, body: JSON.stringify({ event }) });
    events.push(result.event);
  }
  return parseEventLog(events);
}

export function getAccessContext() { return { ...accessContext }; }

export async function appendEvent(currentEvents, type, fields) {
  const sessionId = localStorage.getItem(SESSION_KEY);
  if (!sessionId) throw new Error("This ledger has not finished connecting to shared storage.");
  const current = deriveLedger(currentEvents);
  if (current.archived) throw new Error("This journey is archived and read-only.");
  const event = makeEvent(type, fields);
  const candidate = [...currentEvents, event];
  deriveLedger(candidate);
  const result = await request(`${api(sessionId)}/events`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ event }) });
  appendWarnings = result.possibleDuplicates ?? [];
  updates?.postMessage({ sessionId, eventId: result.event.id });
  return parseEventLog([...(currentEvents.filter((item) => item.id !== event.id)), result.event]);
}

export function takeAppendWarnings() {
  const warnings = appendWarnings;
  appendWarnings = [];
  return warnings;
}

export async function exportLedger() {
  const sessionId = localStorage.getItem(SESSION_KEY);
  if (!sessionId) throw new Error("This ledger has not finished connecting to shared storage.");
  const bundle = await request(`${api(sessionId)}/export`);
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `black-ledger-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
