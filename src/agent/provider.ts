// Pemilih penyedia model agen (ADR-0047): Claude API sebagai bawaan, atau OpenRouter bila `AGENT_PROVIDER=openrouter`.
// Hanya satu penyedia yang dipakai; bila penyedia itu gagal, agen menjawab sibuk dan tidak pindah ke penyedia lain.
import type { Env } from "../config/env.js";
import { anthropicModel, type AnthropicLog } from "./anthropic.js";
import type { AgentModel } from "./model.js";
import { DEFAULT_MODELS, openRouterModel, type RequestBudget } from "./openrouter.js";

type Deps = { fetch?: typeof fetch; budget?: RequestBudget; log?: AnthropicLog };

/**
 * Model agen dari environment. Claude tanpa `ANTHROPIC_API_KEY` tetap dibuat dan menjawab sibuk `belum_diatur`;
 * OpenRouter tanpa `OPENROUTER_API_KEY` tidak dibuat, dan route menjawab sibuk.
 */
export function agentModel(env: Env, { fetch, budget, log }: Deps): AgentModel | undefined {
  if (env.AGENT_PROVIDER === "openrouter") {
    if (!env.OPENROUTER_API_KEY) return undefined;
    return openRouterModel({ apiKey: env.OPENROUTER_API_KEY, models: env.OPENROUTER_MODELS.length > 0 ? env.OPENROUTER_MODELS : DEFAULT_MODELS, fetch, budget, log });
  }
  return anthropicModel({ apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL, effort: env.ANTHROPIC_EFFORT, fetch, budget, log });
}
