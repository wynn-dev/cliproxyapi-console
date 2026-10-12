import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useConfigWrite } from '@/lib/queries'

/**
 * Field specs are keyed by dotted config path (e.g. `routing.retry.request-retry`).
 * Absent config values show the documented default and are only written when the user changes them.
 */
export type FieldSpec =
  | { kind: 'switch'; default: boolean }
  | { kind: 'select'; default: string }
  | { kind: 'number'; default: number; min?: number; max?: number }
  | { kind: 'text'; default?: string; validate?: (v: string) => string | undefined }

type Specs = Record<string, FieldSpec>
type Value = string | boolean

export function getPath(obj: unknown, path: string): unknown {
  let cur = obj
  for (const part of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

function inputValue(spec: FieldSpec, raw: unknown): Value {
  switch (spec.kind) {
    case 'switch':
      return typeof raw === 'boolean' ? raw : spec.default
    case 'select':
      return raw == null || raw === '' ? spec.default : String(raw)
    default:
      return raw == null ? '' : String(raw)
  }
}

function validate(spec: FieldSpec, v: Value): string | undefined {
  if (spec.kind === 'number' && v !== '') {
    const s = String(v).trim()
    if (!/^-?\d+$/.test(s)) return 'Enter a whole number'
    const n = Number(s)
    if (spec.min !== undefined && n < spec.min) return `Must be at least ${spec.min}`
    if (spec.max !== undefined && n > spec.max) return `Must be at most ${spec.max}`
  }
  if (spec.kind === 'text' && v !== '' && spec.validate) return spec.validate(String(v).trim())
  return undefined
}

export type SectionForm = ReturnType<typeof useSectionForm>

/** Saves a section's changed fields (cleared ones as '') somewhere other than CPA's config, and refreshes `source`. Toasts its own errors. */
export type Persist = (changes: Record<string, Value>) => Promise<unknown>

/** Edits fields of `source`, by default CPA's config. */
export function useSectionForm(specs: Specs, source: object | undefined, title: string, persist?: Persist) {
  const qc = useQueryClient()
  const write = useConfigWrite()
  const [draft, setDraft] = useState<Record<string, Value>>({})
  const [saving, setSaving] = useState(false)

  const original = (path: string) => inputValue(specs[path], getPath(source, path))
  const value = (path: string) => (path in draft ? draft[path] : original(path))
  const isDirty = (path: string) => path in draft && draft[path] !== original(path)
  const error = (path: string) => (isDirty(path) ? validate(specs[path], draft[path]) : undefined)
  const dirtyPaths = Object.keys(draft).filter(isDirty)
  const dirty = dirtyPaths.length > 0
  const valid = dirtyPaths.every((p) => !error(p))

  async function writeConfig() {
    // PATCH stores nulls, so only touched fields are sent; a cleared field is DELETEd to restore its default.
    const patches: Record<string, Record<string, unknown>> = {}
    const deletes: string[] = []
    for (const path of dirtyPaths) {
      const spec = specs[path]
      const v = draft[path]
      if (v === '') {
        deletes.push(path)
        continue
      }
      const parts = path.split('.')
      let node = (patches[parts[0]] ??= {})
      for (const part of parts.slice(1, -1)) node = (node[part] ??= {}) as Record<string, unknown>
      node[parts[parts.length - 1]] = spec.kind === 'number' ? Number(String(v).trim()) : typeof v === 'string' ? v.trim() : v
    }
    for (const [top, value] of Object.entries(patches)) {
      await write.mutateAsync({ path: `/${top}`, value, method: 'PATCH' })
    }
    for (const path of deletes) {
      await write.mutateAsync({ path: `/${path.replaceAll('.', '/')}`, value: undefined, method: 'DELETE' })
    }
    await qc.refetchQueries({ queryKey: ['mgmt', 'config'], exact: true })
  }

  async function save() {
    setSaving(true)
    try {
      if (persist) await persist(Object.fromEntries(dirtyPaths.map((p) => [p, draft[p]])))
      else await writeConfig()
      setDraft({})
      toast.success(`${title} saved`, persist ? undefined : { description: 'CLIProxyAPI reloads the change in about a second.' })
      return true
    } catch {
      return false // the write already toasts the error
    } finally {
      setSaving(false)
    }
  }

  return {
    specs,
    loaded: !!source,
    value,
    original,
    isDirty,
    error,
    dirty,
    dirtyPaths,
    valid,
    saving,
    set: (path: string, v: Value) => setDraft((d) => ({ ...d, [path]: v })),
    reset: () => setDraft({}),
    save,
  }
}

/** Reports a section's dirty state up to the page (for the nav indicator and leave guard). */
export function useReportDirty(id: string, dirty: boolean, onDirty: (id: string, dirty: boolean) => void) {
  useEffect(() => onDirty(id, dirty), [id, dirty, onDirty])
}
