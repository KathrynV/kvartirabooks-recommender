import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findCustomer, recommendForCustomer, recommendForProfile, profileCustomer } from "./src/recommend.js";
import { isValidProvider, providerLabel } from "./src/llm.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = process.env.PORT || 3000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

async function serveStatic(req, res) {
  const urlPath = req.url === "/" ? "/index.html" : req.url;
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ""));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const body = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

// Shared by all three endpoints. Returns an error string, or null if
// provider/apiKey are OK.
function checkProviderAndApiKey(provider, apiKey) {
  if (!isValidProvider(provider)) {
    return `Unsupported model provider "${provider}".`;
  }
  const label = providerLabel(provider);
  if (!apiKey || typeof apiKey !== "string") {
    return `${label} API key is required.`;
  }
  // HTTP header values are restricted to Latin-1 bytes — sending anything
  // outside that range (e.g. Cyrillic text, which happens if a customer
  // name/description got typed into the API key field by mistake) throws a
  // cryptic low-level "ByteString" error from fetch() rather than a useful
  // message. Catch it here with a clear one instead.
  if (!/^[\x00-\xFF]*$/.test(apiKey)) {
    return `That doesn't look like a valid ${label} API key (it contains non-Latin characters). ` +
      "Check you pasted it into the API key field, not another field.";
  }
  return null;
}

// Shared by /api/customer-profile and /api/recommend: resolves a customer
// from either a free-text query or a customerId confirmed via a prior
// disambiguation step. Returns { customer } on success, or { error: {status,
// body} } with a response already shaped for sendJson (including the
// needsDisambiguation case, which isn't actually an error).
async function resolveCustomerFromBody(body) {
  const { query, customerId } = body;
  if (customerId) {
    // Coming back from a disambiguation step; the client already has the
    // full match list, so re-resolve via the same query to get a fresh
    // customer object rather than trusting an unverified id/name pair.
    const result = await findCustomer(query || String(customerId));
    let customer;
    if (result.status === "found") {
      customer = result.customer;
    } else if (result.status === "ambiguous") {
      customer = result.matches.find((m) => m.id === Number(customerId));
    }
    if (!customer) {
      return { error: { status: 404, body: { error: "Selected customer not found." } } };
    }
    return { customer };
  }

  const result = await findCustomer(query);
  if (result.status === "not_found") {
    return { error: { status: 404, body: { error: `No customer found matching "${query}".` } } };
  }
  if (result.status === "ambiguous") {
    return { error: { status: 200, body: { needsDisambiguation: true, matches: result.matches } } };
  }
  return { customer: result.customer };
}

async function handleRecommend(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }

  const { query, customerId, apiKey } = body;
  const provider = body.provider || "anthropic";
  const model = typeof body.model === "string" ? body.model.trim() : "";
  const excludeSkus = Array.isArray(body.excludeSkus)
    ? body.excludeSkus.filter((s) => typeof s === "string")
    : [];
  const libraryOnly = Boolean(body.libraryOnly);
  const round = Number.isInteger(body.round) ? Math.max(0, Math.min(body.round, 10)) : 0;
  const apiKeyError = checkProviderAndApiKey(provider, apiKey);
  if (apiKeyError) {
    return sendJson(res, 400, { error: apiKeyError });
  }
  if (!query && !customerId) {
    return sendJson(res, 400, { error: "Provide a customer name, email, or phone number." });
  }

  try {
    const resolved = await resolveCustomerFromBody(body);
    if (resolved.error) {
      return sendJson(res, resolved.error.status, resolved.error.body);
    }
    const { customer } = resolved;

    const outcome = await recommendForCustomer({ customer, provider, apiKey, model, excludeSkus, libraryOnly, round });

    if (outcome.status === "no_history") {
      return sendJson(res, 200, {
        customer,
        recommendations: [],
        message: "This customer has no prior orders to base recommendations on.",
      });
    }
    if (outcome.status === "no_candidates") {
      return sendJson(res, 200, {
        customer,
        historyCount: outcome.historyCount,
        recommendations: [],
        message:
          outcome.message || "Found order history, but no matching in-stock titles right now.",
      });
    }

    return sendJson(res, 200, {
      customer,
      historyCount: outcome.historyCount,
      candidateCount: outcome.candidateCount,
      recommendations: outcome.recommendations,
    });
  } catch (err) {
    console.error("recommend error:", err.message);
    return sendJson(res, 502, { error: err.message });
  }
}

async function handleCustomerProfile(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }

  const { query, customerId, apiKey } = body;
  const provider = body.provider || "anthropic";
  const model = typeof body.model === "string" ? body.model.trim() : "";
  const apiKeyError = checkProviderAndApiKey(provider, apiKey);
  if (apiKeyError) {
    return sendJson(res, 400, { error: apiKeyError });
  }
  if (!query && !customerId) {
    return sendJson(res, 400, { error: "Provide a customer name, email, or phone number." });
  }

  try {
    const resolved = await resolveCustomerFromBody(body);
    if (resolved.error) {
      return sendJson(res, resolved.error.status, resolved.error.body);
    }
    const { customer } = resolved;

    const outcome = await profileCustomer({ customer, provider, apiKey, model });

    if (outcome.status === "no_history") {
      return sendJson(res, 200, {
        customer,
        historyCount: 0,
        summary: null,
        message: "This customer has no prior orders to base a summary on.",
      });
    }

    return sendJson(res, 200, {
      customer,
      historyCount: outcome.historyCount,
      summary: outcome.summary,
    });
  } catch (err) {
    console.error("customer-profile error:", err.message);
    return sendJson(res, 502, { error: err.message });
  }
}

async function handleRecommendProfile(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }

  const apiKey = body.apiKey;
  const provider = body.provider || "anthropic";
  const model = typeof body.model === "string" ? body.model.trim() : "";
  const age = typeof body.age === "string" ? body.age.trim() : "";
  const topics = typeof body.topics === "string" ? body.topics.trim() : "";
  const keywords = typeof body.keywords === "string" ? body.keywords.trim() : "";
  const excludeSkus = Array.isArray(body.excludeSkus)
    ? body.excludeSkus.filter((s) => typeof s === "string")
    : [];

  const apiKeyError = checkProviderAndApiKey(provider, apiKey);
  if (apiKeyError) {
    return sendJson(res, 400, { error: apiKeyError });
  }
  if (!age && !topics && !keywords) {
    return sendJson(res, 400, { error: "Describe the customer's age, preferred topics, or keywords." });
  }

  try {
    const outcome = await recommendForProfile({ provider, apiKey, model, age, topics, keywords, excludeSkus });

    if (outcome.status === "no_candidates") {
      return sendJson(res, 200, { recommendations: [], message: outcome.message });
    }

    return sendJson(res, 200, {
      candidateCount: outcome.candidateCount,
      matchedAgeTerm: outcome.matchedAgeTerm,
      recommendations: outcome.recommendations,
    });
  } catch (err) {
    console.error("recommend-profile error:", err.message);
    return sendJson(res, 502, { error: err.message });
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/api/recommend") {
    return handleRecommend(req, res);
  }
  if (req.method === "POST" && req.url === "/api/recommend-profile") {
    return handleRecommendProfile(req, res);
  }
  if (req.method === "POST" && req.url === "/api/customer-profile") {
    return handleCustomerProfile(req, res);
  }
  if (req.method === "GET") {
    return serveStatic(req, res);
  }
  res.writeHead(405).end("Method not allowed");
});

server.listen(PORT, () => {
  console.log(`book-recommender-web listening on http://localhost:${PORT}`);
});
