// Farmers for Farmers texting agent.
//  - Farmers opt in by texting "JOIN F05" (their field code) to the Photon number.
//  - Reports from the map (POST /api/alerts) or by text ("REPORT aphids on the east edge")
//    are broadcast to every opted-in farmer whose fields fall inside the alert radius.
//  - STATUS replies with the farmer's own Sentinel-2 field health, same analysis as the map.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createChannel, SimChannel } from "./photon.js";
import { SCENES, ALERT_TYPES, INDICES } from "../web/js/config.js";
import { assess, centroid, fieldsWithin, miles, valueAt, activeAlerts } from "../web/js/analysis.js";
import { askClaude } from "./brain.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(ROOT, "..", "web");
const STATE_FILE = path.join(ROOT, "state.json");
const PORT = Number(process.env.PORT || 8787);
const STATUS_SCENE = 4; // last in-season pass (Aug 20); the Oct 2 scene is mid-harvest
const DEFAULT_RADIUS = 2;

const fields = JSON.parse(fs.readFileSync(path.join(WEB, "data", "farms.geojson"), "utf8")).features;
const byId = new Map(fields.map((f) => [f.properties.id, f]));

/* ---------------------------------------------------------------- state */
const state = loadState();
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return { alerts: [], subscribers: {} }; }
}
function save() { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
const channel = createChannel({ onInbound: handleInbound, log });
const sim = channel instanceof SimChannel ? channel : new SimChannel({ onInbound: handleInbound, log });

/* ---------------------------------------------------------------- inbound texts */
async function handleInbound({ from, text, thread, via = channel }) {
  text = (text || "").trim();
  if (!from || !text) return [];
  log(`[in] ${from}: ${text}`);
  const sub = state.subscribers[from];
  const replies = [];
  const reply = async (msg) => {
    replies.push(msg);
    try {
      await via.send({ ...thread, phone: from }, msg);
      log(`[out] → ${from}: ${msg.slice(0, 60).replace(/\n/g, " ")}${msg.length > 60 ? "…" : ""}`);
    } catch (e) {
      log(`[out] failed: ${e.message}`);
    }
  };
  if (sub && thread?.spaceId) Object.assign(sub, { spaceId: thread.spaceId, senderId: thread.senderId });
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(" ");

  switch (cmd.toUpperCase()) {
    case "JOIN":
    case "START": {
      const codes = (arg.toUpperCase().match(/F\d{1,2}/g) || []).map((c) => `F${c.slice(1).padStart(2, "0")}`).filter((c) => byId.has(c));
      if (!codes.length) {
        await reply("Welcome to Farmers for Farmers 🌱 Text JOIN plus your field code from the map (e.g. JOIN F05) and I'll watch your fields and warn you when a neighbor reports trouble.");
        break;
      }
      const owner = byId.get(codes[0]).properties;
      const ownFields = fields.filter((f) => f.properties.farmerId === owner.farmerId).map((f) => f.properties.id);
      state.subscribers[from] = { phone: from, farmerId: owner.farmerId, name: owner.farmer, fieldIds: ownFields, channel: via.name, joinedAt: new Date().toISOString(), ...(thread?.spaceId ? { spaceId: thread.spaceId, senderId: thread.senderId } : {}) };
      save();
      await reply(`You're in, ${owner.farmer.split(/[ &]/)[0]}! Watching ${ownFields.length} field${ownFields.length > 1 ? "s" : ""} (${ownFields.join(", ")}).\n\n${statusText(state.subscribers[from])}\n\nText REPORT + what you see to warn neighbors, STATUS anytime, STOP to opt out.`);
      break;
    }
    case "STOP":
    case "UNSUBSCRIBE":
      delete state.subscribers[from]; save();
      await reply("You've been unsubscribed from Farmers for Farmers alerts. Text JOIN anytime to come back.");
      break;
    case "STATUS":
      await reply(sub ? statusText(sub) : notJoined());
      break;
    case "ALERTS":
      await reply(sub ? alertsText(sub) : notJoined());
      break;
    case "REPORT": {
      if (!sub) { await reply(notJoined()); break; }
      const named = (arg.toUpperCase().match(/\bF(\d{1,2})\b/) || [])[1];
      const fieldId = named && sub.fieldIds.includes(`F${named.padStart(2, "0")}`) ? `F${named.padStart(2, "0")}` : sub.fieldIds[0];
      const note = arg.replace(/\bF\d{1,2}\b\s*/i, "").trim();
      const alert = await createAlert({ type: classify(note), note, radiusMi: DEFAULT_RADIUS, fieldId, reporterId: sub.farmerId, reporterName: sub.name, source: "sms" });
      await reply(`Thanks. I've warned ${alert.notified.length} neighboring farm${alert.notified.length === 1 ? "" : "s"} within ${DEFAULT_RADIUS} mi about ${ALERT_TYPES[alert.type].verb} near ${alert.fieldId}. It's on the community map now.`);
      break;
    }
    case "HELP":
    case "?":
      await reply("Farmers for Farmers commands:\nSTATUS: your field health\nALERTS: reports near you\nREPORT <what you see>: warn neighbors\nSTOP: opt out\nOr just ask me a question.");
      break;
    default: {
      if (!sub) { await reply(notJoined()); break; }
      const answer = await askClaude({ text, sub, context: contextFor(sub), report: (type, note) => createAlert({ type, note, radiusMi: DEFAULT_RADIUS, fieldId: sub.fieldIds[0], reporterId: sub.farmerId, reporterName: sub.name, source: "sms" }) });
      await reply(answer ?? "I didn't catch that. Text HELP for commands, or REPORT + what you're seeing to warn your neighbors.");
    }
  }
  save();
  return replies;
}

const notJoined = () => "Text JOIN plus your field code from the Farmers for Farmers map (e.g. JOIN F05) to get started.";

function classify(t) {
  t = t.toLowerCase();
  if (/(dry|drought|wilt|irrigat|no rain)/.test(t)) return "drought";
  if (/(nitrogen|yellow|chlorosis|iron|potash|deficien)/.test(t)) return "nutrient";
  if (/(flood|ponding|standing water|washout)/.test(t)) return "flood";
  if (/(rust|blight|mold|mildew|rot|spot|disease|fungus|tar spot)/.test(t)) return "disease";
  return "pest";
}

function statusText(sub) {
  const s = SCENES[STATUS_SCENE];
  const lines = sub.fieldIds.map((id) => {
    const f = byId.get(id);
    const a = assess(fields, f, STATUS_SCENE, { alerts: state.alerts });
    const ndvi = valueAt(f, STATUS_SCENE, "ndvi");
    const top = a.insights[0];
    return `${id} ${f.properties.crop}: ${a.headline}. NDVI ${ndvi?.toFixed(2)}${top && top.level !== "ok" ? `. ${top.title}` : ""}`;
  });
  return `Field health (Sentinel-2, ${s.label}):\n${lines.join("\n")}`;
}

function alertsText(sub) {
  const near = activeAlerts(state.alerts).filter((a) => a.reporterId !== sub.farmerId).map((a) => ({
    a, d: Math.min(...sub.fieldIds.map((id) => miles(centroid(byId.get(id)), a.center))),
  })).filter(({ a, d }) => d - 0.35 <= a.radiusMi).sort((x, y) => x.d - y.d);
  if (!near.length) return "No active reports near your fields. 👍";
  return near.slice(0, 5).map(({ a, d }) => `• ${ALERT_TYPES[a.type].label} at ${a.fieldId}, ${d.toFixed(1)} mi away (${a.reporterName})${a.note ? `: "${a.note}"` : ""}`).join("\n");
}

function contextFor(sub) {
  return {
    farmer: sub.name,
    fields: sub.fieldIds.map((id) => {
      const f = byId.get(id);
      return {
        id, crop: f.properties.crop, acres: f.properties.acres,
        history: f.properties.series,
        assessment: assess(fields, f, STATUS_SCENE, { alerts: state.alerts }).insights.map((i) => `${i.title}: ${i.body}`),
      };
    }),
    nearbyAlerts: alertsText(sub),
    indices: Object.fromEntries(Object.values(INDICES).map((i) => [i.short, i.explain])),
    latestScene: SCENES[STATUS_SCENE].date,
    today: new Date().toISOString().slice(0, 10),
  };
}

/* ---------------------------------------------------------------- alerts + broadcast */
async function createAlert({ type, note = "", radiusMi = DEFAULT_RADIUS, fieldId, reporterId, reporterName, source = "web", center }) {
  const field = byId.get(fieldId);
  if (!field) throw new Error(`Unknown field ${fieldId}`);
  if (!ALERT_TYPES[type]) type = "pest";
  const alert = {
    id: `A${Date.now().toString(36)}`, type, note: String(note).slice(0, 280), radiusMi: Math.min(10, Math.max(0.5, +radiusMi || DEFAULT_RADIUS)),
    fieldId, reporterId, reporterName, source, center: center ?? centroid(field), createdAt: new Date().toISOString(), notified: [],
  };
  state.alerts.unshift(alert);

  const reached = fieldsWithin(fields, alert.center, alert.radiusMi).filter(({ f }) => f.properties.farmerId !== reporterId);
  const nearestByFarmer = new Map();
  for (const { f, d } of reached) if (!nearestByFarmer.has(f.properties.farmerId)) nearestByFarmer.set(f.properties.farmerId, { f, d });

  const t = ALERT_TYPES[type];
  for (const [farmerId, { f, d }] of nearestByFarmer) {
    const subs = Object.values(state.subscribers).filter((s) => s.farmerId === farmerId);
    if (!subs.length) { alert.notified.push({ farmerId, name: f.properties.farmer, channel: "app", status: "delivered" }); continue; }
    for (const s of subs) {
      const msg = `⚠️ Farmers for Farmers: ${reporterName} reported ${t.verb} at field ${fieldId}, ${d < 0.4 ? "right next to" : `${d.toFixed(1)} mi from`} your field ${f.properties.id}.` +
        `${alert.note ? `\n"${alert.note}"` : ""}\n${advice(type)}\nReply ALERTS for details, STOP to opt out.`;
      const via = s.channel === "simulator" ? sim : channel;
      try {
        await via.send(s, msg);
        alert.notified.push({ farmerId, name: f.properties.farmer, channel: s.channel === "simulator" ? "simulator" : "imessage", status: "sent" });
      } catch (e) {
        log(`[out] alert to ${s.phone} failed: ${e.message}`);
        alert.notified.push({ farmerId, name: f.properties.farmer, channel: "app", status: `text failed: ${e.message}` });
      }
      await new Promise((r) => setTimeout(r, 400)); // gentle pacing for deliverability
    }
  }
  save();
  log(`[alert] ${type} at ${fieldId} by ${reporterName}: ${alert.notified.length} farmers notified`);
  return alert;
}

function advice(type) {
  return {
    pest: "Scout the field edge closest to them in the next 2–3 days.",
    disease: "Check lower leaves on your nearest rows; spores travel with wind and rain.",
    drought: "Check soil moisture before your next irrigation decision.",
    nutrient: "Worth a tissue test if your field looks pale in the same spots.",
    flood: "Watch low spots and tile outlets for ponding.",
  }[type];
}

/* ---------------------------------------------------------------- HTTP */
const mask = (p) => (p?.startsWith("+") ? `${p.slice(0, -4).replace(/\d/g, "•")}${p.slice(-4)}` : "simulated");
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  const json = (code, body) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
  const body = async () => { let s = ""; for await (const c of req) s += c; return s ? JSON.parse(s) : {}; };
  try {
    if (url.pathname === "/api/state" && req.method === "GET") {
      return json(200, {
        channel: channel.name,
        alerts: state.alerts.slice(0, 200),
        subscribers: Object.values(state.subscribers).map((s) => ({ name: s.name, farmerId: s.farmerId, fieldIds: s.fieldIds, channel: s.channel, phoneMasked: mask(s.phone) })),
      });
    }
    if (url.pathname === "/api/alerts" && req.method === "POST") {
      const b = await body();
      return json(201, await createAlert(b));
    }
    const m = url.pathname.match(/^\/api\/alerts\/([\w-]+)\/resolve$/);
    if (m && req.method === "POST") {
      const a = state.alerts.find((x) => x.id === m[1]);
      if (a) { a.resolved = true; save(); }
      return json(200, { ok: !!a });
    }
    if (url.pathname === "/api/sim/inbound" && req.method === "POST") {
      const b = await body();
      const replies = await handleInbound({ from: b.phone, text: b.text, thread: {}, via: sim });
      return json(200, { replies });
    }
    if (url.pathname === "/api/sim/outbox" && req.method === "GET") {
      const phone = url.searchParams.get("phone"), after = +url.searchParams.get("after") || 0;
      return json(200, sim.outbox.filter((o) => o.to === phone && o.id > after));
    }
    // Serve the website too, so one command runs the whole demo.
    if (req.method === "GET") return serveStatic(url.pathname, res);
    json(404, { error: "not found" });
  } catch (e) {
    log("[http]", e);
    json(400, { error: e.message });
  }
});

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".geojson": "application/geo+json", ".png": "image/png", ".svg": "image/svg+xml" };
function serveStatic(p, res) {
  const file = path.normalize(path.join(WEB, p === "/" ? "index.html" : decodeURIComponent(p)));
  if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end("not found");
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
  fs.createReadStream(file).pipe(res);
}

server.listen(PORT, () => {
  log(`Farmers for Farmers agent on http://localhost:${PORT}  (map: /, phone simulator: /phone.html)`);
  channel.start();
});
