/**
 * Public API list prices, to show what the traffic served by subscription accounts would have cost
 * on the providers' APIs. Shared by the server and the SPA, so it imports nothing. Edit freely.
 *
 * Prices are USD per million tokens, from the official pricing pages on PRICES_AS_OF:
 * platform.claude.com/docs/en/about-claude/pricing and developers.openai.com/api/docs/pricing.
 * Models not listed here get no price rather than a guess.
 */
export const PRICES_AS_OF = '2026-10-12'

export type PriceProvider = 'anthropic' | 'openai'

/**
 * Per provider defaults, as multipliers of the input price. CPA reports cache writes without their
 * lifetime, so writes use the 5-minute price (Claude Code's default). Tiers: what the upstream said
 * it served the request with; Anthropic's Priority Tier has no list price, so it is left out.
 */
export const PROVIDER_DEFAULTS: Record<PriceProvider, { cacheRead: number; cacheWrite: number; tiers: Record<string, number> }> = {
  anthropic: { cacheRead: 0.1, cacheWrite: 1.25, tiers: { batch: 0.5 } },
  // OpenAI bills cache writes as plain input, except the models below that list a write price.
  openai: { cacheRead: 0.1, cacheWrite: 1, tiers: { flex: 0.5, batch: 0.5, priority: 2, fast: 2 } },
}

export interface ModelPrice {
  /** Matched against the model name, lowercased; the first match wins, so specific names come first. */
  match: RegExp
  label: string
  provider: PriceProvider
  input: number
  output: number
  /** Overrides PROVIDER_DEFAULTS, as multipliers of input. */
  cacheRead?: number
  cacheWrite?: number
  tiers?: Record<string, number>
  /** A request with more input tokens than `above` (cache included) is billed at these multipliers in full. */
  longContext?: { above: number; input: number; output: number }
  /** Not confirmed on an official pricing page on PRICES_AS_OF. */
  unverified?: boolean
  note?: string
}

/** A version prefix: `opus-5` matches `opus-5-high` and `opus-5-1m` but not `opus-5-5`. */
const v = (s: string) => new RegExp(`^${s}(?![-.]\\d+(?:$|[-.]))`)
const OPENAI_LONG = { above: 272_000, input: 2, output: 1.5 }

export const MODEL_PRICES: ModelPrice[] = [
  { match: v('claude-fable-5[-.]1'), label: 'Claude Fable 5.1', provider: 'anthropic', input: 10, output: 50, cacheRead: 0.025 },
  { match: v('claude-(fable-5|5-fable)'), label: 'Claude Fable 5', provider: 'anthropic', input: 10, output: 50 },
  { match: v('claude-opus-5[-.]5'), label: 'Claude Opus 5.5', provider: 'anthropic', input: 4, output: 20, cacheRead: 0.05 },
  { match: v('claude-opus-5'), label: 'Claude Opus 5', provider: 'anthropic', input: 5, output: 25 },
  { match: v('claude-opus-4[-.][5-8]'), label: 'Claude Opus 4.5–4.8', provider: 'anthropic', input: 5, output: 25 },
  { match: v('claude-opus-4([-.]1)?'), label: 'Claude Opus 4 and 4.1', provider: 'anthropic', input: 15, output: 75 },
  { match: v('claude-sonnet-5[-.]5'), label: 'Claude Sonnet 5.5', provider: 'anthropic', input: 2, output: 10, cacheRead: 0.05 },
  { match: v('claude-sonnet-5'), label: 'Claude Sonnet 5', provider: 'anthropic', input: 2, output: 10 },
  { match: v('claude-sonnet-4([-.][56])?'), label: 'Claude Sonnet 4–4.6', provider: 'anthropic', input: 3, output: 15 },
  {
    match: v('claude-haiku-5[-.]5'),
    label: 'Claude Haiku 5.5',
    provider: 'anthropic',
    input: 0.1,
    output: 0.5,
    longContext: { above: 100_000, input: 5, output: 5 },
  },
  { match: v('claude-haiku-4[-.]5'), label: 'Claude Haiku 4.5', provider: 'anthropic', input: 1, output: 5 },
  { match: v('claude-3[-.]5-haiku'), label: 'Claude Haiku 3.5', provider: 'anthropic', input: 0.8, output: 4 },

  { match: v('gpt-6-astra'), label: 'GPT-6 Astra', provider: 'openai', input: 10, output: 50, cacheWrite: 1.25, longContext: OPENAI_LONG },
  { match: v('gpt-6[-.]1-sol'), label: 'GPT-6.1 Sol', provider: 'openai', input: 2, output: 10, cacheRead: 0.05, cacheWrite: 1.25, longContext: OPENAI_LONG },
  { match: v('gpt-6-sol'), label: 'GPT-6 Sol', provider: 'openai', input: 2, output: 10, cacheWrite: 1.25, longContext: OPENAI_LONG },
  { match: v('gpt-6-luna'), label: 'GPT-6 Luna', provider: 'openai', input: 0.1, output: 0.5, cacheWrite: 1.25, longContext: OPENAI_LONG },
  {
    match: v('gpt-5[-.]6-sol'),
    label: 'GPT-5.6 Sol',
    provider: 'openai',
    input: 4,
    output: 20,
    cacheWrite: 1.25,
    longContext: OPENAI_LONG,
    note: 'Promotional price, at least until 2026-11-21',
  },
  { match: v('gpt-5[-.]6-terra'), label: 'GPT-5.6 Terra', provider: 'openai', input: 2, output: 12, cacheWrite: 1.25, longContext: OPENAI_LONG },
  { match: v('gpt-5[-.]6-luna'), label: 'GPT-5.6 Luna', provider: 'openai', input: 0.2, output: 1.2, cacheWrite: 1.25, longContext: OPENAI_LONG },
  {
    match: v('gpt-5[-.]5'),
    label: 'GPT-5.5',
    provider: 'openai',
    input: 5,
    output: 30,
    tiers: { flex: 0.5, batch: 0.5, priority: 2.5, fast: 2.5 },
    longContext: OPENAI_LONG,
  },
  { match: v('gpt-5[-.]4-mini'), label: 'GPT-5.4 mini', provider: 'openai', input: 0.75, output: 4.5 },
  { match: v('gpt-5[-.]4'), label: 'GPT-5.4', provider: 'openai', input: 2.5, output: 15, longContext: OPENAI_LONG },
  { match: v('gpt-5[-.][23]-codex'), label: 'GPT-5.2 and 5.3 Codex', provider: 'openai', input: 1.75, output: 14 },
  { match: v('gpt-5[-.]1-codex'), label: 'GPT-5.1 Codex', provider: 'openai', input: 1.25, output: 10, unverified: true },
]

export function priceFor(model: string) {
  // Dated snapshots (claude-haiku-4-5-20251001) cost the same as their family.
  const m = model.trim().toLowerCase().replace(/-\d{8}(?=$|-)/, '')
  return m ? MODEL_PRICES.find((p) => p.match.test(m)) : undefined
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

/**
 * What these tokens cost at list price, in USD, or undefined when the model has no price.
 * `band` is how many LONG_CONTEXT_STEPS the requests' input exceeded.
 */
export function apiValue(model: string, tier: string, t: PricedTokens, band = 0) {
  const p = priceFor(model)
  if (!p) return
  const d = PROVIDER_DEFAULTS[p.provider]
  const long = p.longContext && band > LONG_CONTEXT_STEPS.indexOf(p.longContext.above)
  const inMul = long ? p.longContext!.input : 1
  const outMul = long ? p.longContext!.output : 1
  const tierMul = (p.tiers ?? d.tiers)[tier.trim().toLowerCase()] ?? 1
  const input = t.uncached + t.cacheRead * (p.cacheRead ?? d.cacheRead) + t.cacheWrite * (p.cacheWrite ?? d.cacheWrite)
  return ((input * p.input * inMul + t.output * p.output * outMul) * tierMul) / 1e6
}
