import {
  ArrowUpWideNarrowIcon,
  BanIcon,
  FileTextIcon,
  GlobeIcon,
  ListXIcon,
  PencilIcon,
  PlusIcon,
  ReplaceIcon,
  RotateCcwIcon,
  SnowflakeIcon,
  TagIcon,
  Trash2Icon,
} from 'lucide-react'
import { RequestSparkline, SecretText } from '@/components/common'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { fmtNumber } from '@/lib/format'
import type { ApiKeyGroup, ApiKeysStatus, ApiKeyUsage } from '@/lib/types'
import { FallbackBadge, KeyStats } from './key-stats'
import { ALL_MODELS, findKeyUsage, groupTitle, isCompat, isFallbackGroup, type ProviderMeta } from './model'

interface GroupCardProps {
  meta: ProviderMeta
  group: ApiKeyGroup
  index: number
  usage?: ApiKeyUsage
  /** Spend, credits and fallback state, by auth_index. */
  status?: ApiKeysStatus
  onEdit: () => void
  onDelete: () => void
  onAddKey: () => void
  onEditKey: (key: number) => void
  onDeleteKey: (key: number) => void
}

export function GroupCard({ meta, group, index, usage, status, onEdit, onDelete, onAddKey, onEditKey, onDeleteKey }: GroupCardProps) {
  const compat = isCompat(meta.id)
  const keys = group.keys ?? []
  const models = group.models ?? []
  const fallback = isFallbackGroup(group, status)
  // A fallback standing by excludes every model; that is the console's doing, shown by its badge.
  const excluded = (group['excluded-models'] ?? []).filter((m) => !fallback || m.trim() !== ALL_MODELS)
  const infos = keys.map((k) => (k.auth_index ? status?.keys[k.auth_index] : undefined))
  const headers = Object.keys(group.headers ?? {})
  const title = groupTitle(group, meta, index)

  return (
    <Card className={group.disabled ? 'opacity-75' : undefined}>
      <CardHeader>
        <CardTitle className="flex min-w-0 items-center gap-2">
          <span className="truncate">{title}</span>
          {fallback && (
            <FallbackBadge
              inRotation={!(group['excluded-models'] ?? []).some((m) => m.trim() === ALL_MODELS)}
              state={status?.fallback[meta.id]}
              outOfCredits={infos.length > 0 && infos.every((i) => i?.outOfCredits)}
              name={meta.name}
            />
          )}
          {group.disabled && (
            <Badge variant="destructive">
              <BanIcon />
              Disabled
            </Badge>
          )}
        </CardTitle>
        <CardDescription className="truncate font-mono text-xs">
          {group['base-url'] || (meta.defaultBaseUrl ? `${meta.defaultBaseUrl} (default)` : 'Provider default endpoint')}
        </CardDescription>
        <CardAction className="flex gap-1">
          <Button variant="outline" size="sm" onClick={onEdit}>
            <PencilIcon />
            Edit
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Delete group" onClick={onDelete}>
                <Trash2Icon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Delete group</TooltipContent>
          </Tooltip>
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-1.5 empty:hidden">
          {group.prefix && (
            <Chip icon={TagIcon} tip="Models are exposed as <prefix>/<model>">
              prefix <span className="font-mono">{group.prefix}</span>
            </Chip>
          )}
          {!fallback && group.priority != null && group.priority !== 0 && (
            <Chip icon={ArrowUpWideNarrowIcon} tip="Higher priority groups are preferred">
              priority {group.priority}
            </Chip>
          )}
          {group['proxy-url'] && (
            <Chip icon={GlobeIcon} tip={<span className="font-mono">{group['proxy-url']}</span>}>
              {group['proxy-url'] === 'direct' || group['proxy-url'] === 'none' ? 'No proxy' : 'Proxy'}
            </Chip>
          )}
          {models.length > 0 && (
            <Chip icon={ReplaceIcon} tip={<ModelList items={models.map((m) => (m.alias && m.alias !== m.name ? `${m.alias} → ${m.name}` : m.name))} />}>
              {models.length} {compat ? (models.length === 1 ? 'model' : 'models') : models.length === 1 ? 'alias' : 'aliases'}
            </Chip>
          )}
          {excluded.length > 0 && (
            <Chip icon={ListXIcon} tip={<ModelList items={excluded} />}>
              {excluded.length} excluded
            </Chip>
          )}
          {headers.length > 0 && (
            <Chip icon={FileTextIcon} tip={<ModelList items={headers} />}>
              {headers.length} {headers.length === 1 ? 'header' : 'headers'}
            </Chip>
          )}
          {group['disable-cooling'] === true && (
            <Chip icon={SnowflakeIcon} tip="Keys are not cooled down after errors">
              No cooling
            </Chip>
          )}
          {group['request-retry'] != null && (
            <Chip icon={RotateCcwIcon} tip="Retry rounds for failed requests">
              retry {group['request-retry']}
            </Chip>
          )}
        </div>

        {keys.length === 0 ? (
          <div className="rounded-lg border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
            {compat ? 'No API keys — requests are sent without authentication.' : 'No API keys — this group serves no traffic.'}
          </div>
        ) : (
          <ul className="divide-y rounded-lg border">
            {keys.map((k, i) => {
              const u = findKeyUsage(usage, meta.id, group, k['api-key'])
              const info = infos[i]
              return (
                <li key={`${i}-${k['api-key']}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-1.5 pr-1.5 pl-3">
                  <SecretText value={k['api-key']} className="min-w-0 flex-1" />
                  <div className="flex items-center gap-1.5">
                    {k.weight != null && (
                      <Badge variant="outline" className="tabular">
                        weight {k.weight}
                      </Badge>
                    )}
                    {k['proxy-url'] && (
                      <Chip icon={GlobeIcon} tip={<span className="font-mono">{k['proxy-url']}</span>}>
                        Proxy
                      </Chip>
                    )}
                  </div>
                  {u && u.success + u.failed > 0 ? (
                    <div className="flex items-center gap-3">
                      <RequestSparkline buckets={u.recent_requests} className="hidden sm:flex" />
                      <span className="w-28 text-right text-xs text-muted-foreground tabular">
                        {fmtNumber(u.success)} ok
                        {u.failed > 0 && <span className="text-critical"> · {fmtNumber(u.failed)} failed</span>}
                      </span>
                    </div>
                  ) : (
                    <span className="w-28 text-right text-xs text-muted-foreground">No requests yet</span>
                  )}
                  <div className="flex">
                    <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Edit key" onClick={() => onEditKey(i)}>
                      <PencilIcon />
                    </Button>
                    <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Delete key" onClick={() => onDeleteKey(i)}>
                      <Trash2Icon />
                    </Button>
                  </div>
                  {info && <KeyStats apiKey={k['api-key']} info={info} provider={meta.id} />}
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
      <CardFooter className="justify-between py-2">
        <span className="text-xs text-muted-foreground">
          {keys.length} {keys.length === 1 ? 'key' : 'keys'}
          {keys.length > 0 && ' · traffic since CLIProxyAPI started'}
        </span>
        <Button variant="ghost" size="sm" onClick={onAddKey}>
          <PlusIcon />
          Add key
        </Button>
      </CardFooter>
    </Card>
  )
}

function Chip({ icon: Icon, tip, children }: { icon: React.ComponentType; tip: React.ReactNode; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="secondary" className="cursor-default">
          <Icon />
          {children}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  )
}

function ModelList({ items }: { items: string[] }) {
  return (
    <ul className="max-w-xs space-y-0.5 font-mono">
      {items.slice(0, 12).map((m) => (
        <li key={m} className="truncate">
          {m}
        </li>
      ))}
      {items.length > 12 && <li className="font-sans opacity-70">+{items.length - 12} more</li>}
    </ul>
  )
}
