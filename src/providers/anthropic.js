// Calls the Anthropic Messages API with the caller-supplied API key. The key
// is used only for this one request and is never logged, stored, or written
// to disk.
import {
  buildRecommendSystem,
  buildRecommendUserContent,
  recommendToolSchema,
  normalizeRecommendations,
  buildSummarySystem,
  buildSummaryUserContent,
} from "../prompts.js";

const ANTHROPIC_VERSION = "2023-06-01";
export const DEFAULT_MODEL = "claude-sonnet-5";
export const LABEL = "Anthropic";

async function callAnthropic({ apiKey, model, system, userContent, maxTokens, tools, toolChoice }) {
  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: model || DEFAULT_MODEL,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: userContent }],
        ...(tools ? { tools, tool_choice: toolChoice } : {}),
      }),
    });
  } catch (err) {
    // A malformed header value (e.g. non-Latin1 characters in apiKey) throws
    // a low-level TypeError here rather than a normal failed response —
    // surface it as a clear error instead of letting it look like a crash.
    if (err instanceof TypeError) {
      throw new Error("The Anthropic API key looks malformed — check what's pasted into that field.");
    }
    throw err;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401) {
      throw new Error("Anthropic API key was rejected — check that it's valid and active.");
    }
    throw new Error(`Anthropic API request failed: ${res.status} ${res.statusText} ${body}`.trim());
  }

  return res.json();
}

export async function getRecommendations({
  apiKey,
  model,
  customerName,
  history = [],
  candidates,
  count = 3,
  profile = null,
}) {
  const system = buildRecommendSystem({ count, history, profile });
  const userContent = buildRecommendUserContent({ customerName, history, profile, candidates });
  const toolDef = recommendToolSchema(count);
  const tool = { name: toolDef.name, description: toolDef.description, input_schema: toolDef.schema };

  const data = await callAnthropic({
    apiKey,
    model,
    system,
    userContent,
    maxTokens: 2048,
    tools: [tool],
    toolChoice: { type: "tool", name: tool.name },
  });

  const toolUse = data.content?.find((b) => b.type === "tool_use" && b.name === "submit_recommendations");
  if (!toolUse) {
    throw new Error("Claude did not return a structured recommendation.");
  }

  const valid = normalizeRecommendations(toolUse.input?.recommendations);
  if (valid.length === 0) {
    console.error(
      "Unrecognized tool_use.input shape from Claude:",
      JSON.stringify(toolUse.input).slice(0, 2000),
    );
    throw new Error("Claude returned a recommendation in an unexpected format.");
  }
  return valid;
}

// A short (3-5 sentence) plain-language profile of a customer's reading
// preferences, shown to staff before they decide to ask for recommendations.
// Plain text response (no tool use) — there's no structure to enforce here.
export async function getCustomerSummary({
  apiKey,
  model,
  customerName,
  historyCount,
  sampleTitles,
  topAuthors,
  topCategories,
}) {
  const system = buildSummarySystem();
  const userContent = buildSummaryUserContent({ customerName, historyCount, sampleTitles, topAuthors, topCategories });

  const data = await callAnthropic({ apiKey, model, system, userContent, maxTokens: 512 });
  const textBlock = data.content?.find((b) => b.type === "text" && typeof b.text === "string" && b.text.trim());
  if (!textBlock) {
    throw new Error("Claude did not return a summary.");
  }
  return textBlock.text.trim();
}
