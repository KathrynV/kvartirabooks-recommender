// Calls the OpenAI Chat Completions API with the caller-supplied API key. The
// key is used only for this one request and is never logged, stored, or
// written to disk.
import {
  buildRecommendSystem,
  buildRecommendUserContent,
  recommendToolSchema,
  normalizeRecommendations,
  buildSummarySystem,
  buildSummaryUserContent,
} from "../prompts.js";

export const DEFAULT_MODEL = "gpt-4o-mini";
export const LABEL = "OpenAI";

async function callOpenAI({ apiKey, model, system, userContent, maxTokens, tools, toolChoice }) {
  let res;
  try {
    res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || DEFAULT_MODEL,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userContent },
        ],
        ...(tools ? { tools, tool_choice: toolChoice } : {}),
      }),
    });
  } catch (err) {
    // A malformed header value (e.g. non-Latin1 characters in apiKey) throws
    // a low-level TypeError here rather than a normal failed response —
    // surface it as a clear error instead of letting it look like a crash.
    if (err instanceof TypeError) {
      throw new Error("The OpenAI API key looks malformed — check what's pasted into that field.");
    }
    throw err;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401) {
      throw new Error("OpenAI API key was rejected — check that it's valid and active.");
    }
    throw new Error(`OpenAI API request failed: ${res.status} ${res.statusText} ${body}`.trim());
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
  const tool = {
    type: "function",
    function: { name: toolDef.name, description: toolDef.description, parameters: toolDef.schema },
  };

  const data = await callOpenAI({
    apiKey,
    model,
    system,
    userContent,
    maxTokens: 2048,
    tools: [tool],
    toolChoice: { type: "function", function: { name: toolDef.name } },
  });

  const message = data.choices?.[0]?.message;
  const toolCall = message?.tool_calls?.find((c) => c.function?.name === "submit_recommendations");
  if (!toolCall) {
    throw new Error("ChatGPT did not return a structured recommendation.");
  }

  let raw;
  try {
    raw = JSON.parse(toolCall.function.arguments)?.recommendations;
  } catch {
    raw = null;
  }

  const valid = normalizeRecommendations(raw);
  if (valid.length === 0) {
    console.error(
      "Unrecognized tool_call arguments shape from ChatGPT:",
      String(toolCall.function.arguments).slice(0, 2000),
    );
    throw new Error("ChatGPT returned a recommendation in an unexpected format.");
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

  const data = await callOpenAI({ apiKey, model, system, userContent, maxTokens: 512 });
  const text = data.choices?.[0]?.message?.content;
  if (!text || !text.trim()) {
    throw new Error("ChatGPT did not return a summary.");
  }
  return text.trim();
}
