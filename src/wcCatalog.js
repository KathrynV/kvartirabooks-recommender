// Public WooCommerce Store API (no auth) — product catalog search.
import { deriveAvailabilityFromSku } from "./availability.js";

const BASE_URL = "https://kvartirabooks.org/wp-json/wc/store/v1";

export async function searchProducts({ query, perPage = 10 }) {
  const url = new URL(`${BASE_URL}/products`);
  url.searchParams.set("search", query);
  url.searchParams.set("per_page", String(perPage));

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Catalog search failed: ${res.status} ${res.statusText}`);
  }
  const products = await res.json();
  const total = Number(res.headers.get("x-wp-total") ?? products.length);
  const totalPages = Number(res.headers.get("x-wp-totalpages") ?? 1);
  return { products, total, totalPages };
}

// Fuzzy-matches a theme/topic against the catalog's product category
// taxonomy (e.g. "война" -> the real "Война" category, 52 products) — this
// is what makes topic search thematic rather than a literal title/description
// text match, which misses any book "about" a theme that doesn't happen to
// name it in the title.
export async function searchCategories(query, perPage = 5) {
  const url = new URL(`${BASE_URL}/products/categories`);
  url.searchParams.set("search", query);
  url.searchParams.set("per_page", String(perPage));
  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Category search failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// Age/reading-level attribute (id 12, "pa_listener-age") terms — a small,
// static list (adult, toddler, and numeric bands like "6+"/"3-6"), so it's
// cached for the life of the process instead of re-fetched per request.
const AGE_ATTRIBUTE_ID = 12;
let ageTermsCache = null;

export async function getAgeTerms() {
  if (ageTermsCache) return ageTermsCache;
  const url = `${BASE_URL}/products/attributes/${AGE_ATTRIBUTE_ID}/terms?per_page=50`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Age terms lookup failed: ${res.status} ${res.statusText}`);
  }
  ageTermsCache = await res.json();
  return ageTermsCache;
}

export async function searchProductsInCategory({ categoryId, ageSlug, perPage = 15 }) {
  const url = new URL(`${BASE_URL}/products`);
  url.searchParams.set("category", String(categoryId));
  if (ageSlug) {
    url.searchParams.set("attributes[0][attribute]", "pa_listener-age");
    url.searchParams.set("attributes[0][slug][0]", ageSlug);
  }
  url.searchParams.set("per_page", String(perPage));
  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Category product search failed: ${res.status} ${res.statusText}`);
  }
  return { products: await res.json() };
}

export async function getProductBySku(sku) {
  const url = new URL(`${BASE_URL}/products`);
  url.searchParams.set("sku", sku);
  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Catalog SKU lookup failed: ${res.status} ${res.statusText}`);
  }
  const products = await res.json();
  return products[0] ?? null;
}

function findAttribute(product, taxonomy) {
  const attr = product.attributes.find((a) => a.taxonomy === taxonomy);
  return attr ? attr.terms.map((t) => t.name) : [];
}

export function deriveAvailability(product) {
  const tagSlugs = (product.tags || []).map((t) => t.slug);
  if (tagSlugs.includes("library")) return "for_borrow";
  if (tagSlugs.includes("books-for-sale")) return "for_sale";
  if (deriveAvailabilityFromSku(product.sku) === "for_borrow") return "for_borrow";
  if (product.is_purchasable) return "for_sale";
  return "unknown";
}

export function toCandidate(product) {
  const price = Number(product.prices?.price ?? 0);
  return {
    id: product.id,
    sku: product.sku,
    title: product.name,
    authors: findAttribute(product, "pa_writer"),
    categories: (product.categories || []).map((c) => c.name),
    ageGroup: findAttribute(product, "pa_listener-age")[0] ?? null,
    availability: deriveAvailability(product),
    inStock: product.is_in_stock,
    isPurchasable: product.is_purchasable,
    price: product.is_purchasable && price > 0 ? price / 100 : null,
    currency: product.is_purchasable ? product.prices?.currency_code ?? null : null,
    permalink: product.permalink,
  };
}
