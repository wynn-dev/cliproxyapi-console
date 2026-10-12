import { useQuery } from '@tanstack/react-query'
import {
  type Column,
  type ColumnDef,
  type RowSelectionState,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  BoxesIcon,
  DownloadIcon,
  EllipsisIcon,
  PencilIcon,
  PowerIcon,
  PowerOffIcon,
  RefreshCwIcon,
  SearchIcon,
  TimerResetIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { RequestSparkline } from '@/components/common'
import { confirm } from '@/components/confirm'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { fmtAgo, fmtCompact, fmtPercent } from '@/lib/format'
import { providerLabel } from '@/lib/providers'
import { queries } from '@/lib/queries'
import type { Credential, ReserveStatus } from '@/lib/types'
import { cn } from '@/lib/utils'
import { CredentialSheet } from './credential-sheet'
import {
  type CredState,
  STATE_META,
  accountName,
  cooldownUntil,
  credState,
  downloadCredential,
  reserveHold,
  totalRequests,
  useDeleteCredentials,
  useRefreshCredentials,
  useResetCooldown,
  useSetDisabled,
} from './lib'
import { ModelsDialog } from './models-dialog'
import { CredentialStatus } from './status'

type StatusFilter = 'all' | CredState | 'reserved' | 'signed-out'

/** Accounts the console holds back are their own filters, not under Disabled. */
function filterState(c: Credential, reserve: ReserveStatus | undefined): Exclude<StatusFilter, 'all'> {
  const hold = reserveHold(c, reserve)
  if (!hold || hold.overridden) return credState(c)
  return hold.reason === 'signed-out' ? 'signed-out' : 'reserved'
}

interface Handlers {
  open: (c: Credential, edit?: boolean) => void
  models: (c: Credential) => void
  toggle: (c: Credential, enabled: boolean) => void
  refresh: (c: Credential) => void
  resetCooldown: (c: Credential) => void
  remove: (names: string[], label: string) => void
}

const stop = (e: React.SyntheticEvent) => e.stopPropagation()

function SortHeader({ label, column }: { label: string; column: Column<Credential> }) {
  const sorted = column.getIsSorted()
  const Icon = sorted === 'asc' ? ArrowUpIcon : sorted === 'desc' ? ArrowDownIcon : ArrowUpDownIcon
  return (
    <Button variant="ghost" size="xs" className="-ml-2 text-xs font-medium text-muted-foreground" onClick={column.getToggleSortingHandler()}>
      {label}
      <Icon className={cn(!sorted && 'opacity-40')} />
    </Button>
  )
}

function buildColumns(h: React.RefObject<Handlers>): ColumnDef<Credential>[] {
  return [
    {
      id: 'select',
      header: ({ table }) => (
        <Checkbox
          aria-label="Select all"
          checked={table.getIsAllRowsSelected() ? true : table.getIsSomeRowsSelected() ? 'indeterminate' : false}
          onCheckedChange={(v) => table.toggleAllRowsSelected(!!v)}
        />
      ),
      cell: ({ row }) => (
        <Checkbox aria-label="Select row" checked={row.getIsSelected()} onCheckedChange={(v) => row.toggleSelected(!!v)} onClick={stop} />
      ),
      enableSorting: false,
      meta: { className: 'w-9 pl-3' },
    },
    {
      id: 'account',
      accessorFn: (c) => accountName(c).toLowerCase(),
      header: ({ column }) => <SortHeader label="Account" column={column} />,
      cell: ({ row: { original: c } }) => (
        <div className="min-w-0 space-y-0.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-medium">{accountName(c)}</span>
            <Badge variant="secondary" className="h-4.5 px-1.5 text-[11px]">
              {providerLabel(c.provider)}
            </Badge>
            {c.id_token?.plan_type && (
              <Badge variant="outline" className="h-4.5 px-1.5 text-[11px] capitalize">
                {c.id_token.plan_type}
              </Badge>
            )}
          </div>
          <div className="truncate font-mono text-xs text-muted-foreground">
            {c.name}
            {c.note && <span className="font-sans"> · {c.note}</span>}
          </div>
          {/* Narrow screens drop the Status column, so it rides along here. */}
          <div className="pt-0.5 lg:hidden">
            <CredentialStatus credential={c} />
          </div>
        </div>
      ),
      sortingFn: 'text',
      meta: { className: 'max-w-0 w-full sm:min-w-64' },
    },
    {
      id: 'status',
      accessorFn: (c) => STATE_META[credState(c)].rank * 1e13 + (cooldownUntil(c) ?? 0),
      header: ({ column }) => <SortHeader label="Status" column={column} />,
      sortDescFirst: false,
      cell: ({ row }) => <CredentialStatus credential={row.original} />,
      meta: { className: 'hidden lg:table-cell w-48' },
    },
    {
      id: 'traffic',
      accessorFn: totalRequests,
      header: ({ column }) => <SortHeader label="Traffic" column={column} />,
      sortDescFirst: true,
      meta: { className: 'hidden lg:table-cell w-56' },
      cell: ({ row: { original: c } }) => {
        const total = totalRequests(c)
        return (
          <div className="flex items-center gap-3">
            <RequestSparkline buckets={c.recent_requests} className="h-6" />
            <div className="w-16 text-xs leading-tight tabular">
              <div>
                {fmtCompact(c.success)}
                <span className="text-muted-foreground"> / </span>
                <span className={cn(c.failed > 0 && 'text-critical')}>{fmtCompact(c.failed)}</span>
              </div>
              <div className="text-muted-foreground">{total ? `${fmtPercent(c.success / total, 0)} ok` : 'No traffic'}</div>
            </div>
          </div>
        )
      },
    },
    {
      id: 'priority',
      header: () => (
        <Tooltip>
          <TooltipTrigger className="cursor-default">Priority · Weight</TooltipTrigger>
          <TooltipContent>Higher priority is tried first. Weight applies to weighted round-robin.</TooltipContent>
        </Tooltip>
      ),
      cell: ({ row: { original: c } }) => (
        <span className="text-sm tabular">
          <span className={cn(!c.priority && 'text-muted-foreground')}>{c.priority ?? 0}</span>
          <span className="text-muted-foreground"> · </span>
          <span className={cn(c.weight == null && 'text-muted-foreground')}>{c.weight ?? '—'}</span>
        </span>
      ),
      meta: { className: 'hidden xl:table-cell' },
    },
    {
      id: 'refreshed',
      header: 'Refreshed',
      cell: ({ row: { original: c } }) => (
        <span className="text-sm text-muted-foreground" title={c.last_refresh}>
          {fmtAgo(c.last_refresh)}
        </span>
      ),
      meta: { className: 'hidden xl:table-cell' },
    },
    {
      id: 'enabled',
      header: () => <span className="sr-only">Enabled</span>,
      cell: ({ row: { original: c } }) => (
        <Switch
          size="sm"
          aria-label={c.disabled ? 'Enable credential' : 'Disable credential'}
          checked={!c.disabled}
          onClick={stop}
          onCheckedChange={(on) => h.current.toggle(c, on)}
        />
      ),
      meta: { className: 'w-10' },
    },
    {
      id: 'actions',
      header: () => <span className="sr-only">Actions</span>,
      cell: ({ row: { original: c } }) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Actions" onClick={stop} className="text-muted-foreground">
              <EllipsisIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44" onClick={stop}>
            <DropdownMenuItem onSelect={() => h.current.open(c, true)}>
              <PencilIcon />
              Edit…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => h.current.models(c)}>
              <BoxesIcon />
              View models
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => h.current.refresh(c)}>
              <RefreshCwIcon />
              Refresh token
            </DropdownMenuItem>
            {(credState(c) === 'cooling' || !!c.cooldowns?.length) && (
              <DropdownMenuItem onSelect={() => h.current.resetCooldown(c)}>
                <TimerResetIcon />
                Reset cooldown
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => downloadCredential(c.name)}>
              <DownloadIcon />
              Download
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => h.current.remove([c.name], accountName(c))}>
              <Trash2Icon />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
      meta: { className: 'w-10 pr-3' },
    },
  ]
}

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'cooling', label: 'Cooling' },
  { value: 'error', label: 'Error' },
  { value: 'signed-out', label: 'Signed out' },
  { value: 'reserved', label: 'Reserved' },
  { value: 'disabled', label: 'Disabled' },
]

export function CredentialsTable({
  files,
  loading,
  account,
  onAccountChange,
}: {
  files: Credential[]
  loading: boolean
  /** The credential whose panel is open, kept in the URL. */
  account?: string
  onAccountChange: (name?: string) => void
}) {
  const [search, setSearch] = useState('')
  const [provider, setProvider] = useState('all')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [sorting, setSorting] = useState<SortingState>([])
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
  const [focusEdit, setFocusEdit] = useState(false)
  const [modelsFor, setModelsFor] = useState<Credential | null>(null)

  const setDisabled = useSetDisabled()
  const refresh = useRefreshCredentials()
  const reset = useResetCooldown()
  const del = useDeleteCredentials()
  const reserve = useQuery(queries.reserve()).data

  const handlers = useRef<Handlers>(null!)
  handlers.current = {
    open: (c, edit = false) => {
      setFocusEdit(edit)
      onAccountChange(c.name)
    },
    models: setModelsFor,
    toggle: (c, enabled) => setDisabled.mutate({ names: [c.name], disabled: !enabled }),
    refresh: (c) => refresh.mutate([c.name]),
    resetCooldown: (c) => reset.mutate(c),
    remove: (names, label) =>
      confirm({
        title: names.length === 1 ? `Delete ${label}?` : `Delete ${names.length} credentials?`,
        description:
          names.length === 1
            ? 'The auth file is removed from the auth directory. You will need to sign in again to restore it.'
            : 'Their auth files are removed from the auth directory. You will need to sign in again to restore them.',
        confirmLabel: 'Delete',
        destructive: true,
        onConfirm: async () => {
          await del.mutateAsync(names)
          setRowSelection({})
        },
      }),
  }
  const columns = useMemo(() => buildColumns(handlers), [])

  const providers = useMemo(() => {
    const counts = new Map<string, number>()
    for (const f of files) counts.set(f.provider, (counts.get(f.provider) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => providerLabel(a[0]).localeCompare(providerLabel(b[0])))
  }, [files])

  const byProvider = useMemo(() => (provider === 'all' ? files : files.filter((f) => f.provider === provider)), [files, provider])
  const statusCounts = useMemo(() => {
    const counts: Record<StatusFilter, number> = { all: byProvider.length, active: 0, cooling: 0, error: 0, 'signed-out': 0, reserved: 0, disabled: 0 }
    for (const f of byProvider) counts[filterState(f, reserve)]++
    return counts
  }, [byProvider, reserve])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return byProvider.filter((f) => {
      if (status !== 'all' && filterState(f, reserve) !== status) return false
      if (!q) return true
      return [f.email, f.label, f.name, f.provider, providerLabel(f.provider), f.note].some((s) => s?.toLowerCase().includes(q))
    })
  }, [byProvider, search, status, reserve])

  const table = useReactTable({
    data: filtered,
    columns,
    state: { sorting, rowSelection },
    getRowId: (c) => c.name,
    onSortingChange: setSorting,
    onRowSelectionChange: setRowSelection,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  const selected = table.getSelectedRowModel().rows.map((r) => r.original)
  const selectedNames = selected.map((c) => c.name)
  const filtering = !!search.trim() || provider !== 'all' || status !== 'all'
  const sheetCredential = account ? (files.find((f) => f.name === account) ?? null) : null

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <InputGroup className="w-full sm:w-64">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput placeholder="Search accounts" value={search} onChange={(e) => setSearch(e.target.value)} />
          {search && (
            <InputGroupAddon align="inline-end">
              <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => setSearch('')}>
                <XIcon />
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>
        {providers.length > 1 && (
          <Select value={provider} onValueChange={setProvider}>
            <SelectTrigger className="min-w-40" aria-label="Provider">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="start">
              <SelectItem value="all">
                All providers <span className="text-muted-foreground tabular">{files.length}</span>
              </SelectItem>
              {providers.map(([p, n]) => (
                <SelectItem key={p} value={p}>
                  {providerLabel(p)} <span className="text-muted-foreground tabular">{n}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <ToggleGroup
          type="single"
          variant="outline"
          spacing={0}
          value={status}
          onValueChange={(v) => v && setStatus(v as StatusFilter)}
          aria-label="Status"
          className="-m-1 max-w-full overflow-x-auto p-1"
        >
          {/* Signed out is rare: only shown while it applies. */}
          {STATUS_FILTERS.filter((s) => s.value !== 'signed-out' || statusCounts[s.value] || status === s.value).map((s) => (
            <ToggleGroupItem key={s.value} value={s.value} className="gap-1.5 px-2.5 data-[state=on]:font-medium">
              {s.value !== 'all' && <span className={cn('size-1.5 rounded-full', DOT[s.value])} />}
              {s.label}
              <span className={cn('text-xs tabular', statusCounts[s.value] ? 'text-muted-foreground' : 'text-muted-foreground/50')}>
                {statusCounts[s.value]}
              </span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {filtering && (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => {
              setSearch('')
              setProvider('all')
              setStatus('all')
            }}
          >
            Reset
          </Button>
        )}
        <div className="ml-auto text-xs text-muted-foreground tabular">
          {filtering ? `${filtered.length} of ${files.length}` : `${files.length} credential${files.length === 1 ? '' : 's'}`}
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border bg-card">
        <Table>
          <TableHeader className="bg-muted/40">
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id} className="hover:bg-transparent">
                {hg.headers.map((header) => (
                  <TableHead key={header.id} className={cn('h-9 text-xs text-muted-foreground', colClass(header.column.columnDef))}>
                    {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 5 }, (_, i) => (
                <TableRow key={i} className="hover:bg-transparent">
                  <TableCell className="pl-3">
                    <Skeleton className="size-4" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="mb-1.5 h-4 w-48 max-w-full" />
                    <Skeleton className="h-3 w-64 max-w-full" />
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    <Skeleton className="h-4 w-20" />
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    <Skeleton className="h-6 w-44" />
                  </TableCell>
                  <TableCell className="hidden xl:table-cell">
                    <Skeleton className="h-4 w-10" />
                  </TableCell>
                  <TableCell className="hidden xl:table-cell">
                    <Skeleton className="h-4 w-16" />
                  </TableCell>
                  <TableCell colSpan={2}>
                    <Skeleton className="h-4 w-12" />
                  </TableCell>
                </TableRow>
              ))
            ) : table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() ? 'selected' : undefined}
                  className={cn('cursor-pointer', row.original.disabled && '[&>td:not(:first-child,:nth-last-child(-n+2))]:opacity-60')}
                  onClick={() => handlers.current.open(row.original)}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className={colClass(cell.column.columnDef)}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={columns.length} className="h-28 text-center text-muted-foreground">
                  No credentials match these filters.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {selected.length > 0 && (
        <div className="sticky bottom-4 z-20 mx-auto flex w-fit max-w-full flex-wrap items-center gap-1 rounded-xl border bg-popover p-1.5 pl-3 shadow-lg animate-in fade-in-0 slide-in-from-bottom-2">
          <span className="mr-2 text-sm font-medium tabular">{selected.length} selected</span>
          <Button
            variant="ghost"
            size="sm"
            disabled={setDisabled.isPending}
            onClick={() => setDisabled.mutate({ names: selectedNames, disabled: false })}
          >
            <PowerIcon />
            Enable
          </Button>
          <Button variant="ghost" size="sm" disabled={setDisabled.isPending} onClick={() => setDisabled.mutate({ names: selectedNames, disabled: true })}>
            <PowerOffIcon />
            Disable
          </Button>
          <Button variant="ghost" size="sm" disabled={refresh.isPending} onClick={() => refresh.mutate(selectedNames)}>
            {refresh.isPending ? <Spinner /> : <RefreshCwIcon />}
            Refresh
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={() => handlers.current.remove(selectedNames, accountName(selected[0]))}
          >
            <Trash2Icon />
            Delete
          </Button>
          <div className="mx-1 h-5 w-px bg-border" />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Clear selection" onClick={() => setRowSelection({})}>
                <XIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Clear selection</TooltipContent>
          </Tooltip>
        </div>
      )}

      <CredentialSheet
        credential={sheetCredential}
        focusEdit={focusEdit}
        onOpenChange={(open) => !open && onAccountChange()}
        onShowModels={setModelsFor}
      />
      <ModelsDialog credential={modelsFor} onOpenChange={(open) => !open && setModelsFor(null)} />
    </div>
  )
}

const DOT: Record<Exclude<StatusFilter, 'all'>, string> = {
  active: 'bg-success',
  cooling: 'bg-warning',
  error: 'bg-critical',
  'signed-out': 'bg-critical',
  reserved: 'bg-muted-foreground/50',
  disabled: 'bg-muted-foreground/50',
}

const colClass = (def: ColumnDef<Credential>) => (def.meta as { className?: string } | undefined)?.className
