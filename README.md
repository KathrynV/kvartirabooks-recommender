# Book Recommender (kvartirabooks.org)

Internal tool: looks up a customer's live order/borrow history on
kvartirabooks.org (via the same WooCommerce APIs the `kvartirabooks-mcp`
project uses) and recommends 3 in-stock titles they haven't already
bought or borrowed.

## How it works

1. You enter a customer's name, email, or phone, plus an Anthropic API key.
2. The server resolves the customer via WooCommerce's Customers API and
   pulls their recent order history (line item **name + SKU only** — no
   addresses, totals, or dates are sent onward).
3. It enriches a sample of those titles against the public catalog to learn
   the customer's favorite authors/categories, then searches the live
   catalog for in-stock candidates the customer hasn't already had.
4. Claude (using the API key you supplied) picks 3 of those candidates and
   justifies each pick.

## Setup

```bash
cp .env.example .env
# fill in WC_CONSUMER_KEY / WC_CONSUMER_SECRET
# (WooCommerce Admin -> Settings -> Advanced -> REST API -> Add key, Read permission)
npm start
```

Open http://localhost:3000.

## Security notes

- The Anthropic API key is submitted per-request from the form and used only
  to make that one call — it is never written to disk, logged, or stored.
- The WooCommerce credentials live server-side in `.env` (gitignored) and are
  never sent to the browser.
- `search_customers`/order history expose customer PII. This app has **no
  login/auth layer** — run it locally or behind your own auth before
  exposing it beyond trusted staff.
