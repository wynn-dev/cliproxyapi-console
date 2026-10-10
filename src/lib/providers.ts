/** OAuth providers supported by `GET /oauth/auth-url?provider=`. */
export const OAUTH_PROVIDERS = [
  { id: 'claude', name: 'Claude', description: 'Anthropic Claude subscription' },
  { id: 'codex', name: 'Codex', description: 'ChatGPT / OpenAI Codex' },
] as const

/** API-key provider sections under `api-keys` in the v8 config. */
export const API_KEY_PROVIDERS = [
  { id: 'gemini', name: 'Gemini', defaultBaseUrl: 'https://generativelanguage.googleapis.com' },
  { id: 'claude', name: 'Claude', defaultBaseUrl: 'https://api.anthropic.com' },
  { id: 'codex', name: 'Codex', defaultBaseUrl: 'https://api.openai.com/v1' },
  { id: 'openai-compatibility', name: 'OpenAI compatible', defaultBaseUrl: '' },
  { id: 'vertex', name: 'Vertex', defaultBaseUrl: '' },
  { id: 'xai', name: 'xAI', defaultBaseUrl: 'https://api.x.ai/v1' },
  { id: 'interactions', name: 'Gemini Interactions', defaultBaseUrl: '' },
  { id: 'meta', name: 'Meta', defaultBaseUrl: '' },
] as const

const LABELS: Record<string, string> = {
  claude: 'Claude',
  anthropic: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  vertex: 'Vertex',
  xai: 'Grok',
  meta: 'Meta',
  'openai-compatibility': 'OpenAI compatible',
  interactions: 'Interactions',
}

export const providerLabel = (id: string) => LABELS[id] ?? id
