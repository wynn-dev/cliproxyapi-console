import { useQuery } from '@tanstack/react-query'
import { ActivityIcon, ArrowUpCircleIcon } from 'lucide-react'
import { CopyButton } from '@/components/common'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { consoleApi } from '@/lib/api'

interface ConsoleLatest {
  current: string
  latest: string
  service: boolean
  command: string
}

const nightly = (v: string) => Number(v.match(/-nightly\.(\d+)$/)?.[1] ?? NaN)

/** Console version in the sidebar footer, with upgrade instructions when a newer nightly exists. */
export function ConsoleVersion({ version }: { version?: string }) {
  const { data } = useQuery({
    queryKey: ['console', 'latest'],
    queryFn: () => consoleApi<ConsoleLatest>('/console/latest'),
    staleTime: 30 * 60_000,
    retry: false,
  })
  // Development builds have no nightly number and never prompt.
  const outdated = data && nightly(data.latest) > nightly(data.current)

  const label = (
    <span className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
      <ActivityIcon className="size-3.5" />
      Console {version ?? ''}
    </span>
  )
  if (!outdated) return label

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-chart-1 hover:bg-sidebar-accent group-data-[collapsible=icon]:hidden">
          <ArrowUpCircleIcon className="size-3.5" />
          <span className="flex-1">Update available</span>
          <span className="text-muted-foreground">{data.latest.replace(/^.*-nightly\./, '#')}</span>
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Update CPA Console</DialogTitle>
          <DialogDescription>
            You're on {data.current}; the latest nightly is {data.latest}.{' '}
            {data.service
              ? 'Run this on the server. It reinstalls the service with the latest nightly and keeps your data and CLIProxyAPI settings.'
              : 'Stop the console, then run this on the server to start the latest nightly.'}
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-3 pr-10 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">
            {data.command}
          </pre>
          <CopyButton value={data.command} className="absolute top-1.5 right-1.5" />
        </div>
      </DialogContent>
    </Dialog>
  )
}
