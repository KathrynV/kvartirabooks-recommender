// Borrow copies are always SKU'd with a "-L" suffix; the for-sale copy of
// the same title uses the bare ISBN. This is the only signal order line
// items carry (they don't include product tags).
export function deriveAvailabilityFromSku(sku) {
  if (!sku) return "unknown";
  return sku.endsWith("-L") ? "for_borrow" : "for_sale";
}

// Strips the "-L" suffix so a for-sale and for-borrow copy of the same
// title compare equal for "has this customer already had this book" checks.
export function baseSku(sku) {
  if (!sku) return null;
  return sku.endsWith("-L") ? sku.slice(0, -2) : sku;
}

export function normalizeTitle(title) {
  return (title || "").trim().toLowerCase();
}
