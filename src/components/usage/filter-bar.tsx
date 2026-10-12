import { ChevronDownIcon, XIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { maskSecret } from '@/lib/format'
import { providerLabel } from '@/lib/providers'
import type { UsageFacets } from '@/lib/types'
import { cn } from '@/lib/utils'
import type { CredentialLabels } from './cells'
import { DEFAULT_RANGE, type FilterKey, RANGES, type RangeKey, hasFilters, keySuffix, usageRoute } from './search'

interface Option {
  value: string
  label: React.ReactNode
  /** Plain text used for search and chips. */
  text: string
  hint?: string
}

function useOptions(facets: UsageFacets | undefined, labels: CredentialLabels): Record<FilterKey, Option[]> {
  const f = facets ?? { models: [], providers: [], credentials: [], apiKeys: [] }
  return {
    model: f.models.map((m) => ({ value: m, text: m, label: <span className="font-mono text-[13px]">{m}</span> })),
    provider: f.providers.map((p) => ({ value: p, text: providerLabel(p), label: providerLabel(p) })),
    credential: f.credentials.map((a) => {
      const l = labels.get(a)
      return {
        value: a,
        text: l?.label ?? a,
        hint: l ? providerLabel(l.provider) : 'Unknown credential',
        label: l ? l.label : <span className="font-mono text-[13px]">{a}</span>,
      }
    }),
    key: f.apiKeys.map((k) => ({
      value: keySuffix(k),
      text: maskSecret(k),
      label: <span className="font-mono text-[13px]">{maskSecret(k)}</span>,
    })),
    status: [
      { value: 'ok', text: 'Succeeded', label: 'Succeeded' },
      { value: 'failed', text: 'Failed', label: 'Failed', hint: 'Incl. turned away' },
      { value: 'turned_away', text: 'Turned away', label: 'Turned away' },
    ],
  }
}

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'model', label: 'Model' },
  { key: 'provider', label: 'Provider' },
  { key: 'credential', label: 'Credential' },
  { key: 'key', label: 'Client key' },
  { key: 'status', label: 'Status' },
]

export function UsageFilterBar({ facets, labels }: { facets?: UsageFacets; labels: CredentialLabels }) {
  const search = usageRoute.useSearch()
  const navigate = usageRoute.useNavigate()
  const options = useOptions(facets, labels)
  const range = search.range ?? DEFAULT_RANGE

  const set = (patch: Partial<typeof search>) => navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })

  // Chips use the option text when the value is in range; otherwise fall back to the raw value.
  const chipText = (key: FilterKey, value: string) => {
    const opt = options[key].find((o) => o.value === value)
    if (opt) return opt.text
    if (key === 'key') return `…${value.slice(-4)}`
    if (key === 'credential') return labels.get(value)?.label ?? value
    if (key === 'provider') return providerLabel(value)
    return value
  }

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          spacing={0}
          value={range}
          onValueChange={(v) => v && set({ range: v === DEFAULT_RANGE ? undefined : (v as RangeKey) })}
          aria-label="Time range"
        >
          {Object.entries(RANGES).map(([k, r]) => (
            <ToggleGroupItem key={k} value={k} aria-label={r.label} className="px-3 tabular">
              {k}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Separator orientation="vertical" className="mx-1 h-5! max-sm:hidden" />
        {FILTERS.map((f) => (
          <FacetFilter
            key={f.key}
            label={f.label}
            value={search[f.key]}
            options={options[f.key]}
            searchable={f.key !== 'status'}
            onChange={(v) => set({ [f.key]: v })}
          />
        ))}
      </div>
      {hasFilters(search) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {FILTERS.filter((f) => search[f.key]).map((f) => (
            <span key={f.key} className="inline-flex h-6 max-w-72 items-center gap-1 rounded-full border bg-muted/50 pr-0.5 pl-2.5 text-xs">
              <span className="text-muted-foreground">{f.label}</span>
              <span className="truncate font-medium">{chipText(f.key, search[f.key]!)}</span>
              <Button variant="ghost" size="icon-xs" className="size-5 rounded-full" aria-label={`Remove ${f.label} filter`} onClick={() => set({ [f.key]: undefined })}>
                <XIcon />
              </Button>
            </span>
          ))}
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground"
            onClick={() => set({ model: undefined, provider: undefined, credential: undefined, key: undefined, status: undefined })}
          >
            Clear
          </Button>
        </div>
      )}
    </div>
  )
}

function FacetFilter({
  label,
  value,
  options,
  searchable,
  onChange,
}: {
  label: string
  value?: string
  options: Option[]
  searchable: boolean
  onChange: (v: string | undefined) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={cn(value && 'border-foreground/25 bg-muted')}>
          {label}
          {value && (
            <span className="size-1.5 rounded-full bg-foreground">
              <span className="sr-only">(active)</span>
            </span>
          )}
          <ChevronDownIcon className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command>
          {searchable && options.length > 5 && <CommandInput placeholder={`Search ${label.toLowerCase()}…`} />}
          <CommandList>
            <CommandEmpty>{options.length ? 'No matches' : 'Nothing in this range'}</CommandEmpty>
            <CommandGroup>
              {options.map((o) => (
                <CommandItem
                  key={o.value}
                  value={o.value}
                  keywords={[o.text, o.hint ?? '']}
                  data-checked={o.value === value}
                  onSelect={() => {
                    onChange(o.value === value ? undefined : o.value)
                    setOpen(false)
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  {o.hint && <span className="shrink-0 text-xs text-muted-foreground">{o.hint}</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
