// Dispatches to the selected model provider. Both provider modules export
// the same getRecommendations/getCustomerSummary signatures, so this file is
// the only place that needs to know provider selection exists.
import * as anthropic from "./providers/anthropic.js";
import * as openai from "./providers/openai.js";

const PROVIDERS = { anthropic, openai };

export function isValidProvider(provider) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, provider);
}

export function providerLabel(provider) {
  return PROVIDERS[provider]?.LABEL ?? anthropic.LABEL;
}

export function defaultModelFor(provider) {
  return (PROVIDERS[provider] ?? anthropic).DEFAULT_MODEL;
}

export async function getRecommendations({ provider = "anthropic", ...rest }) {
  const impl = PROVIDERS[provider] ?? anthropic;
  return impl.getRecommendations(rest);
}

export async function getCustomerSummary({ provider = "anthropic", ...rest }) {
  const impl = PROVIDERS[provider] ?? anthropic;
  return impl.getCustomerSummary(rest);
}
