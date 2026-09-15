# Book Recommender — Project Overview

## Goal
An internal tool for the kvartirabooks.org bookstore/lending library staff. It suggests specific books to hand or recommend to a customer, using the store's real, live data — no manual file exports, no guesswork.

It supports two situations:
1. **A customer the store already knows** — someone with a purchase/borrow history on file.
2. **A brand-new customer** — someone staff are meeting for the first time, with no history at all.

## How it works

### Existing customer (two steps)
1. Staff type in the customer's **name, email, or phone number**, plus an **Anthropic API key** (needed because the recommendation-writing is done by Claude, Anthropic's AI). Click **"Get customer."**
   - The app looks the customer up in the store's real customer database. If more than one person matches, it shows a list to pick from.
2. Once the right customer is found, the app pulls their **real order and borrowing history** from the store and shows a **short written summary** of what they tend to read — favorite authors, recurring themes, reading level — written in plain sentences, based on actual evidence from their history (not guesses).
   - Staff then click **"Get recommendations"** to get **3 specific in-stock books** the customer hasn't already bought or borrowed, each with a one-sentence reason tied to their history. There's a checkbox to restrict this to **library (borrowable) copies only**, instead of also suggesting books for sale.
   - Clicking "Get recommendations" again gives a genuinely **different set of 3**, not the same ones repeated — it remembers what it already showed this customer and searches further for the next batch.

### New customer
1. Staff describe the customer instead of looking them up: their **age/reading level**, **preferred topics**, and any **clue words** (things they mentioned liking), plus an API key. Click **"Get recommendations."**
2. The app searches the store's live catalog **by theme/subject** (not just literal title-word matching — a request for books "about war" finds books that are actually about war, even if the word "war" isn't in the title), filtered to the right age group when one is given, and always to **library (borrowable) copies**.
3. Result: **5 specific in-stock library books** matching the description, each with a reason.

## What "the result" looks like
Either way, the end output is a short list of real, specific books: title, catalog code (SKU), whether it's a library copy or for sale, and a one-sentence reason it fits this customer — pulled from what's actually on the shelf right now, not a generic suggestion.

## A few things worth knowing
- The Anthropic API key is only used for the one request you're making — it's never saved, stored, or logged anywhere.
- Everything (customer records, order history) comes live from the real store database at the moment you ask — never a stale export.
- This is an **internal staff tool** — customer names, emails, and order history are private information, so it isn't meant to be given out to customers or the public.

---

If you want changes, you can edit this description directly — cross out or rewrite whatever's wrong, add notes for what you want different — and paste it back to a Claude session as instructions for what to build next.
