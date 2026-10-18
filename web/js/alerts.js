// Alert store. Syncs with the texting agent (agent/server.js) when it's reachable;
// otherwise alerts live in this browser so the map still works on its own.
import { fieldsWithin, centroid } from "./analysis.js";

const LS_KEY = "f4f.alerts.v1";
const AGENT_KEY = "f4f.agentUrl";

export class AlertStore extends EventTarget {
  constructor(fields) {
    super();
    this.fields = fields;
    this.alerts = load() ?? seed(fields);
    this.online = false;
    this.failures = 0;
    this.subscribers = [];
    this.agentUrl = readAgentUrl();
  }

  setAgentUrl(url) {
    this.agentUrl = url.replace(/\/+$/, "");
    try { localStorage.setItem(AGENT_KEY, this.agentUrl); } catch {}
    this.sync();
  }

  startSync(ms = 3000) {
    this.sync();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.sync(), ms);
  }

  async sync() {
    let state;
    try {
      const res = await fetch(`${this.agentUrl}/api/state`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) throw new Error(res.status);
      state = await res.json();
      this.failures = 0;
    } catch {
      // One slow poll shouldn't flip the UI to offline.
      if (++this.failures >= 2) this.#setOnline(false);
      return;
    }
    const known = new Set(this.alerts.map((a) => a.id));
    const incoming = state.alerts.filter((a) => !known.has(a.id));
    // Server is the source of truth for anything it knows about; keep local-only alerts.
    const byId = new Map(this.alerts.map((a) => [a.id, a]));
    for (const a of state.alerts) byId.set(a.id, a);
    this.alerts = [...byId.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    this.subscribers = state.subscribers || [];
    this.#setOnline(true, state.channel);
    this.#save();
    for (const a of incoming) this.dispatchEvent(new CustomEvent("new", { detail: a }));
    if (incoming.length) this.dispatchEvent(new Event("change"));
  }

  async create({ type, note, radiusMi, field, reporter, source = "web" }) {
    const draft = {
      type, note, radiusMi, source,
      fieldId: field.properties.id,
      reporterId: reporter.id, reporterName: reporter.name,
      center: centroid(field),
    };
    let alert;
    {
      try {
        const res = await fetch(`${this.agentUrl}/api/alerts`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft),
          signal: AbortSignal.timeout(this.online ? 15000 : 3000),
        });
        if (!res.ok) throw new Error(await res.text());
        alert = await res.json();
        this.#setOnline(true, this.channel);
      } catch (e) {
        console.warn("Agent rejected alert, keeping it local", e);
      }
    }
    if (!alert) alert = localAlert(draft, this.fields);
    this.alerts = [alert, ...this.alerts.filter((a) => a.id !== alert.id)];
    this.#save();
    this.dispatchEvent(new Event("change"));
    return alert;
  }

  async resolve(id) {
    const a = this.alerts.find((x) => x.id === id);
    if (!a) return;
    a.resolved = true;
    if (this.online) fetch(`${this.agentUrl}/api/alerts/${id}/resolve`, { method: "POST" }).catch(() => {});
    this.#save();
    this.dispatchEvent(new Event("change"));
  }

  #setOnline(on, channel) {
    if (on === this.online && channel === this.channel) return;
    this.online = on;
    this.channel = channel;
    this.dispatchEvent(new Event("online"));
  }

  #save() { try { localStorage.setItem(LS_KEY, JSON.stringify(this.alerts)); } catch {} }
}

function localAlert(draft, fields) {
  const reached = fieldsWithin(fields, draft.center, draft.radiusMi)
    .filter(({ f }) => f.properties.farmerId !== draft.reporterId);
  const seen = new Set();
  const notified = [];
  for (const { f } of reached) {
    if (seen.has(f.properties.farmerId)) continue;
    seen.add(f.properties.farmerId);
    notified.push({ farmerId: f.properties.farmerId, name: f.properties.farmer, channel: "app", status: "delivered" });
  }
  return { ...draft, id: `A${Date.now().toString(36)}`, createdAt: new Date().toISOString(), notified };
}

function readAgentUrl() {
  const q = new URLSearchParams(location.search).get("agent");
  if (q) { try { localStorage.setItem(AGENT_KEY, q); } catch {} return q.replace(/\/+$/, ""); }
  try { const s = localStorage.getItem(AGENT_KEY); if (s) return s; } catch {}
  return "http://localhost:8787";
}

function load() {
  try { const s = localStorage.getItem(LS_KEY); return s ? JSON.parse(s) : null; } catch { return null; }
}

// One example alert so a first-time visitor sees how the community feed works.
function seed(fields) {
  const f = fields.find((x) => x.properties.id === "F29") || fields[0];
  return [{
    id: "A-demo-1", type: "pest", radiusMi: 1.5, source: "sms", demo: true,
    note: "Japanese beetles on the silks along the south fence line",
    fieldId: f.properties.id, reporterId: f.properties.farmerId, reporterName: f.properties.farmer,
    center: centroid(f), createdAt: new Date(Date.now() - 2 * 864e5).toISOString(),
    notified: [],
  }];
}
