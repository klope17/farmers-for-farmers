// Optional: free-form texts are answered by Claude, grounded in the farmer's own
// field data. Without ANTHROPIC_API_KEY (or an `ant auth login` profile) the agent
// still handles JOIN / STATUS / REPORT / ALERTS / STOP.
import Anthropic from "@anthropic-ai/sdk";

let client = null;
try { client = new Anthropic(); } catch { client = null; }

const SYSTEM = `You are the Farmers for Farmers texting agent: a friendly, practical agronomy helper that farmers in Story County, Iowa reach by iMessage.
Reply like a knowledgeable neighbor texting back: plain words, at most 3 short sentences, no markdown, no bullet symbols.
Ground every claim in the field data provided (Sentinel-2 NDVI/NDRE/NDMI history and community alerts). If the data can't answer it, say what to check in the field instead.
Never invent pesticide product names or rates; suggest scouting, tissue tests, or calling their agronomist / ISU Extension for treatment decisions.
If the farmer describes a problem they are seeing on their own field right now (pests, disease, drought, nutrient deficiency, flooding), call report_issue so nearby farmers are warned, then tell them how many neighbors were notified.`;

const TOOLS = [{
  name: "report_issue",
  description: "Warn neighboring farms within 2 miles about a problem the farmer is seeing on their own field right now.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["type", "note"],
    properties: {
      type: { type: "string", enum: ["pest", "disease", "drought", "nutrient", "flood"] },
      note: { type: "string", description: "Short description in the farmer's own words, under 120 characters." },
    },
  },
}];

export async function askClaude({ text, sub, context, report }) {
  if (!client) return null;
  const messages = [{
    role: "user",
    content: `<field_data>\n${JSON.stringify(context)}\n</field_data>\n\nText from ${sub.name}: ${text}`,
  }];
  try {
    for (let turn = 0; turn < 3; turn++) {
      const response = await client.beta.messages.create({
        model: "claude-opus-5-5",
        max_tokens: 2048, // SMS-length replies
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low" },
        system: SYSTEM,
        tools: TOOLS,
        messages,
      });
      if (response.stop_reason === "refusal") return null;
      const toolUses = response.content.filter((b) => b.type === "tool_use");
      if (response.stop_reason !== "tool_use" || !toolUses.length) {
        return response.content.filter((b) => b.type === "text").map((b) => b.text).join(" ").trim() || null;
      }
      messages.push({ role: "assistant", content: response.content });
      const results = [];
      for (const tu of toolUses) {
        try {
          const alert = await report(tu.input.type, tu.input.note);
          results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify({ ok: true, neighborsNotified: alert.notified.length, field: alert.fieldId }) });
        } catch (e) {
          results.push({ type: "tool_result", tool_use_id: tu.id, content: e.message, is_error: true });
        }
      }
      messages.push({ role: "user", content: results });
    }
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) { client = null; console.log("[claude] no valid credentials; free-form replies disabled"); }
    else console.log(`[claude] ${e.message}`);
  }
  return null;
}
