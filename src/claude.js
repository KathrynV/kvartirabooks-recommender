// Calls the Anthropic Messages API with the caller-supplied API key. The key
// is used only for this one request and is never logged, stored, or written
// to disk.
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-sonnet-5";

async function callAnthropic({ apiKey, system, userContent, maxTokens, tools, toolChoice }) {
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
        model: process.env.CLAUDE_MODEL || DEFAULT_MODEL,
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

function buildRecommendTool(count) {
  return {
    name: "submit_recommendations",
    description: `Submit the final list of exactly ${count} recommended book(s).`,
    input_schema: {
      type: "object",
      properties: {
        recommendations: {
          type: "array",
          minItems: count,
          maxItems: count,
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              sku: { type: "string", description: "Must exactly match a SKU from the candidate list." },
              availability: { type: "string", enum: ["for_sale", "for_borrow"] },
              reason: {
                type: "string",
                description: "One sentence citing specific evidence from the customer's history.",
              },
            },
            required: ["title", "sku", "availability", "reason"],
          },
        },
      },
      required: ["recommendations"],
    },
  };
}

export async function getRecommendations({
  apiKey,
  customerName,
  history = [],
  candidates,
  count = 3,
  profile = null,
}) {
  // count is capped by the caller to the number of available candidates, so
  // this is always achievable — the schema below enforces it exactly rather
  // than leaving "how many" to the model's judgment, which otherwise tends
  // to under-fill (e.g. return 2 "strong" picks) when a couple of candidates
  // seem like a weaker fit than the rest.
  const hasHistory = history.length > 0;

  const contextBlock = profile
    ? `This is a brand-new customer with no purchase/borrow history yet — a staff member is describing them instead:
- Age / reading level: ${profile.age || "not specified"}
- Preferred topics/genres: ${profile.topics || "not specified"}
- Clue words / keywords: ${profile.keywords || "not specified"}
Base your picks entirely on this description.`
    : `Given a customer's past order/borrow history (title + SKU only), pick books that fit their established taste.`;

  const system = `You are a book recommendation assistant for a Russian children's bookstore and lending library.
${contextBlock}

From the list of currently in-stock catalog candidates provided, pick exactly ${count} book(s) — ranked best fit first.

Rules:
- Only recommend books from the provided candidate list — never invent a title or SKU.
${hasHistory ? "- Never recommend a title/SKU that already appears in the customer's history.\n" : ""}- You must return exactly ${count} recommendation(s), even if some are a weaker fit than others.
- Each recommendation needs a one-sentence justification citing specific evidence (${
    profile ? "matching the age, topics, or keywords given" : "a series, author, or theme from their history"
  }).
- Call submit_recommendations exactly once with your final answer.`;

  const userContent = JSON.stringify({
    customer: customerName,
    ...(hasHistory ? { orderHistory: history } : {}),
    ...(profile ? { customerProfile: profile } : {}),
    inStockCandidates: candidates,
  });

  const tool = buildRecommendTool(count);
  const data = await callAnthropic({
    apiKey,
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

  // Normalize: despite the array schema, models occasionally don't hand back
  // a plain array of objects directly:
  // - a bare object instead of a one-element array (mainly when count === 1,
  //   where wrapping a single item in an array reads as redundant)
  // - a JSON-encoded *string* instead of structured output — sometimes even
  //   double-wrapped, i.e. a string containing the whole
  //   {"recommendations": [...]} object again
  // Without unwrapping these, callers doing recommendations.map(...) crash
  // with a confusing "recommendations.map is not a function" instead of a
  // real error.
  let raw = toolUse.input?.recommendations;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      raw = Array.isArray(parsed) ? parsed : (parsed?.recommendations ?? parsed);
    } catch {
      raw = null;
    }
  }
  const recommendations = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];

  // Catalog SKUs are bare numeric ISBNs (e.g. 9785961487619), so a model will
  // sometimes emit sku/title as a JSON number rather than a string even
  // though the schema says "string" — coerce instead of rejecting, since
  // rejecting on strict typeof silently threw out every recommendation here.
  const valid = recommendations
    .filter((r) => r && ["string", "number"].includes(typeof r.sku) && ["string", "number"].includes(typeof r.title))
    .map((r) => ({ ...r, sku: String(r.sku), title: String(r.title) }));

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
export async function getCustomerSummary({ apiKey, customerName, historyCount, sampleTitles, topAuthors, topCategories }) {
  const system = `You are a librarian assistant for a Russian children's bookstore and lending library.
Write a SHORT summary (3-5 sentences, plain text, no headers or bullet points) of this customer's reading
preferences based on the order/borrow history metadata below (a sample of titles with authors/categories/age
level, plus their most frequent authors and categories overall).

Rules:
- Base every claim on the data given — don't invent authors, series, or themes not present in it.
- Cite specifics: name actual authors/series/themes and roughly how often they recur, not generic genre labels.
- If a reading-level/age signal stands out, mention it.
- Write for a bookstore staff member deciding what to hand this customer next — practical, not flowery.`;

  const userContent = JSON.stringify({
    customer: customerName,
    totalHistoryItems: historyCount,
    sampleTitlesWithMetadata: sampleTitles,
    mostFrequentAuthors: topAuthors,
    mostFrequentCategories: topCategories,
  });

  const data = await callAnthropic({ apiKey, system, userContent, maxTokens: 512 });
  const textBlock = data.content?.find((b) => b.type === "text" && typeof b.text === "string" && b.text.trim());
  if (!textBlock) {
    throw new Error("Claude did not return a summary.");
  }
  return textBlock.text.trim();
}
