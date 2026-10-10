import { useQuery } from '@tanstack/react-query'
import { DownloadIcon, FileTextIcon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ApiError, download, mgmt } from '@/lib/api'
import { fmtAgo, fmtBytes, fmtDateTime } from '@/lib/format'
import { queries, useConfigWrite } from '@/lib/queries'
import type { ErrorLogFile } from '@/lib/types'

export function RequestLogs() {
  const config = useQuery(queries.config())
  const write = useConfigWrite()
  const enabled = !!config.data?.observability?.logs?.['request-log']
  const pendingValue = write.isPending ? (write.variables?.value as boolean) : undefined
  const [id, setId] = useState('')
  const [fetching, setFetching] = useState(false)

  const lookup = async (e: React.FormEvent) => {
    e.preventDefault()
    const rid = id.trim()
    if (!rid) return
    setFetching(true)
    try {
      await download(`/observability/logs/requests/${encodeURIComponent(rid)}`, `request-${rid.slice(-8)}.log`)
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        toast.error('No log for that request', {
          description: 'Request logs only exist for requests made while request logging was on.',
        })
      } else {
        toast.error('Could not download request log', { description: (err as Error).message })
      }
    } finally {
      setFetching(false)
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Request logs</CardTitle>
          <CardDescription>Full request and response bodies, one file per request.</CardDescription>
          <CardAction>
            {config.isLoading ? (
              <Skeleton className="h-5 w-24" />
            ) : (
              <div className="flex items-center gap-2">
                <Label htmlFor="request-log" className="font-normal text-muted-foreground">
                  {(pendingValue ?? enabled) ? 'On' : 'Off'}
                </Label>
                <Switch
                  id="request-log"
                  checked={pendingValue ?? enabled}
                  disabled={write.isPending || !config.data}
                  onCheckedChange={(v) =>
                    write.mutate(
                      { path: '/observability/logs/request-log', value: v },
                      { onSuccess: () => toast.success(v ? 'Request logging on' : 'Request logging off') },
                    )
                  }
                />
              </div>
            )}
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            When <code className="font-mono text-[13px] text-foreground">observability.logs.request-log</code> is on, CLIProxyAPI writes
            every proxied request with its upstream calls and response. Logs contain prompts and completions and grow quickly, so turn it on
            while debugging and off again afterwards.
          </p>
          <form onSubmit={lookup} className="space-y-2">
            <Label htmlFor="request-id">Request ID</Label>
            <div className="flex gap-2">
              <Input
                id="request-id"
                value={id}
                onChange={(e) => setId(e.target.value)}
                placeholder="Full ID or its last 8 characters"
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
              />
              <Button type="submit" variant="outline" disabled={!id.trim() || fetching}>
                {fetching ? <Spinner /> : <DownloadIcon />}
                Download
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              The 8-character ID is shown next to each line in the application log.
            </p>
          </form>
        </CardContent>
      </Card>
      <ErrorLogs requestLogOn={enabled} />
    </div>
  )
}

function ErrorLogs({ requestLogOn }: { requestLogOn: boolean }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['mgmt', 'logs', 'errors'],
    queryFn: () => mgmt<{ files: ErrorLogFile[] }>('/observability/logs/errors'),
    refetchInterval: 30_000,
  })
  const files = [...(data?.files ?? [])].sort((a, b) => b.modified - a.modified)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Error logs</CardTitle>
        <CardDescription>
          {requestLogOn
            ? 'Not written while request logging is on. Failed requests are in the request logs instead.'
            : 'Full logs of failed requests, written while request logging is off.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : error ? (
          <Alert variant="destructive">
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        ) : files.length === 0 ? (
          <Empty className="border py-10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FileTextIcon />
              </EmptyMedia>
              <EmptyTitle>No error logs</EmptyTitle>
              <EmptyDescription>Failed requests are saved here for inspection.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="max-h-96 overflow-y-auto">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead>File</TableHead>
                  <TableHead className="w-20 text-right">Size</TableHead>
                  <TableHead className="w-32">Modified</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {files.map((f) => (
                  <TableRow key={f.name}>
                    <TableCell className="truncate font-mono text-xs" title={f.name}>
                      {f.name}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground tabular">{fmtBytes(f.size)}</TableCell>
                    <TableCell className="truncate text-muted-foreground" title={fmtDateTime(f.modified * 1000)}>
                      {fmtAgo(f.modified * 1000)}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Download ${f.name}`}
                        onClick={() =>
                          download(`/observability/logs/errors/${encodeURIComponent(f.name)}`, f.name).catch((e: Error) =>
                            toast.error('Download failed', { description: e.message }),
                          )
                        }
                      >
                        <DownloadIcon />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
