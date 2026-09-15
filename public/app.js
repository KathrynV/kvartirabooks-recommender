const chooserEl = document.getElementById("chooser");
const lookupForm = document.getElementById("lookup-form");
const profileForm = document.getElementById("profile-form");
const summaryCard = document.getElementById("customer-summary");
const summaryHeading = document.getElementById("summary-heading");
const summaryText = document.getElementById("summary-text");
const getRecsBtn = document.getElementById("get-recs-btn");
const statusEl = document.getElementById("status");
const disambigEl = document.getElementById("disambiguation");
const matchList = document.getElementById("match-list");
const resultsEl = document.getElementById("results");
const resultsHeading = document.getElementById("results-heading");
const resultsList = document.getElementById("results-list");
const lookupSubmitBtn = lookupForm.querySelector("button[type=submit]");
const profileSubmitBtn = profileForm.querySelector("button[type=submit]");

// Tracks the currently-resolved customer and everything already recommended
// to them this session, so re-clicking "Get recommendations" excludes prior
// picks instead of converging on the same 3 again. Reset whenever a "Get
// customer" lookup resolves to a different customer than before.
let existingSession = { customer: null, excludedSkus: [], libraryOnly: null, round: 0 };

// Same idea for the new-customer profile flow, keyed on the typed
// description instead of a resolved customer id.
let profileSession = { key: null, excludedSkus: [] };

function showView(view) {
  chooserEl.classList.toggle("hidden", view !== "chooser");
  lookupForm.classList.toggle("hidden", view !== "existing");
  profileForm.classList.toggle("hidden", view !== "profile");
  summaryCard.classList.add("hidden");
  existingSession = { customer: null, excludedSkus: [], libraryOnly: null, round: 0 };
  clearOutputs();
}

function showStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.remove("hidden");
  statusEl.classList.toggle("error", isError);
}

function clearOutputs() {
  statusEl.classList.add("hidden");
  disambigEl.classList.add("hidden");
  resultsEl.classList.add("hidden");
  matchList.innerHTML = "";
  resultsList.innerHTML = "";
}

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function renderResults(data, heading, isRepeat) {
  resultsHeading.textContent = heading;
  if (isRepeat) {
    resultsHeading.textContent += " — new set";
  }

  if (data.message) {
    showStatus(data.message);
  }

  for (const rec of data.recommendations) {
    const li = document.createElement("li");
    const availabilityLabel = rec.availability === "for_borrow" ? "borrow" : "buy";
    const price = rec.price ? ` · ${rec.price} ${rec.currency ?? ""}` : "";
    li.innerHTML = `
      <div class="title">${escapeHtml(rec.title)} <span class="meta">(${escapeHtml(rec.sku)} · ${availabilityLabel}${price})</span></div>
      <div class="reason">${escapeHtml(rec.reason)}</div>
    `;
    resultsList.appendChild(li);
  }
  resultsEl.classList.remove("hidden");
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

// ---- Existing customer flow: step 1, resolve + summarize ----

function renderDisambiguation(matches, query, apiKey) {
  showStatus("Multiple customers matched — pick one below.");
  for (const m of matches) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = `${m.name} — ${m.email}${m.phone ? " — " + m.phone : ""}`;
    btn.addEventListener("click", () => runLookup({ query, customerId: m.id, apiKey }));
    li.appendChild(btn);
    matchList.appendChild(li);
  }
  disambigEl.classList.remove("hidden");
}

async function runLookup(payload) {
  clearOutputs();
  summaryCard.classList.add("hidden");
  lookupSubmitBtn.disabled = true;
  showStatus("Looking up customer…");
  try {
    const data = await postJson("/api/customer-profile", payload);
    if (data.needsDisambiguation) {
      clearOutputs();
      renderDisambiguation(data.matches, payload.query, payload.apiKey);
      return;
    }
    clearOutputs();

    // A newly-resolved customer always starts a fresh exclusion list; a
    // "Get customer" re-click on the same person just refreshes the summary.
    if (existingSession.customer?.id !== data.customer.id) {
      existingSession = { customer: data.customer, excludedSkus: [], libraryOnly: null, round: 0 };
    }

    summaryHeading.textContent = `${data.customer.name} — ${data.customer.email}`;
    summaryText.textContent =
      data.summary || data.message || "No summary available for this customer.";
    summaryCard.classList.remove("hidden");
  } catch (err) {
    clearOutputs();
    showStatus(err.message, true);
  } finally {
    lookupSubmitBtn.disabled = false;
  }
}

lookupForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const query = document.getElementById("query").value.trim();
  const apiKey = document.getElementById("apiKey").value.trim();
  runLookup({ query, apiKey });
});

// ---- Existing customer flow: step 2, recommend ----

async function runExistingRecommend(payload) {
  const isRepeat = Boolean(payload.excludeSkus && payload.excludeSkus.length > 0);
  clearOutputs();
  getRecsBtn.disabled = true;
  showStatus(isRepeat ? "Finding another set of recommendations…" : "Building recommendations…");
  try {
    const data = await postJson("/api/recommend", payload);
    clearOutputs();

    existingSession.libraryOnly = payload.libraryOnly;
    existingSession.round = (payload.round ?? 0) + 1;
    for (const rec of data.recommendations) {
      if (!existingSession.excludedSkus.includes(rec.sku)) existingSession.excludedSkus.push(rec.sku);
    }

    if (data.recommendations.length === 0) {
      showStatus(data.message || "No recommendations available.");
    } else {
      let heading = `Recommendations for ${data.customer.name}`;
      if (typeof data.historyCount === "number") {
        heading += ` (${data.historyCount} past items on file)`;
      }
      renderResults(data, heading, isRepeat);
    }
  } catch (err) {
    clearOutputs();
    showStatus(err.message, true);
  } finally {
    getRecsBtn.disabled = false;
  }
}

getRecsBtn.addEventListener("click", () => {
  const apiKey = document.getElementById("apiKey").value.trim();
  const libraryOnly = document.getElementById("libraryOnly").checked;
  const customerId = existingSession.customer.id;

  // Same library-only setting as last time — ask for a new set, excluding
  // prior picks. Toggling it changes which candidates are even eligible, so
  // the old exclusion list no longer applies.
  if (existingSession.libraryOnly === libraryOnly && existingSession.round > 0) {
    runExistingRecommend({
      customerId,
      apiKey,
      excludeSkus: existingSession.excludedSkus,
      libraryOnly,
      round: existingSession.round,
    });
  } else {
    existingSession.excludedSkus = [];
    existingSession.round = 0;
    runExistingRecommend({ customerId, apiKey, libraryOnly, round: 0 });
  }
});

// ---- New customer (profile) flow ----

async function runProfileRecommend(payload) {
  const isRepeat = Boolean(payload.excludeSkus && payload.excludeSkus.length > 0);
  clearOutputs();
  profileSubmitBtn.disabled = true;
  showStatus(isRepeat ? "Finding another set of recommendations…" : "Building recommendations…");
  try {
    const data = await postJson("/api/recommend-profile", payload);
    clearOutputs();

    profileSession.key = payload.key;
    for (const rec of data.recommendations) {
      if (!profileSession.excludedSkus.includes(rec.sku)) profileSession.excludedSkus.push(rec.sku);
    }

    if (data.recommendations.length === 0) {
      showStatus(data.message || "No recommendations available.");
    } else {
      let heading = "Recommendations for a new customer";
      if (data.matchedAgeTerm) heading += ` (age band: ${data.matchedAgeTerm})`;
      renderResults(data, heading, isRepeat);
    }
  } catch (err) {
    clearOutputs();
    showStatus(err.message, true);
  } finally {
    profileSubmitBtn.disabled = false;
  }
}

profileForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const age = document.getElementById("age").value.trim();
  const topics = document.getElementById("topics").value.trim();
  const keywords = document.getElementById("keywords").value.trim();
  const apiKey = document.getElementById("profileApiKey").value.trim();
  const key = `${age}|${topics}|${keywords}`;

  if (!age && !topics && !keywords) {
    clearOutputs();
    showStatus("Fill in at least one of age, topics, or keywords.", true);
    return;
  }

  // Same description as last time — ask for a new set, excluding prior
  // picks. Any change to the description starts over with a fresh pool.
  if (key === profileSession.key) {
    runProfileRecommend({ age, topics, keywords, apiKey, key, excludeSkus: profileSession.excludedSkus });
  } else {
    profileSession = { key, excludedSkus: [] };
    runProfileRecommend({ age, topics, keywords, apiKey, key });
  }
});

// ---- View navigation ----

document.getElementById("choose-existing").addEventListener("click", () => showView("existing"));
document.getElementById("choose-new").addEventListener("click", () => showView("profile"));
for (const btn of document.querySelectorAll("[data-back]")) {
  btn.addEventListener("click", () => showView("chooser"));
}
