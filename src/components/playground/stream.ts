import { auth } from '@/lib/api'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface Usage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  completion_tokens_details?: { reasoning_tokens?: number }
}

export interface StreamResult {
  ttftMs?: number
  totalMs: number
  usage?: Usage
  requestId?: string
  status?: number
  error?: string
  stopped?: boolean
}

interface Callbacks {
  onContent: (text: string) => void
  onReasoning: (text: string) => void
}

/** Extracts a readable message from OpenAI-, Claude- or CPA-shaped error bodies. */
function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const b = body as { error?: unknown; message?: unknown }
    if (typeof b.error === 'string') return typeof b.message === 'string' ? `${b.message} (${b.error})` : b.error
    if (b.error && typeof b.error === 'object') {
      const e = b.error as { message?: unknown; type?: unknown }
      if (typeof e.message === 'string') return e.message
      if (typeof e.type === 'string') return e.type
    }
    if (typeof b.message === 'string') return b.message
  }
  return fallback
}

function parseError(text: string, status: number) {
  try {
    return errorMessage(JSON.parse(text), text.trim() || `Request failed with HTTP ${status}`)
  } catch {
    return text.trim() || `Request failed with HTTP ${status}`
  }
}

/** CPA's X-CPA-TRACE-ID is `<yyyymmddhhmmss>-<auth index>-<request id>`. */
function requestIdFrom(headers: Headers) {
  const direct = headers.get('x-request-id')
  if (direct) return direct
  return /^\d{14}-[^-]+-(.+)$/.exec(headers.get('x-cpa-trace-id') ?? '')?.[1]
}

/** Streams an OpenAI chat completion through the console's /v1 proxy and reports timing. */
export async function streamChat(
  body: { model: string; messages: ChatMessage[] },
  signal: AbortSignal,
  cb: Callbacks,
): Promise<StreamResult> {
  const start = performance.now()
  let ttftMs: number | undefined
  let usage: Usage | undefined
  let requestId: string | undefined
  let error: string | undefined
  const firstToken = () => {
    ttftMs ??= performance.now() - start
  }

  // Returns true once the stream is finished ([DONE] or an in-band error).
  const handleLine = (line: string) => {
    if (!line.startsWith('data:')) return false
    const data = line.slice(5).trim()
    if (!data) return false
    if (data === '[DONE]') return true
    let chunk: {
      error?: unknown
      usage?: Usage | null
      choices?: { delta?: { content?: string | null; reasoning_content?: string | null } }[]
    }
    try {
      chunk = JSON.parse(data)
    } catch {
      return false
    }
    if (chunk.error) {
      error = errorMessage(chunk, 'The upstream returned an error')
      return true
    }
    const delta = chunk.choices?.[0]?.delta
    if (delta?.reasoning_content) {
      firstToken()
      cb.onReasoning(delta.reasoning_content)
    }
    if (delta?.content) {
      firstToken()
      cb.onContent(delta.content)
    }
    if (chunk.usage) usage = chunk.usage
    return false
  }

  try {
    const key = auth.get()
    const res = await fetch('/console/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }),
      signal,
    })
    requestId = requestIdFrom(res.headers)
    if (!res.ok || !res.body) {
      const text = await res.text()
      return { totalMs: performance.now() - start, requestId, status: res.status, error: parseError(text, res.status) }
    }

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
    let buf = ''
    let finished = false
    while (!finished) {
      const { value, done } = await reader.read()
      if (done) break
      buf += value
      let nl: number
      while (!finished && (nl = buf.indexOf('\n')) !== -1) {
        finished = handleLine(buf.slice(0, nl).replace(/\r$/, ''))
        buf = buf.slice(nl + 1)
      }
    }
    if (finished) await reader.cancel().catch(() => {})
    else if (buf) handleLine(buf)
  } catch (e) {
    if (signal.aborted) return { ttftMs, totalMs: performance.now() - start, usage, requestId, stopped: true }
    error = (e as Error).message
  }
  return { ttftMs, totalMs: performance.now() - start, usage, requestId, error }
}
