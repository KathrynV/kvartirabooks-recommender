import { resolveCustomer, getRecentOrderHistory } from "./wcCustomers.js";
import {
  searchProducts,
  searchCategories,
  getAgeTerms,
  searchProductsInCategory,
  getProductBySku,
  toCandidate,
} from "./wcCatalog.js";
import { baseSku, normalizeTitle } from "./availability.js";
import { getRecommendations, getCustomerSummary } from "./llm.js";

const MAX_ENRICH = 40; // cap catalog lookups for seeding search queries
const MAX_SEARCH_TERMS = 18; // cap author/category search queries
const MAX_CANDIDATES_TO_MODEL = 30;

// The catalog's search endpoint does word-level matching against indexed
// content, which breaks on full "Firstname Lastname" author queries —
// Russian surnames decline (e.g. an attribute term "Андрей Усачев" won't
// match a title containing the inflected "Андреем Усачевым"), and the
// endpoint doesn't do fuzzy/stemmed matching across the whole phrase either.
// A single distinctive word (usually the surname) matches far more
// reliably via substring search than the full name does.
function searchableTerm(name) {
  const words = name.split(/\s+/).filter((w) => w.replace(/[.,]/g, "").length >= 4);
  if (words.length === 0) return name;
  return words.reduce((longest, w) => (w.length > longest.length ? w : longest));
}

export async function findCustomer(query) {
  const matches = await resolveCustomer(query);
  if (matches.length === 0) return { status: "not_found" };
  if (matches.length > 1) return { status: "ambiguous", matches };
  return { status: "found", customer: matches[0] };
}

// Enriches a bounded sample of unique history SKUs with catalog metadata
// (authors/categories/age group) via the public Store API — the order-history
// endpoint only gives back title + SKU, not genre/author tags. Most-recent
// items are sampled first (most relevant to current taste), and per-item
// results are cached by SKU across calls in the same request since a title
// borrowed/bought repeatedly would otherwise cost one lookup per occurrence.
async function enrichHistorySample(history, limit) {
  const uniqueSkus = [...new Set(history.map((h) => h.sku).filter(Boolean))].slice(0, limit);
  const items = [];
  const authorCounts = new Map();
  const categoryCounts = new Map();

  await Promise.all(
    uniqueSkus.map(async (sku) => {
      const product = await getProductBySku(sku).catch(() => null);
      if (!product) return;
      const candidate = toCandidate(product);
      items.push(candidate);
      for (const a of candidate.authors) {
        authorCounts.set(a, (authorCounts.get(a) ?? 0) + 1);
      }
      for (const c of candidate.categories) {
        categoryCounts.set(c, (categoryCounts.get(c) ?? 0) + 1);
      }
    }),
  );

  return { items, authorCounts, categoryCounts };
}

async function buildCandidates(history, excludeSkus = [], { libraryOnly = false, round = 0 } = {}) {
  const excludeBaseSkus = new Set([
    ...history.map((h) => baseSku(h.sku)).filter(Boolean),
    ...excludeSkus.map(baseSku).filter(Boolean),
  ]);
  const excludeTitles = new Set(history.map((h) => normalizeTitle(h.name)));

  // Each repeat "get a new set" click bumps round, which widens both how much
  // history gets mined and how many ranked author/category terms get
  // searched. Without this, every round re-searches the exact same fixed top
  // terms and just filters out what was already shown — so a customer whose
  // top ~18 terms run dry hits "no more titles" even though their 19th+
  // favorite author (out of possibly hundreds of orders) was never searched.
  // Capped at 5x base so a long exclusion chain doesn't balloon into hundreds
  // of parallel requests against the live store on a single click.
  const roundFactor = Math.min(round + 1, 5);
  const enrichLimit = MAX_ENRICH * roundFactor;
  const searchTermLimit = MAX_SEARCH_TERMS * roundFactor;

  const { authorCounts, categoryCounts } = await enrichHistorySample(history, enrichLimit);

  const topAuthors = [...authorCounts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  const topCategories = [...categoryCounts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  const searchTerms = [...topAuthors, ...topCategories]
    .slice(0, searchTermLimit)
    .map(searchableTerm);

  if (searchTerms.length === 0) {
    return { candidates: [], searchTerms: [] };
  }

  const candidateMap = new Map();
  await Promise.all(
    searchTerms.map(async (term) => {
      const { products } = await searchProducts({ query: term, perPage: 10 }).catch(() => ({
        products: [],
      }));
      for (const product of products) {
        if (!product.is_in_stock) continue;
        // Some catalog entries are drafts/placeholders (e.g. a "(temp)" test
        // product) with no SKU set at all — not something staff can actually
        // check out or ring up, so they're not valid recommendations.
        if (!product.sku) continue;
        const sku = baseSku(product.sku);
        if (sku && excludeBaseSkus.has(sku)) continue;
        if (excludeTitles.has(normalizeTitle(product.name))) continue;
        if (!candidateMap.has(product.id)) {
          const candidate = toCandidate(product);
          if (libraryOnly && candidate.availability !== "for_borrow") continue;
          candidate._score =
            (candidate.authors.some((a) => topAuthors.includes(a)) ? 2 : 0) +
            candidate.categories.filter((c) => topCategories.includes(c)).length;
          candidateMap.set(product.id, candidate);
        }
      }
    }),
  );

  const candidates = [...candidateMap.values()]
    .sort((a, b) => b._score - a._score)
    .slice(0, MAX_CANDIDATES_TO_MODEL)
    .map(({ _score, ...c }) => c);

  return { candidates, searchTerms };
}

// A brand-new customer has no order history to derive search terms from —
// instead the search terms come directly from what staff typed in (topics,
// clue words). Always library-only per how this flow is meant to be used
// (staff handing a new visitor a book to borrow on the spot).
function splitTerms(...texts) {
  return [...new Set(
    texts
      .filter(Boolean)
      .join(",")
      .split(/[,;\n]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0),
  )];
}

// Best-effort match of a free-text age description ("взрослый", "6-8 лет",
// "12+") to one of the catalog's actual age-attribute terms, so results can
// be filtered by the store's real "Для взрослых" / "6+" / "3-6" bands
// instead of just handing the raw text to Claude as a hint.
function matchAgeTerm(ageText, terms) {
  if (!ageText || terms.length === 0) return null;
  const t = ageText.toLowerCase();
  if (/взросл|adult/.test(t)) return terms.find((x) => x.slug === "dlya-vzroslyh") ?? null;
  if (/малыш|самых маленьких|toddler/.test(t)) {
    return terms.find((x) => x.slug === "dlya-samyh-malenkih") ?? null;
  }

  const numMatch = t.match(/(\d+)/);
  if (!numMatch) return null;
  const n = parseInt(numMatch[1], 10);

  let bestRange = null; // tightest bounded range containing n
  let bestPlus = null; // highest "X+" threshold <= n
  for (const term of terms) {
    const range = term.name.match(/^(\d+)-(\d+)$/);
    if (range) {
      const [, lo, hi] = range.map(Number);
      if (n >= lo && n <= hi && (!bestRange || hi - lo < bestRange.hi - bestRange.lo)) {
        bestRange = { term, lo, hi };
      }
      continue;
    }
    const plus = term.name.match(/^(\d+)\+$/);
    if (plus) {
      const threshold = Number(plus[1]);
      if (threshold <= n && (!bestPlus || threshold > bestPlus.threshold)) {
        bestPlus = { term, threshold };
      }
    }
  }
  return (bestRange ?? bestPlus)?.term ?? null;
}

// A brand-new customer with no order history: thematic search is driven by
// the catalog's actual category taxonomy (e.g. topic "война" -> the real
// "Война" category, 52 products) rather than literal title/description text
// matching, which misses any book "about" a theme that doesn't name it in
// the title. Plain text search still runs as a supplementary source (catches
// specific series/character names that aren't modeled as a category), scored
// lower than a genuine category match. Always library-only, and filtered to
// the matched age band when the typed age description maps to one.
async function buildCandidatesFromProfile(excludeSkus, { age, topics, keywords }) {
  const excludeBaseSkus = new Set(excludeSkus.map(baseSku).filter(Boolean));
  const terms = splitTerms(topics, keywords);
  if (terms.length === 0) {
    return { candidates: [], searchTerms: [], matchedAgeTerm: null };
  }

  const ageTerms = await getAgeTerms().catch(() => []);
  const matchedAgeTerm = matchAgeTerm(age, ageTerms);
  const ageSlug = matchedAgeTerm?.slug;

  const candidateMap = new Map();
  function addCandidates(products, score) {
    for (const product of products) {
      if (!product.is_in_stock) continue;
      if (!product.sku) continue;
      const sku = baseSku(product.sku);
      if (sku && excludeBaseSkus.has(sku)) continue;
      const existing = candidateMap.get(product.id);
      if (existing) {
        existing._score += score;
        continue;
      }
      const candidate = toCandidate(product);
      if (candidate.availability !== "for_borrow") continue;
      candidate._score = score;
      candidateMap.set(product.id, candidate);
    }
  }

  // Primary: each term's matching catalog categories (thematic, not literal).
  await Promise.all(
    terms.map(async (term) => {
      const categories = await searchCategories(term).catch(() => []);
      for (const cat of categories.slice(0, 2)) {
        const { products } = await searchProductsInCategory({
          categoryId: cat.id,
          ageSlug,
          perPage: 15,
        }).catch(() => ({ products: [] }));
        addCandidates(products, 3);
      }
    }),
  );

  // Supplementary: literal text search, catches named series/characters that
  // aren't modeled as their own category.
  await Promise.all(
    terms.map(async (term) => {
      const { products } = await searchProducts({ query: term, perPage: 10 }).catch(() => ({
        products: [],
      }));
      addCandidates(products, 1);
    }),
  );

  const candidates = [...candidateMap.values()]
    .sort((a, b) => b._score - a._score)
    .slice(0, MAX_CANDIDATES_TO_MODEL)
    .map(({ _score, ...c }) => c);

  return { candidates, searchTerms: terms, matchedAgeTerm: matchedAgeTerm?.name ?? null };
}

// Shared by both flows: send candidates to Claude, then validate/backfill the
// response so the caller always gets back exactly targetCount real,
// in-stock, priced candidates rather than whatever Claude happened to return.
async function finalizeWithModel({ provider, apiKey, model, promptExtra, candidates, targetCount }) {
  const candidatesForModel = candidates.map((c) => ({
    title: c.title,
    sku: c.sku,
    authors: c.authors,
    categories: c.categories,
    ageGroup: c.ageGroup,
    availability: c.availability,
  }));

  const recommendations = await getRecommendations({
    provider,
    apiKey,
    model,
    candidates: candidatesForModel,
    count: targetCount,
    ...promptExtra,
  });

  // Belt-and-suspenders: the tool schema asks Claude for exactly targetCount
  // valid candidate SKUs, but tool-use schema constraints aren't a hard
  // guarantee, and models occasionally hallucinate a SKU that isn't actually
  // in the candidate list. Drop anything that doesn't match a real candidate,
  // then top up deterministically from the next best-scored candidates not
  // already picked, rather than showing fewer books than were actually
  // available (or a book with no real price/link).
  const bySku = new Map(candidates.map((c) => [c.sku, c]));
  let picked = recommendations.filter((r) => bySku.has(r.sku));

  if (picked.length < targetCount) {
    const chosenSkus = new Set(picked.map((r) => r.sku));
    for (const c of candidates) {
      if (picked.length >= targetCount) break;
      if (chosenSkus.has(c.sku)) continue;
      picked.push({
        title: c.title,
        sku: c.sku,
        availability: c.availability,
        reason: "Rounds out the set — matches this profile.",
      });
      chosenSkus.add(c.sku);
    }
  }

  return picked.map((r) => ({
    ...r,
    permalink: bySku.get(r.sku)?.permalink ?? null,
    price: bySku.get(r.sku)?.price ?? null,
    currency: bySku.get(r.sku)?.currency ?? null,
  }));
}

export async function recommendForCustomer({
  customer,
  provider,
  apiKey,
  model,
  excludeSkus = [],
  libraryOnly = false,
  round = 0,
}) {
  const history = await getRecentOrderHistory(customer.id);
  if (history.length === 0) {
    return { status: "no_history" };
  }

  const { candidates, searchTerms } = await buildCandidates(history, excludeSkus, { libraryOnly, round });
  if (candidates.length === 0) {
    return {
      status: "no_candidates",
      historyCount: history.length,
      searchTerms,
      message:
        excludeSkus.length > 0
          ? "No more in-stock titles found beyond what's already been suggested."
          : libraryOnly
            ? "No in-stock library (borrow) titles found matching this customer's profile."
            : undefined,
    };
  }

  const targetCount = Math.min(3, candidates.length);
  const historyForModel = history.map((h) => ({ name: h.name, sku: h.sku }));
  const enriched = await finalizeWithModel({
    provider,
    apiKey,
    model,
    promptExtra: { customerName: customer.name, history: historyForModel },
    candidates,
    targetCount,
  });

  return {
    status: "ok",
    historyCount: history.length,
    candidateCount: candidates.length,
    recommendations: enriched,
  };
}

// A short, staff-facing summary of what this customer likes to read, shown
// before they decide whether to ask for recommendations at all.
export async function profileCustomer({ customer, provider, apiKey, model }) {
  const history = await getRecentOrderHistory(customer.id);
  if (history.length === 0) {
    return { status: "no_history" };
  }

  const { items, authorCounts, categoryCounts } = await enrichHistorySample(history, MAX_ENRICH);
  const topAuthors = [...authorCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));
  const topCategories = [...categoryCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));

  const summary = await getCustomerSummary({
    provider,
    apiKey,
    model,
    customerName: customer.name,
    historyCount: history.length,
    sampleTitles: items.map((i) => ({
      title: i.title,
      authors: i.authors,
      categories: i.categories,
      ageGroup: i.ageGroup,
    })),
    topAuthors,
    topCategories,
  });

  return { status: "ok", historyCount: history.length, summary };
}

export async function recommendForProfile({ provider, apiKey, model, age, topics, keywords, excludeSkus = [] }) {
  const { candidates, searchTerms, matchedAgeTerm } = await buildCandidatesFromProfile(excludeSkus, {
    age,
    topics,
    keywords,
  });
  if (candidates.length === 0) {
    return {
      status: "no_candidates",
      searchTerms,
      message:
        excludeSkus.length > 0
          ? "No more in-stock library titles found beyond what's already been suggested."
          : "No in-stock library titles found matching that description — try broader topics or keywords.",
    };
  }

  const targetCount = Math.min(5, candidates.length);
  const enriched = await finalizeWithModel({
    provider,
    apiKey,
    model,
    promptExtra: { customerName: "a new customer", history: [], profile: { age, topics, keywords } },
    candidates,
    targetCount,
  });

  return {
    status: "ok",
    candidateCount: candidates.length,
    matchedAgeTerm,
    recommendations: enriched,
  };
}
