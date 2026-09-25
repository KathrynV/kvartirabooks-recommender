// Provider-agnostic prompt text and response normalization, shared by
// src/providers/anthropic.js and src/providers/openai.js so the two provider
// adapters only have to deal with API-shape differences, not prompt content.

export function buildRecommendSystem({ count, history = [], profile = null }) {
  const hasHistory = history.length > 0;

  const contextBlock = profile
    ? `This is a brand-new customer with no purchase/borrow history yet — a staff member is describing them instead:
- Age / reading level: ${profile.age || "not specified"}
- Preferred topics/genres: ${profile.topics || "not specified"}
- Clue words / keywords: ${profile.keywords || "not specified"}
Base your picks entirely on this description.`
    : `Given a customer's past order/borrow history (title + SKU only), pick books that fit their established taste.`;

  return `You are a book recommendation assistant for a Russian children's bookstore and lending library.
${contextBlock}

From the list of currently in-stock catalog candidates provided, pick exactly ${count} book(s) — ranked best fit first.

Rules:
- Only recommend books from the provided candidate list — never invent a title or SKU.
${hasHistory ? "- Never recommend a title/SKU that already appears in the customer's history.\n" : ""}- You must return exactly ${count} recommendation(s), even if some are a weaker fit than others.
- Each recommendation needs a one-sentence justification citing specific evidence (${
    profile ? "matching the age, topics, or keywords given" : "a series, author, or theme from their history"
  }).
- Call submit_recommendations exactly once with your final answer.`;
}

export function buildRecommendUserContent({ customerName, history = [], profile = null, candidates }) {
  const hasHistory = history.length > 0;
  return JSON.stringify({
    customer: customerName,
    ...(hasHistory ? { orderHistory: history } : {}),
    ...(profile ? { customerProfile: profile } : {}),
    inStockCandidates: candidates,
  });
}

// Provider-neutral JSON Schema for the recommendation tool call. Anthropic's
// tool format wraps this as { name, description, input_schema }; OpenAI's
// wraps it as { type: "function", function: { name, description, parameters } }.
export function recommendToolSchema(count) {
  return {
    name: "submit_recommendations",
    description: `Submit the final list of exactly ${count} recommended book(s).`,
    schema: {
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

// Normalizes a model's raw "recommendations" payload into a clean array of
// { title, sku, ... } objects. Models occasionally don't hand back a plain
// array of objects directly:
// - a bare object instead of a one-element array (mainly when count === 1,
//   where wrapping a single item in an array reads as redundant)
// - a JSON-encoded *string* instead of structured output — sometimes even
//   double-wrapped, i.e. a string containing the whole
//   {"recommendations": [...]} object again
// Without unwrapping these, callers doing recommendations.map(...) crash
// with a confusing "recommendations.map is not a function" instead of a
// real error.
export function normalizeRecommendations(raw) {
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
  return recommendations
    .filter((r) => r && ["string", "number"].includes(typeof r.sku) && ["string", "number"].includes(typeof r.title))
    .map((r) => ({ ...r, sku: String(r.sku), title: String(r.title) }));
}

export function buildSummarySystem() {
  return `You are a librarian assistant for a Russian children's bookstore and lending library.
Write a SHORT summary (3-5 sentences, plain text, no headers or bullet points) of this customer's reading
preferences based on the order/borrow history metadata below (a sample of titles with authors/categories/age
level, plus their most frequent authors and categories overall).

Rules:
- Base every claim on the data given — don't invent authors, series, or themes not present in it.
- Cite specifics: name actual authors/series/themes and roughly how often they recur, not generic genre labels.
- If a reading-level/age signal stands out, mention it.
- Write for a bookstore staff member deciding what to hand this customer next — practical, not flowery.`;
}

export function buildSummaryUserContent({ customerName, historyCount, sampleTitles, topAuthors, topCategories }) {
  return JSON.stringify({
    customer: customerName,
    totalHistoryItems: historyCount,
    sampleTitlesWithMetadata: sampleTitles,
    mostFrequentAuthors: topAuthors,
    mostFrequentCategories: topCategories,
  });
}
