import { ChevronsUpDownIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

export interface ProxyModel {
  id: string
  owned_by?: string
}

const OWNER_LABELS: Record<string, string> = { openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', xai: 'xAI', meta: 'Meta' }
const ownerLabel = (o: string) => OWNER_LABELS[o] ?? o.charAt(0).toUpperCase() + o.slice(1)

export function ModelPicker({
  models,
  value,
  onChange,
  disabled,
  className,
}: {
  models: ProxyModel[]
  value?: string
  onChange: (id: string) => void
  disabled?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const groups = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const m of models) {
      const owner = m.owned_by || 'other'
      map.set(owner, [...(map.get(owner) ?? []), m.id])
    }
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([owner, ids]) => ({ owner, ids: ids.sort((a, b) => a.localeCompare(b)) }))
  }, [models])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label="Model"
          disabled={disabled}
          className={cn('w-72 justify-between font-normal', className)}
        >
          <span className={cn('truncate font-mono text-[13px]', !value && 'text-muted-foreground')}>{value ?? 'Select a model'}</span>
          <ChevronsUpDownIcon className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) min-w-72 p-0" align="end">
        <Command>
          <CommandInput placeholder="Search models" />
          <CommandList>
            <CommandEmpty>No models found.</CommandEmpty>
            {groups.map((g) => (
              <CommandGroup key={g.owner} heading={ownerLabel(g.owner)}>
                {g.ids.map((id) => (
                  <CommandItem
                    key={id}
                    value={id}
                    data-checked={id === value}
                    className="font-mono text-[13px]"
                    onSelect={() => {
                      onChange(id)
                      setOpen(false)
                    }}
                  >
                    <span className="truncate">{id}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
