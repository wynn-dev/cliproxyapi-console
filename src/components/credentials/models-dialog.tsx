import { useQuery } from '@tanstack/react-query'
import { SearchIcon } from 'lucide-react'
import { useState } from 'react'
import { CopyButton } from '@/components/common'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { mgmt } from '@/lib/api'
import type { Credential, ModelEntry } from '@/lib/types'
import { accountName } from './lib'

export function ModelsDialog({ credential, onOpenChange }: { credential: Credential | null; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={!!credential} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">{credential && <ModelsBody credential={credential} />}</DialogContent>
    </Dialog>
  )
}

function ModelsBody({ credential }: { credential: Credential }) {
  const [search, setSearch] = useState('')
  const { data, isLoading, error } = useQuery({
    queryKey: ['mgmt', 'credentials', 'models', credential.name],
    queryFn: () => mgmt<{ models: ModelEntry[] }>('/credentials/models', { query: { name: credential.name } }),
  })
  const models = data?.models ?? []
  const q = search.trim().toLowerCase()
  const shown = q ? models.filter((m) => m.id.toLowerCase().includes(q) || m.display_name?.toLowerCase().includes(q)) : models

  return (
    <>
      <DialogHeader>
        <DialogTitle>Models</DialogTitle>
        <DialogDescription>
          Available through {accountName(credential)}
          {data && ` · ${models.length} model${models.length === 1 ? '' : 's'}`}
        </DialogDescription>
      </DialogHeader>
      <InputGroup>
        <InputGroupAddon>
          <SearchIcon />
        </InputGroupAddon>
        <InputGroupInput autoFocus placeholder="Filter models" value={search} onChange={(e) => setSearch(e.target.value)} />
      </InputGroup>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : (
        <ScrollArea className="-mx-4 h-[min(26rem,60vh)]">
          <ul className="px-2">
            {isLoading &&
              Array.from({ length: 6 }, (_, i) => (
                <li key={i} className="px-2 py-2">
                  <Skeleton className="h-9 w-full" />
                </li>
              ))}
            {shown.map((m) => (
              <li key={m.id} className="group flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/50">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[13px]">{m.id}</div>
                  {m.display_name && m.display_name !== m.id && <div className="truncate text-xs text-muted-foreground">{m.display_name}</div>}
                </div>
                {m.type && <span className="shrink-0 text-xs text-muted-foreground">{m.type}</span>}
                <CopyButton value={m.id} label="Copy model ID" className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" />
              </li>
            ))}
            {data && !shown.length && (
              <li className="px-2 py-8 text-center text-sm text-muted-foreground">{models.length ? 'No models match.' : 'No models reported.'}</li>
            )}
          </ul>
        </ScrollArea>
      )}
    </>
  )
}
