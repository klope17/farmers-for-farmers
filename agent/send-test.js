// Send one test text through the configured Photon channel.
// Usage: node --env-file=agent/.env agent/send-test.js +15551234567 "message"
import { createChannel } from "./photon.js";

const [phone, text = "🌱 Farmers for Farmers test: your texting agent is connected. Reply JOIN F05 to try it."] = process.argv.slice(2);
if (!phone?.startsWith("+")) throw new Error("Pass the number in E.164 form, e.g. +15551234567");

const channel = createChannel({ onInbound: async () => {}, log: console.log });
await channel.start();
await channel.send({ phone }, text);
console.log(`sent via ${channel.name} to ${phone}`);
setTimeout(() => process.exit(0), 1500);
