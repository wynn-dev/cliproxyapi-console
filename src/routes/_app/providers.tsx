import { useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { BlocksIcon, PlusIcon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/common'
import { confirm } from '@/components/confirm'
import { GroupCard } from '@/components/providers/group-card'
import { GroupEditor, type EditorTarget } from '@/components/providers/group-editor'
import { KeyDialog, type KeyTarget } from '@/components/providers/key-dialog'
import { apiKeyUsageQuery, groupsOf, groupTitle, PROVIDER_INFO, useSaveGroups, type ProviderMeta } from '@/components/providers/model'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { maskSecret } from '@/lib/format'
import { API_KEY_PROVIDERS } from '@/lib/providers'
import { queries } from '@/lib/queries'
import type { ApiKeyGroup, V8Config } from '@/lib/types'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/_app/providers')({
  validateSearch: (s: Record<string, unknown>): { provider?: string } => ({
    provider: typeof s.provider === 'string' ? s.provider : undefined,
  }),
  component: ProvidersPage,
})

function ProvidersPage() {
  const config = useQuery(queries.config())
  const { provider: selected } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })

  const firstConfigured = API_KEY_PROVIDERS.find((p) => groupsOf(config.data, p.id).length > 0)
  const meta = API_KEY_PROVIDERS.find((p) => p.id === selected) ?? firstConfigured ?? API_KEY_PROVIDERS[0]

  return (
    <>
      <PageHeader title="API providers" description="Upstream API keys, grouped by endpoint. Each key joins the rotation as its own credential." />
      {config.error ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load the configuration</AlertTitle>
          <AlertDescription>{config.error.message}</AlertDescription>
        </Alert>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
          <ProviderNav config={config.data} loading={config.isLoading} active={meta.id} onSelect={(id) => navigate({ search: { provider: id }, replace: true })} />
          {config.isLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-10 w-1/2" />
              <Skeleton className="h-48 w-full rounded-xl" />
            </div>
          ) : (
            <ProviderPanel key={meta.id} meta={meta} groups={groupsOf(config.data, meta.id)} />
          )}
        </div>
      )}
    </>
  )
}

function ProviderNav({
  config,
  loading,
  active,
  onSelect,
}: {
  config?: V8Config
  loading: boolean
  active: string
  onSelect: (id: string) => void
}) {
  return (
    <nav className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0" aria-label="Providers">
      {API_KEY_PROVIDERS.map((p) => {
        const groups = groupsOf(config, p.id)
        const keys = groups.reduce((n, g) => n + (g.keys?.length ?? 0), 0)
        const empty = groups.length === 0
        return (
          <button
            key={p.id}
            type="button"
            aria-current={p.id === active ? 'page' : undefined}
            onClick={() => onSelect(p.id)}
            className={cn(
              'flex shrink-0 flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-muted',
              p.id === active && 'bg-muted',
            )}
          >
            <span className={cn('font-medium', empty && p.id !== active && 'text-muted-foreground')}>{p.name}</span>
            <span className="text-xs text-muted-foreground tabular">
              {loading ? '…' : empty ? 'Not configured' : `${groups.length} ${groups.length === 1 ? 'group' : 'groups'} · ${keys} ${keys === 1 ? 'key' : 'keys'}`}
            </span>
          </button>
        )
      })}
    </nav>
  )
}

function ProviderPanel({ meta, groups }: { meta: ProviderMeta; groups: ApiKeyGroup[] }) {
  const usage = useQuery({ ...apiKeyUsageQuery(), enabled: groups.length > 0 })
  const save = useSaveGroups(meta.id)
  const [editor, setEditor] = useState<EditorTarget>({ open: false, index: null, session: 0 })
  const [keyTarget, setKeyTarget] = useState<KeyTarget>({ open: false, group: 0, key: null, session: 0 })
  const openEditor = (index: number | null) => setEditor((e) => ({ open: true, index, session: e.session + 1 }))
  const openKey = (group: number, key: number | null) => setKeyTarget((t) => ({ open: true, group, key, session: t.session + 1 }))

  const deleteGroup = (index: number) => {
    const g = groups[index]
    const n = g.keys?.length ?? 0
    confirm({
      title: `Delete “${groupTitle(g, meta, index)}”?`,
      description: `Removes this group${n ? ` and its ${n} ${n === 1 ? 'key' : 'keys'}` : ''} from the config. Requests routed to it start failing over to other credentials right away.`,
      confirmLabel: 'Delete group',
      destructive: true,
      onConfirm: () =>
        save
          .mutateAsync(groups.filter((_, i) => i !== index))
          .then(() => toast.success('Group deleted'))
          .catch((err: Error) => toast.error('Could not delete group', { description: err.message })),
    })
  }

  const deleteKey = (gi: number, ki: number) => {
    const g = groups[gi]
    const last = g.keys.length === 1
    confirm({
      title: `Delete key ${maskSecret(g.keys[ki]['api-key'])}?`,
      description: last
        ? 'This is the last key in the group. Without keys the group serves no authenticated traffic.'
        : `It is removed from ${groupTitle(g, meta, gi)}.`,
      confirmLabel: 'Delete key',
      destructive: true,
      onConfirm: () =>
        save
          .mutateAsync(groups.map((x, i) => (i === gi ? { ...x, keys: x.keys.filter((_, j) => j !== ki) } : x)))
          .then(() => toast.success('Key deleted'))
          .catch((err: Error) => toast.error('Could not delete key', { description: err.message })),
    })
  }

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-0.5">
          <h2 className="text-lg font-semibold tracking-tight">{meta.name}</h2>
          <p className="text-sm text-muted-foreground">{PROVIDER_INFO[meta.id].description}</p>
        </div>
        {groups.length > 0 && (
          <Button size="sm" onClick={() => openEditor(null)}>
            <PlusIcon />
            Add group
          </Button>
        )}
      </div>

      {groups.length === 0 ? (
        <Empty className="border py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BlocksIcon />
            </EmptyMedia>
            <EmptyTitle>No {meta.name} keys yet</EmptyTitle>
            <EmptyDescription>
              A group holds one endpoint and its shared settings; add as many keys to it as you like.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" onClick={() => openEditor(null)}>
              <PlusIcon />
              Add group
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        groups.map((g, i) => (
          <GroupCard
            key={i}
            meta={meta}
            group={g}
            index={i}
            usage={usage.data}
            onEdit={() => openEditor(i)}
            onDelete={() => deleteGroup(i)}
            onAddKey={() => openKey(i, null)}
            onEditKey={(k) => openKey(i, k)}
            onDeleteKey={(k) => deleteKey(i, k)}
          />
        ))
      )}

      <GroupEditor meta={meta} groups={groups} target={editor} onOpenChange={(open) => setEditor((e) => ({ ...e, open }))} />
      <KeyDialog meta={meta} groups={groups} target={keyTarget} onOpenChange={(open) => setKeyTarget((t) => ({ ...t, open }))} />
    </div>
  )
}
