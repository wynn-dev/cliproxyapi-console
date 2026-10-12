/**
 * Public API list prices, to show what the traffic served by subscription accounts would have cost
 * on the providers' APIs. Shared by the server and the SPA, so it imports nothing. Edit freely.
 *
 * Prices are USD per million tokens, from the official pricing pages on PRICES_AS_OF:
 * platform.claude.com/docs/en/about-claude/pricing, developers.openai.com/api/docs/pricing and, for
 * the Codex models not listed there, their pages under developers.openai.com/api/docs/models.
 * Models and service tiers not listed here get no price rather than a guess.
 */
export const PRICES_AS_OF = '2026-10-12'

export type PriceProvider = 'anthropic' | 'openai'

/**
 * Per provider defaults, as multipliers of the input price. CPA reports cache writes without their
 * lifetime, so writes use the 5-minute price (Claude Code's default).
 */
export const PROVIDER_DEFAULTS: Record<PriceProvider, { cacheRead: number; cacheWrite: number; tiers: Record<string, number> }> = {
  // Anthropic's Priority Tier has no list price, so a priority request gets none.
  anthropic: { cacheRead: 0.1, cacheWrite: 1.25, tiers: { batch: 0.5 } },
  // OpenAI bills cache writes as plain input, except the models below that list a write price.
  // Tier prices differ per model, so they are listed with each model.
  openai: { cacheRead: 0.1, cacheWrite: 1, tiers: {} },
}

/** Tier names that mean the standard price. Any other tier needs a multiplier below, or gets no price. */
const STANDARD_TIERS = new Set(['', 'default', 'auto', 'standard'])

export interface ModelPrice {
  /** Model names after normalizeModel. */
  models: string[]
  label: string
  provider: PriceProvider
  input: number
  output: number
  /** Overrides PROVIDER_DEFAULTS, as multipliers of input. */
  cacheRead?: number
  cacheWrite?: number
  /** Overrides PROVIDER_DEFAULTS: service tier → multiplier of the standard price. "priority" is OpenAI's old name for Fast. */
  tiers?: Record<string, number>
  /** A request with more input tokens than `above` (cache included) is billed at these multipliers in full. */
  longContext?: { above: number; input: number; output: number }
  note?: string
}

const OPENAI_LONG = { above: 272_000, input: 2, output: 1.5 }
const FLEX = { flex: 0.5, batch: 0.5 }
const FAST = { ...FLEX, fast: 2, priority: 2 }
const ULTRAFAST = { ...FAST, ultrafast: 6 }

export const MODEL_PRICES: ModelPrice[] = [
  { models: ['claude-fable-5.1', 'claude-mythos-5.1'], label: 'Claude Fable and Mythos 5.1', provider: 'anthropic', input: 10, output: 50, cacheRead: 0.025 },
  { models: ['claude-fable-5', 'claude-5-fable', 'claude-mythos-5'], label: 'Claude Fable and Mythos 5', provider: 'anthropic', input: 10, output: 50 },
  { models: ['claude-opus-5.5'], label: 'Claude Opus 5.5', provider: 'anthropic', input: 4, output: 20, cacheRead: 0.05 },
  { models: ['claude-opus-5', 'claude-opus-4.8', 'claude-opus-4.7', 'claude-opus-4.6', 'claude-opus-4.5'], label: 'Claude Opus 4.5–5', provider: 'anthropic', input: 5, output: 25 },
  { models: ['claude-opus-4.1', 'claude-opus-4'], label: 'Claude Opus 4 and 4.1', provider: 'anthropic', input: 15, output: 75 },
  { models: ['claude-sonnet-5.5'], label: 'Claude Sonnet 5.5', provider: 'anthropic', input: 2, output: 10, cacheRead: 0.05 },
  { models: ['claude-sonnet-5'], label: 'Claude Sonnet 5', provider: 'anthropic', input: 2, output: 10 },
  { models: ['claude-sonnet-4.6', 'claude-sonnet-4.5', 'claude-sonnet-4'], label: 'Claude Sonnet 4–4.6', provider: 'anthropic', input: 3, output: 15 },
  { models: ['claude-haiku-5.5'], label: 'Claude Haiku 5.5', provider: 'anthropic', input: 0.1, output: 0.5, longContext: { above: 100_000, input: 5, output: 5 } },
  { models: ['claude-haiku-4.5'], label: 'Claude Haiku 4.5', provider: 'anthropic', input: 1, output: 5 },
  { models: ['claude-3.5-haiku'], label: 'Claude Haiku 3.5', provider: 'anthropic', input: 0.8, output: 4 },

  { models: ['gpt-6-astra'], label: 'GPT-6 Astra', provider: 'openai', input: 10, output: 50, cacheWrite: 1.25, tiers: ULTRAFAST, longContext: OPENAI_LONG },
  { models: ['gpt-6.1-sol'], label: 'GPT-6.1 Sol', provider: 'openai', input: 2, output: 10, cacheRead: 0.05, cacheWrite: 1.25, tiers: ULTRAFAST, longContext: OPENAI_LONG },
  { models: ['gpt-6-sol'], label: 'GPT-6 Sol', provider: 'openai', input: 2, output: 10, cacheWrite: 1.25, tiers: FAST, longContext: OPENAI_LONG },
  { models: ['gpt-6-luna'], label: 'GPT-6 Luna', provider: 'openai', input: 0.1, output: 0.5, cacheWrite: 1.25, tiers: FAST, longContext: OPENAI_LONG },
  {
    models: ['gpt-5.6-sol'],
    label: 'GPT-5.6 Sol',
    provider: 'openai',
    input: 4,
    output: 20,
    cacheWrite: 1.25,
    tiers: FAST,
    longContext: OPENAI_LONG,
    note: 'Promotional price, at least until 2026-11-21',
  },
  { models: ['gpt-5.6-terra'], label: 'GPT-5.6 Terra', provider: 'openai', input: 2, output: 12, cacheWrite: 1.25, tiers: FAST, longContext: OPENAI_LONG },
  { models: ['gpt-5.6-luna'], label: 'GPT-5.6 Luna', provider: 'openai', input: 0.2, output: 1.2, cacheWrite: 1.25, tiers: FAST, longContext: OPENAI_LONG },
  { models: ['gpt-5.5'], label: 'GPT-5.5', provider: 'openai', input: 5, output: 30, tiers: { ...FLEX, fast: 2.5, priority: 2.5 }, longContext: OPENAI_LONG },
  // Pro models list no cached price, so cache reads count as input.
  { models: ['gpt-5.5-pro', 'gpt-5.4-pro'], label: 'GPT-5.4 and 5.5 Pro', provider: 'openai', input: 30, output: 180, cacheRead: 1, tiers: FLEX, longContext: OPENAI_LONG },
  { models: ['gpt-5.4'], label: 'GPT-5.4', provider: 'openai', input: 2.5, output: 15, tiers: FAST, longContext: OPENAI_LONG },
  { models: ['gpt-5.4-mini'], label: 'GPT-5.4 mini', provider: 'openai', input: 0.75, output: 4.5, tiers: FAST },
  { models: ['gpt-5.4-nano'], label: 'GPT-5.4 nano', provider: 'openai', input: 0.2, output: 1.25, tiers: FLEX },
  { models: ['gpt-5.2'], label: 'GPT-5.2', provider: 'openai', input: 1.75, output: 14, tiers: FAST },
  { models: ['gpt-5.2-pro'], label: 'GPT-5.2 Pro', provider: 'openai', input: 21, output: 168, cacheRead: 1, tiers: { batch: 0.5 } },
  { models: ['gpt-5.1', 'gpt-5'], label: 'GPT-5 and 5.1', provider: 'openai', input: 1.25, output: 10, tiers: FAST },
  { models: ['gpt-5-mini'], label: 'GPT-5 mini', provider: 'openai', input: 0.25, output: 2, tiers: { ...FLEX, fast: 1.8, priority: 1.8 } },
  { models: ['gpt-5-nano'], label: 'GPT-5 nano', provider: 'openai', input: 0.05, output: 0.4, tiers: FLEX },
  { models: ['gpt-5-pro'], label: 'GPT-5 Pro', provider: 'openai', input: 15, output: 120, cacheRead: 1, tiers: { batch: 0.5 } },
  { models: ['gpt-5.3-codex'], label: 'GPT-5.3 Codex', provider: 'openai', input: 1.75, output: 14, tiers: { fast: 2, priority: 2 } },
  { models: ['gpt-5.2-codex'], label: 'GPT-5.2 Codex', provider: 'openai', input: 1.75, output: 14 },
  { models: ['gpt-5.1-codex', 'gpt-5.1-codex-max', 'gpt-5-codex'], label: 'GPT-5 and 5.1 Codex', provider: 'openai', input: 1.25, output: 10 },
  { models: ['gpt-5.1-codex-mini'], label: 'GPT-5.1 Codex mini', provider: 'openai', input: 0.25, output: 2 },
  { models: ['codex-mini-latest'], label: 'Codex mini', provider: 'openai', input: 1.5, output: 6, cacheRead: 0.25 },
]

/**
 * The model's price-list name. Only variants known to cost the same as their model are folded in:
 * date stamps, reasoning effort ("-high", "(high)"), "-thinking" and "-1m". Versions are written
 * with dots ("claude-opus-4-5" → "claude-opus-4.5"). Anything else (-pro, -mini, -fast, ...) stays
 * part of the name, so it only gets a price if it is listed itself.
 */
export function normalizeModel(model: string) {
  let m = model.trim().toLowerCase().replace(/\s*\([a-z]+\)$/, '')
  m = m.replace(/-\d{8}(?=$|-)/, '').replace(/-\d{4}-\d{2}-\d{2}(?=$|-)/, '')
  // "-max" is also part of gpt-5.1-codex-max, a model of its own.
  const variant = /(?<!codex)-(minimal|none|low|medium|high|xhigh|max|thinking|1m)$/
  while (variant.test(m)) m = m.replace(variant, '')
  return m.replace(/(\d)-(\d+)(?=$|-)/g, '$1.$2')
}

const byName = new Map(MODEL_PRICES.flatMap((p) => p.models.map((m) => [m, p] as const)))

const seen = new Map<string, ModelPrice | undefined>()

/** Called for every record a usage summary reads, so names are only normalized once. */
export function priceFor(model: string) {
  if (!seen.has(model)) seen.set(model, byName.get(normalizeModel(model)))
  return seen.get(model)
}

/** Input sizes at which some model's price changes, ascending. Lets a query group requests by band. */
export const LONG_CONTEXT_STEPS = [...new Set(MODEL_PRICES.flatMap((p) => (p.longContext ? [p.longContext.above] : [])))].sort((a, b) => a - b)

export interface PricedTokens {
  /** Input not read from or written to the cache. */
  uncached: number
  cacheRead: number
  cacheWrite: number
  /** Output, reasoning included. */
  output: number
}

/** The multiplier for a service tier, or undefined when the tier has no list price for this model. */
export function tierMultiplier(p: ModelPrice, tier: string) {
  const t = tier.trim().toLowerCase()
  return STANDARD_TIERS.has(t) ? 1 : (p.tiers ?? PROVIDER_DEFAULTS[p.provider].tiers)[t]
}

/**
 * What these tokens cost at list price, in USD, or undefined when the model or its tier has no
 * price. `band` is how many LONG_CONTEXT_STEPS the requests' input exceeded.
 */
export function apiValue(model: string, tier: string, t: PricedTokens, band = 0) {
  const p = priceFor(model)
  const tierMul = p && tierMultiplier(p, tier)
  if (!p || tierMul === undefined) return
  const d = PROVIDER_DEFAULTS[p.provider]
  const long = p.longContext && band > LONG_CONTEXT_STEPS.indexOf(p.longContext.above)
  const inMul = long ? p.longContext!.input : 1
  const outMul = long ? p.longContext!.output : 1
  const input = t.uncached + t.cacheRead * (p.cacheRead ?? d.cacheRead) + t.cacheWrite * (p.cacheWrite ?? d.cacheWrite)
  return ((input * p.input * inMul + t.output * p.output * outMul) * tierMul) / 1e6
}
