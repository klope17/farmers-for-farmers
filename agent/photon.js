// Photon 2.0 (beta) channel adapter, plus a local simulator with the same interface.
//
// Beta rule that shapes the product: a shared iMessage line can't send the first
// message. Farmers opt in by texting the agent ("JOIN F05"); we keep that
// conversation's space id and post alerts back into it later.
import { Photon } from "@photon-ai/api";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createChannel({ onInbound, log = console.log }) {
  const projectId = process.env.PHOTON_PROJECT_ID;
  const apiKey = process.env.PHOTON_API_KEY || process.env.PHOTON_PROJECT_API_KEY || process.env.PHOTON_PROJECT_SECRET;
  if (!projectId || !apiKey) return new SimChannel({ onInbound, log });
  // Photon 2.0 beta project ids start with pho_prj_; anything else is a stable Spectrum project.
  return projectId.startsWith("pho_prj_")
    ? new PhotonChannel({ projectId, apiKey, onInbound, log })
    : new SpectrumChannel({ projectId, projectSecret: apiKey, onInbound, log });
}

// Photon stable (spectrum-ts). Proactive DMs are allowed to numbers registered
// under Users in the dashboard (Free/Pro shared pool).
class SpectrumChannel {
  name = "photon";

  constructor({ projectId, projectSecret, onInbound, log }) {
    Object.assign(this, { projectId, projectSecret, onInbound, log });
    this.spaces = new Map(); // phone -> space, so replies land in the same conversation
  }

  async start() {
    const { Spectrum } = await import("spectrum-ts");
    const { imessage } = await import("spectrum-ts/providers/imessage");
    this.app = await Spectrum({ projectId: this.projectId, projectSecret: this.projectSecret, providers: [imessage.config()] });
    this.im = imessage(this.app);
    this.log("[photon] connected (spectrum-ts, iMessage)");
    (async () => {
      for await (const [space, message] of this.app.messages) {
        if (message.direction === "outbound" || message.content?.type !== "text") continue;
        const from = message.sender?.id;
        if (!from) continue;
        this.spaces.set(from, space);
        await this.onInbound({ from, text: message.content.text, thread: { phone: from } }).catch((e) => this.log("[agent] handler error", e));
      }
    })().catch((e) => this.log(`[photon] message stream ended: ${e.message}`));
  }

  async send(thread, text) {
    const phone = thread.phone;
    let space = this.spaces.get(phone);
    if (!space) {
      space = await this.im.space.create(await this.im.user(phone));
      this.spaces.set(phone, space);
    }
    await space.send(text);
  }
}

class PhotonChannel {
  name = "photon";

  constructor({ projectId, apiKey, onInbound, log }) {
    this.projectId = projectId;
    this.onInbound = onInbound;
    this.log = log;
    this.photon = new Photon({ headers: { Authorization: `Bearer ${apiKey}` } });
    this.seen = new Set();
    this.since = new Date().toISOString();
    this.loggedShape = false;
  }

  async start() {
    try {
      const project = unwrap(await this.photon.projects.get({ path: { projectId: this.projectId } }));
      this.log(`[photon] connected to project "${project?.name ?? this.projectId}"`);
    } catch (e) {
      this.log(`[photon] could not load project: ${e.message}`);
    }
    this.#poll();
  }

  // Polls received iMessages every 2 s (the documented listMessages flow).
  async #poll() {
    let backoff = 2000;
    for (;;) {
      try {
        let pageToken;
        do {
          const res = unwrap(await this.photon.projects.listMessages({
            path: { id: this.projectId },
            query: { createdSince: this.since, direction: "received", order: "asc", pageSize: 100, platform: "imessage", ...(pageToken ? { pageToken } : {}) },
          }));
          const list = res?.items ?? [];
          for (const m of list) {
            if (!m?.id || this.seen.has(m.id)) continue;
            this.seen.add(m.id);
            if (!this.loggedShape) { this.loggedShape = true; this.log("[photon] first inbound message shape:", JSON.stringify(m).slice(0, 600)); }
            if (m.createdAt && m.createdAt > this.since) this.since = m.createdAt;
            if (m.content?.type !== "text") continue; // skip read receipts, typing, attachments
            const text = m.content.text ?? "";
            const from = m.sentBy?.handle ?? phoneOf(m) ?? m.space?.id;
            // Replies go out from the agent user that received the message, into the same Space.
            const thread = { spaceId: m.space?.id, senderId: m.receivedBy?.id, lastMessageId: m.id };
            await this.onInbound({ from, text, thread }).catch((e) => this.log("[agent] handler error", e));
          }
          pageToken = res?.nextPageToken;
        } while (pageToken);
        backoff = 2000;
      } catch (e) {
        const retry = Number(e?.response?.headers?.get?.("retry-after")) * 1000;
        backoff = Math.min(30000, retry || backoff * 2);
        this.log(`[photon] poll failed (${e.message}); retrying in ${backoff / 1000}s`);
      }
      await sleep(backoff);
    }
  }

  async send(thread, text) {
    if (!thread?.spaceId || !thread?.senderId) throw new Error("No open conversation with this farmer yet");
    unwrap(await this.photon.projects.sendMessage({
      path: { id: this.projectId },
      headers: { "idempotency-key": `f4f:${thread.spaceId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}` },
      // Plain message into the Space. Threaded replies (parentMessageId) are rejected on
      // some conversations ("Replies are not supported for this Space"), e.g. RCS transport.
      body: { spaceId: thread.spaceId, senderId: thread.senderId, content: { type: "text", format: "plain", text } },
    }));
  }
}

// Same interface, no network: inbound via POST /api/sim/inbound, outbound kept in memory
// for web/phone.html to display. Always available, even when Photon is configured.
export class SimChannel {
  name = "simulator";
  constructor({ onInbound, log }) { this.onInbound = onInbound; this.log = log; this.outbox = []; }
  async start() { this.log("[sim] no Photon credentials; running the phone simulator at /phone.html"); }
  async send(thread, text) {
    this.outbox.push({ id: this.outbox.length + 1, to: thread.phone, text, at: new Date().toISOString() });
    this.log(`[sim] → ${thread.phone}: ${text.replace(/\n/g, " ⏎ ")}`);
  }
}

function unwrap(res) {
  if (res && typeof res === "object" && "error" in res && res.error) {
    throw new Error(typeof res.error === "string" ? res.error : JSON.stringify(res.error));
  }
  return res && typeof res === "object" && "data" in res && "response" in res ? res.data : res;
}

function phoneOf(m) {
  const cand = [m.sender, m.sentBy, m.from, m.author, m.participant].filter(Boolean);
  for (const c of cand) {
    const s = typeof c === "string" ? c : JSON.stringify(c);
    const hit = s.match(/\+\d{10,15}/);
    if (hit) return hit[0];
  }
  return null;
}
