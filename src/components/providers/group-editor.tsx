import { CircleAlertIcon, PlusIcon, XIcon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import type { ApiKeyGroup } from '@/lib/types'
import { PairRows, SecretInput, TagInput } from './inputs'
import {
  fromDraft,
  groupTitle,
  isCompat,
  keyToDraft,
  PROVIDER_INFO,
  toDraft,
  useSaveGroups,
  validateDraft,
  type GroupDraft,
  type ProviderMeta,
} from './model'

export interface EditorTarget {
  open: boolean
  /** Index of the group being edited; null adds a new group. */
  index: number | null
  session: number
}

export function GroupEditor({
  meta,
  groups,
  target,
  onOpenChange,
}: {
  meta: ProviderMeta
  groups: ApiKeyGroup[]
  target: EditorTarget
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Sheet open={target.open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 data-[side=right]:sm:max-w-xl">
        <EditorBody key={target.session} meta={meta} groups={groups} index={target.index} onDone={() => onOpenChange(false)} />
      </SheetContent>
    </Sheet>
  )
}

function EditorBody({ meta, groups, index, onDone }: { meta: ProviderMeta; groups: ApiKeyGroup[]; index: number | null; onDone: () => void }) {
  const provider = meta.id
  const compat = isCompat(provider)
  const original = index == null ? undefined : groups[index]
  const [d, setD] = useState<GroupDraft>(() => toDraft(original, provider))
  const [error, setError] = useState<string | null>(null)
  const save = useSaveGroups(provider)
  const set = <K extends keyof GroupDraft>(k: K, v: GroupDraft[K]) => setD((prev) => ({ ...prev, [k]: v }))
  const required = PROVIDER_INFO[provider].baseUrlRequired

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const invalid = validateDraft(d, provider)
    if (invalid) return setError(invalid)
    if (compat && groups.some((g, i) => i !== index && g.name?.trim().toLowerCase() === d.name.trim().toLowerCase())) {
      return setError(`Another group is already named “${d.name.trim()}”.`)
    }
    const group = fromDraft(d, provider, original)
    const next = index == null ? [...groups, group] : groups.map((g, i) => (i === index ? group : g))
    setError(null)
    try {
      await save.mutateAsync(next)
      toast.success(index == null ? 'Group added' : 'Group saved', { description: groupTitle(group, meta, index ?? groups.length) })
      onDone()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const keysSection = (
    <Section
      title="API keys"
      description={
        compat ? 'Optional for endpoints without authentication. Weight applies under weighted round-robin.' : 'Each key is a separate credential in rotation. Weight applies under weighted round-robin.'
      }
    >
      <div className="space-y-2">
        {d.keys.length > 0 && (
          <div className="flex gap-2 text-xs text-muted-foreground">
            <span className="flex-1">Key</span>
            <span className="w-20">Weight</span>
            <span className="w-8" />
          </div>
        )}
        {d.keys.map((k) => (
          <div key={k.id} className="flex items-center gap-2">
            <SecretInput
              value={k.apiKey}
              placeholder="Paste API key"
              aria-label="API key"
              onChange={(v) => set('keys', d.keys.map((x) => (x.id === k.id ? { ...x, apiKey: v } : x)))}
            />
            <Input
              value={k.weight}
              inputMode="numeric"
              placeholder="1"
              aria-label="Weight"
              className="w-20 shrink-0 tabular"
              onChange={(e) => set('keys', d.keys.map((x) => (x.id === k.id ? { ...x, weight: e.target.value } : x)))}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-muted-foreground"
              aria-label="Remove key"
              onClick={() => set('keys', d.keys.filter((x) => x.id !== k.id))}
            >
              <XIcon />
            </Button>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={() => set('keys', [...d.keys, keyToDraft()])}>
          <PlusIcon />
          Add key
        </Button>
      </div>
    </Section>
  )

  const modelsSection = (
    <Section
      title={compat ? 'Models' : 'Model aliases'}
      description={
        compat
          ? 'Models this endpoint serves. Clients request the alias; leave it empty to expose the upstream name.'
          : 'Expose upstream models under another name. Clients request the alias.'
      }
    >
      <PairRows
        rows={d.models}
        onChange={(v) => set('models', v)}
        placeholders={['Upstream model', compat ? 'Alias (optional)' : 'Alias']}
        addLabel={compat ? 'Add model' : 'Add alias'}
        arrow
        mono
      />
    </Section>
  )

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
      <SheetHeader className="border-b pr-12">
        <SheetTitle>{original ? `Edit ${groupTitle(original, meta, index!)}` : `Add ${meta.name} group`}</SheetTitle>
        <SheetDescription>{PROVIDER_INFO[provider].description}</SheetDescription>
      </SheetHeader>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
        <Section title="Endpoint">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="g-name">Name{compat ? '' : ' (optional)'}</FieldLabel>
              <Input
                id="g-name"
                value={d.name}
                placeholder={compat ? 'openrouter' : 'e.g. team-a'}
                required={compat}
                autoFocus={!original}
                onChange={(e) => set('name', e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="g-prefix">Model prefix</FieldLabel>
              <Input id="g-prefix" value={d.prefix} placeholder="None" className="font-mono text-[13px]" onChange={(e) => set('prefix', e.target.value)} />
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="g-base">Base URL{required ? '' : ' (optional)'}</FieldLabel>
            <Input
              id="g-base"
              value={d.baseUrl}
              required={required}
              placeholder={meta.defaultBaseUrl || (compat ? 'https://openrouter.ai/api/v1' : 'Provider default')}
              className="font-mono text-[13px]"
              onChange={(e) => set('baseUrl', e.target.value)}
            />
            {!required && meta.defaultBaseUrl && <FieldDescription>Leave empty to use {meta.defaultBaseUrl}.</FieldDescription>}
          </Field>
          {compat && (
            <SwitchRow
              id="g-enabled"
              label="Enabled"
              description="Disabled endpoints stay in the config but receive no traffic."
              checked={!d.disabled}
              onChange={(v) => set('disabled', !v)}
            />
          )}
        </Section>

        <Separator />
        {compat ? modelsSection : keysSection}
        <Separator />
        {compat ? keysSection : modelsSection}

        {!compat && (
          <>
            <Separator />
            <Section title="Excluded models" description="Models this group never serves. Wildcards like gemini-*-preview are allowed.">
              <TagInput values={d.excluded} onChange={(v) => set('excluded', v)} placeholder="Type a model and press Enter" />
            </Section>
          </>
        )}

        <Separator />
        <Section title="Routing">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="g-priority">Priority</FieldLabel>
              <Input id="g-priority" value={d.priority} inputMode="numeric" placeholder="0" className="tabular" onChange={(e) => set('priority', e.target.value)} />
              <FieldDescription>Higher is preferred.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="g-retry">Request retry</FieldLabel>
              <Input id="g-retry" value={d.requestRetry} inputMode="numeric" placeholder="Global default" className="tabular" onChange={(e) => set('requestRetry', e.target.value)} />
              <FieldDescription>0 disables retries.</FieldDescription>
            </Field>
          </div>
          <SwitchRow
            id="g-cooling"
            label="Disable cooling"
            description="Keep using these keys after rate limits or errors instead of cooling them down."
            checked={d.disableCooling}
            onChange={(v) => set('disableCooling', v)}
          />
        </Section>

        <Separator />
        <Section title="Network">
          {!compat && (
            <Field>
              <FieldLabel htmlFor="g-proxy">Proxy URL</FieldLabel>
              <Input
                id="g-proxy"
                value={d.proxyUrl}
                placeholder="Global proxy"
                className="font-mono text-[13px]"
                onChange={(e) => set('proxyUrl', e.target.value)}
              />
              <FieldDescription>socks5://, http(s)://, or “direct” to bypass the global proxy.</FieldDescription>
            </Field>
          )}
          <Field>
            <FieldLabel>Extra headers</FieldLabel>
            <PairRows rows={d.headers} onChange={(v) => set('headers', v)} placeholders={['Header', 'Value']} addLabel="Add header" />
          </Field>
        </Section>
      </div>

      <SheetFooter className="border-t">
        {error && (
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertTitle>Could not save</AlertTitle>
            <AlertDescription className="break-words">{error}</AlertDescription>
          </Alert>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" disabled={save.isPending}>
            {save.isPending && <Spinner />}
            {original ? 'Save changes' : 'Add group'}
          </Button>
        </div>
      </SheetFooter>
    </form>
  )
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="space-y-0.5">
        <h3 className="text-sm font-medium">{title}</h3>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  )
}

function SwitchRow({
  id,
  label,
  description,
  checked,
  onChange,
}: {
  id: string
  label: string
  description: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border px-3 py-2.5">
      <div className="space-y-0.5">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}
