const KEY_STORAGE = 'cpa-console.key'

export const auth = {
  get: () => localStorage.getItem(KEY_STORAGE) ?? undefined,
  set: (key: string) => localStorage.setItem(KEY_STORAGE, key),
  clear: () => localStorage.removeItem(KEY_STORAGE),
}

export class ApiError extends Error {
  status: number
  body: unknown
  constructor(status: number, message: string, body?: unknown) {
    super(message)
    this.status = status
    this.body = body
  }
}

type Body = BodyInit | object | unknown[] | number | boolean | null

interface RequestOptions {
  method?: string
  body?: Body
  query?: Record<string, string | number | boolean | undefined | null>
  headers?: Record<string, string>
  key?: string
  raw?: boolean
}

function errorMessage(body: unknown, status: number) {
  if (body && typeof body === 'object') {
    const b = body as { error?: string; message?: string }
    if (b.message && b.error) return `${b.message} (${b.error})`
    if (b.message || b.error) return (b.message || b.error)!
  }
  if (typeof body === 'string' && body.trim()) return body.trim()
  return `Request failed with HTTP ${status}`
}

export async function request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const url = new URL(path, window.location.origin)
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
  }
  const headers: Record<string, string> = { ...opts.headers }
  const key = opts.key ?? auth.get()
  if (key) headers.Authorization = `Bearer ${key}`

  let body: BodyInit | undefined
  const b = opts.body
  if (b instanceof FormData || b instanceof Blob || typeof b === 'string') {
    body = b
  } else if (b !== undefined) {
    body = JSON.stringify(b)
    headers['Content-Type'] = 'application/json'
  }

  const res = await fetch(url, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body })
  if (opts.raw && res.ok) return res as T
  const text = await res.text()
  let parsed: unknown = text
  if (res.headers.get('content-type')?.includes('json') && text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      /* keep text */
    }
  }
  if (!res.ok) {
    if (res.status === 401 && !opts.key) {
      auth.clear()
      window.dispatchEvent(new Event('cpa-console:logout'))
    }
    throw new ApiError(res.status, errorMessage(parsed, res.status), parsed)
  }
  return parsed as T
}

/** CLIProxyAPI v8 management API, proxied by the console server. */
export const mgmt = <T = unknown>(path: string, opts?: RequestOptions) => request<T>(`/v8/management${path}`, opts)

/** Console server API (process control, releases, usage history). */
export const consoleApi = <T = unknown>(path: string, opts?: RequestOptions) => request<T>(`/console/api${path}`, opts)

export async function download(path: string, filename: string) {
  const res = await mgmt<Response>(path, { raw: true })
  const blob = await res.blob()
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}
