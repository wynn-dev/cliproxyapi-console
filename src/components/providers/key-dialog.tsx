import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import type { ApiKeyGroup } from '@/lib/types'
import { SecretInput } from './inputs'
import { draftToKey, fallbackNotSaved, groupTitle, isCompat, keyToDraft, useSaveGroups, useSyncFallback, type KeyDraft, type ProviderMeta } from './model'

export interface KeyTarget {
  open: boolean
  group: number
  /** Index of the key being edited; null adds a key. */
  key: number | null
  session: number
}

export function KeyDialog({
  meta,
  groups,
  target,
  isFallback,
  onOpenChange,
}: {
  meta: ProviderMeta
  groups: ApiKeyGroup[]
  target: KeyTarget
  /** The target group is a fallback, so a key added to it must be one too. */
  isFallback: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={target.open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <KeyForm key={target.session} meta={meta} groups={groups} target={target} isFallback={isFallback} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

function KeyForm({
  meta,
  groups,
  target,
  isFallback,
  onDone,
}: {
  meta: ProviderMeta
  groups: ApiKeyGroup[]
  target: KeyTarget
  isFallback: boolean
  onDone: () => void
}) {
  const group = groups[target.group]
  const original = target.key == null ? undefined : group?.keys[target.key]
  const [d, setD] = useState<KeyDraft>(() => keyToDraft(original))
  const [error, setError] = useState<string | null>(null)
  const save = useSaveGroups(meta.id)
  const fallback = useSyncFallback(meta.id)
  if (!group) return null
  const title = groupTitle(group, meta, target.group)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const apiKey = d.apiKey.trim()
    if (!apiKey) return setError('Enter an API key.')
    if (group.keys.some((k, i) => i !== target.key && k['api-key'] === apiKey)) return setError('This key is already in the group.')
    const w = d.weight.trim()
    if (w && !(/^\d+$/.test(w) && Number(w) >= 1 && Number(w) <= 1_000_000)) return setError('Weight must be a whole number between 1 and 1,000,000.')
    const entry = draftToKey(d)
    const keys = target.key == null ? [...group.keys, entry] : group.keys.map((k, i) => (i === target.key ? entry : k))
    setError(null)
    try {
      await save.mutateAsync(groups.map((g, i) => (i === target.group ? { ...g, keys } : g)))
    } catch (err) {
      return setError((err as Error).message)
    }
    toast.success(original ? 'Key saved' : 'Key added', { description: title })
    onDone()
    await fallback
      .sync({ keys: [apiKey], removed: original ? [original['api-key']] : [], on: isFallback, was: isFallback })
      .catch(fallbackNotSaved)
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{original ? 'Edit key' : 'Add key'}</DialogTitle>
        <DialogDescription>
          {meta.name} · {title}
        </DialogDescription>
      </DialogHeader>
      <Field>
        <FieldLabel htmlFor="k-key">API key</FieldLabel>
        <SecretInput id="k-key" value={d.apiKey} autoFocus placeholder="Paste API key" onChange={(v) => setD({ ...d, apiKey: v })} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-[6rem_1fr]">
        <Field>
          <FieldLabel htmlFor="k-weight">Weight</FieldLabel>
          <Input id="k-weight" value={d.weight} inputMode="numeric" placeholder="1" className="tabular" onChange={(e) => setD({ ...d, weight: e.target.value })} />
        </Field>
        <Field>
          <FieldLabel htmlFor="k-proxy">Proxy URL</FieldLabel>
          <Input
            id="k-proxy"
            value={d.proxyUrl}
            placeholder={isCompat(meta.id) ? 'Global proxy' : 'Group proxy'}
            className="font-mono text-[13px]"
            onChange={(e) => setD({ ...d, proxyUrl: e.target.value })}
          />
        </Field>
      </div>
      <FieldDescription>Weight applies under weighted round-robin routing.</FieldDescription>
      {error && <FieldError>{error}</FieldError>}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending && <Spinner />}
          {original ? 'Save' : 'Add key'}
        </Button>
      </DialogFooter>
    </form>
  )
}
