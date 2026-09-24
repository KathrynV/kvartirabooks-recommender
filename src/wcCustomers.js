// Authenticated WooCommerce REST API v3 — customer + order lookups.
// Requires WC_CONSUMER_KEY / WC_CONSUMER_SECRET (server-side only, never
// sent to the browser).
const BASE_URL = "https://kvartirabooks.org/wp-json/wc/v3";

const EMAIL_PATTERN = /^\S+@\S+\.\S+$/;

// Statuses that don't mean "the customer had this book" — a cancelled/failed
// order, an abandoned checkout draft, or a gift-certificate line item.
const EXCLUDED_STATUSES = new Set(["cancelled", "failed", "refunded", "checkout-draft"]);

function authHeaders() {
  const key = process.env.WC_CONSUMER_KEY;
  const secret = process.env.WC_CONSUMER_SECRET;
  if (!key || !secret) {
    throw new Error(
      "Missing WC_CONSUMER_KEY/WC_CONSUMER_SECRET. Set them in .env (see .env.example).",
    );
  }
  const token = Buffer.from(`${key}:${secret}`).toString("base64");
  // Node's fetch() sends no User-Agent by default, and Cloudflare's WAF in
  // front of kvartirabooks.org blocks requests with a missing User-Agent
  // (403 "Attention Required") even with valid WooCommerce credentials.
  return { Authorization: `Basic ${token}`, "User-Agent": "kvartirabooks-recommender/1.0" };
}

async function wcGet(path, params) {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params || {})) {
    url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), { headers: authHeaders() });
  if (!res.ok) {
    throw new Error(`WooCommerce request failed: ${res.status} ${res.statusText} (${path})`);
  }
  return res;
}

function toCustomerSummary(c) {
  return {
    id: c.id,
    name: `${c.first_name} ${c.last_name}`.trim() || c.email,
    email: c.email,
    phone: c.billing?.phone || null,
  };
}

// Resolves free-text input (name, email, or phone) to one or more matching
// customers. Email gets an exact-match lookup; anything else gets WooCommerce's
// fuzzy name/login/email search, plus — if the input looks like a phone
// number — a bounded scan of billing phone numbers (the customers search
// endpoint doesn't index phone).
export async function resolveCustomer(query) {
  const trimmed = query.trim();
  const found = new Map();

  if (EMAIL_PATTERN.test(trimmed)) {
    const res = await wcGet("/customers", { email: trimmed, role: "all", per_page: 10 });
    for (const c of await res.json()) found.set(c.id, c);

    // The exact-email lookup has occasionally come back empty for a real,
    // existing customer on the first try (transient WooCommerce-side flake,
    // not a code path we control) with no other fallback for an email query.
    // The general fuzzy `search` param goes through a different underlying
    // query (LIKE across login/display-name/email) and reliably succeeds
    // when this happens, so fall back to it before concluding "not found".
    if (found.size === 0) {
      const fallback = await wcGet("/customers", { search: trimmed, role: "all", per_page: 10 }).catch(
        () => null,
      );
      if (fallback) {
        for (const c of await fallback.json()) found.set(c.id, c);
      }
    }
  } else {
    const res = await wcGet("/customers", { search: trimmed, role: "all", per_page: 10 });
    for (const c of await res.json()) found.set(c.id, c);
  }

  const digits = trimmed.replace(/\D/g, "");
  if (found.size === 0 && digits.length >= 7) {
    // Phone isn't searchable server-side, and the customers list has no
    // useful default ordering (IDs come back essentially shuffled — not by
    // id, not alphabetical, not by registration date), so a small bounded
    // window can miss a real match almost arbitrarily. Scan the whole table
    // instead, capped only as a sanity limit against runaway growth.
    const PER_PAGE = 100;
    const MAX_PAGES = 50; // sanity cap: 5,000 customers: store had ~1,569 as of writing

    function scanBatch(batch) {
      for (const c of batch) {
        const billingDigits = (c.billing?.phone || "").replace(/\D/g, "");
        if (billingDigits && billingDigits.includes(digits)) {
          found.set(c.id, c);
        }
      }
    }

    const firstRes = await wcGet("/customers", { role: "all", per_page: PER_PAGE, page: 1 });
    const totalPages = Math.min(Number(firstRes.headers.get("x-wp-totalpages") ?? 1), MAX_PAGES);
    scanBatch(await firstRes.json());

    if (totalPages > 1) {
      const remainingPages = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
      await Promise.all(
        remainingPages.map(async (page) => {
          const res = await wcGet("/customers", { role: "all", per_page: PER_PAGE, page }).catch(() => null);
          if (res) scanBatch(await res.json());
        }),
      );
    }
  }

  return [...found.values()].map(toCustomerSummary);
}

// Fetches a bounded, recent window of a customer's orders (mirrors the
// live-recommender skill's default: ~50-100 most recent orders, not the
// full history) and flattens them to deduplicated {name, sku} line items.
export async function getRecentOrderHistory(customerId, { perPage = 25, maxPages = 4 } = {}) {
  const lineItems = [];
  let totalPages = 1;

  for (let page = 1; page <= maxPages && page <= totalPages; page++) {
    const res = await wcGet("/orders", {
      customer: customerId,
      per_page: perPage,
      page,
      orderby: "date",
      order: "desc",
    });
    totalPages = Number(res.headers.get("x-wp-totalpages") ?? 1);
    const orders = await res.json();
    for (const order of orders) {
      if (EXCLUDED_STATUSES.has(order.status)) continue;
      for (const item of order.line_items) {
        lineItems.push({ name: item.name, sku: item.sku || null });
      }
    }
  }

  // Dedupe by (name, sku) while keeping every distinct SKU/title pair.
  const seen = new Map();
  for (const item of lineItems) {
    const key = `${item.sku ?? ""}|${item.name}`;
    if (!seen.has(key)) seen.set(key, item);
  }
  return [...seen.values()];
}
