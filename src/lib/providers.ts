/** OAuth providers supported by `GET /oauth/auth-url?provider=`. */
export const OAUTH_PROVIDERS = [
  { id: 'claude', name: 'Claude', description: 'Anthropic Claude subscription' },
  { id: 'codex', name: 'Codex', description: 'ChatGPT / OpenAI Codex' },
  { id: 'antigravity', name: 'Antigravity', description: 'Google Antigravity' },
  { id: 'xai', name: 'Grok', description: 'xAI Grok (device code)' },
  { id: 'kimi', name: 'Kimi', description: 'Moonshot Kimi (device code)' },
  { id: 'kimi-ai', name: 'Kimi AI', description: 'kimi.ai (device code)' },
  { id: 'devin', name: 'Devin', description: 'Cognition Devin' },
  { id: 'meta', name: 'Meta', description: 'Meta AI (device code)' },
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
  'gemini-cli': 'Gemini CLI',
  gemini: 'Gemini',
  antigravity: 'Antigravity',
  vertex: 'Vertex',
  aistudio: 'AI Studio',
  kimi: 'Kimi',
  'kimi-ai': 'Kimi AI',
  xai: 'Grok',
  devin: 'Devin',
  meta: 'Meta',
  'openai-compatibility': 'OpenAI compatible',
  interactions: 'Interactions',
}

export const providerLabel = (id: string) => LABELS[id] ?? id
