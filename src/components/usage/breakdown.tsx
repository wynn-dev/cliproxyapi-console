import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import { ArrowDownIcon, ArrowUpIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { fmtCompact, fmtMs, fmtNumber, fmtPercent, fmtUsd } from '@/lib/format'
import { providerLabel } from '@/lib/providers'
import type { UsageMetrics, UsageSummary } from '@/lib/types'
import { cn } from '@/lib/utils'
import { ClientKey, type CredentialLabels, CredentialName } from './cells'
import { type FilterKey, keySuffix, usageRoute } from './search'

type Row = UsageMetrics & { key: string }
type Dimension = 'model' | 'credential' | 'key' | 'provider'

const DIMENSIONS: { id: Dimension; label: string; data: keyof UsageSummary; filter: FilterKey }[] = [
  { id: 'model', label: 'Model', data: 'byModel', filter: 'model' },
  { id: 'credential', label: 'Credential', data: 'byCredential', filter: 'credential' },
  { id: 'key', label: 'Client key', data: 'byApiKey', filter: 'key' },
  { id: 'provider', label: 'Provider', data: 'byProvider', filter: 'provider' },
]

/** Columns that make way on narrower screens, so Share stays in view. */
const HIDDEN: Record<string, string> = { avgLatency: 'max-2xl:hidden', total: 'max-2xl:hidden' }

const num = (v: number) => (
  <span className="tabular" title={fmtNumber(v)}>
    {fmtCompact(v)}
  </span>
)

export function Breakdown({ summary, labels }: { summary: UsageSummary; labels: CredentialLabels }) {
  const [dim, setDim] = useState<Dimension>('model')
  const navigate = usageRoute.useNavigate()
  const d = DIMENSIONS.find((x) => x.id === dim)!
  const rows = summary[d.data] as Row[]
  // Credentials count attempts, so their share is of all attempts.
  const totalRequests = dim === 'credential' ? summary.totals.attempts : summary.totals.requests

  const apply = (row: Row) => {
    if (!row.key) return
    const value = dim === 'key' ? keySuffix(row.key) : row.key
    void navigate({ search: (prev) => ({ ...prev, [d.filter]: value }), replace: true })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Breakdown</CardTitle>
        <CardDescription>
          {dim === 'credential' && 'Accounts count every attempt, so a request that failed over shows on each account it tried. '}
          Select a row to filter the whole page by it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Tabs value={dim} onValueChange={(v) => setDim(v as Dimension)}>
          <TabsList className="max-w-full overflow-x-auto">
            {DIMENSIONS.map((x) => (
              <TabsTrigger key={x.id} value={x.id} className="px-2.5">
                {x.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <BreakdownTable key={dim} dim={dim} rows={rows} totalRequests={totalRequests} labels={labels} onSelect={apply} />
      </CardContent>
    </Card>
  )
}

function BreakdownTable({
  dim,
  rows,
  totalRequests,
  labels,
  onSelect,
}: {
  dim: Dimension
  rows: Row[]
  totalRequests: number
  labels: CredentialLabels
  onSelect: (row: Row) => void
}) {
  const [sorting, setSorting] = useState<SortingState>([{ id: 'requests', desc: true }])

  const columns = useMemo<ColumnDef<Row>[]>(
    () => [
      {
        id: 'name',
        accessorFn: (r) => (dim === 'credential' ? (labels.get(r.key)?.label ?? r.key) : r.key),
        header: DIMENSIONS.find((x) => x.id === dim)!.label,
        cell: ({ row: { original: r } }) => {
          if (!r.key) return <span className="text-muted-foreground">Unknown</span>
          if (dim === 'credential') return <CredentialName authIndex={r.key} labels={labels} className="max-w-52" />
          if (dim === 'key') return <ClientKey value={r.key} />
          if (dim === 'provider') return providerLabel(r.key)
          return <span className="block max-w-52 truncate font-mono text-[13px]" title={r.key}>{r.key}</span>
        },
      },
      {
        accessorKey: 'requests',
        header: dim === 'credential' ? 'Attempts' : 'Requests',
        cell: ({ getValue }) => <span className="tabular">{fmtNumber(getValue<number>())}</span>,
      },
      {
        id: 'success',
        accessorFn: (r) => (r.requests ? 1 - r.failed / r.requests : 0),
        header: 'Success',
        cell: ({ row: { original: r } }) => (
          <div className="tabular">
            {fmtPercent(r.requests ? 1 - r.failed / r.requests : null)}
            {r.failed > 0 && (
              <div className="text-xs text-muted-foreground">
                {fmtNumber(r.failed)} failed{r.turnedAway > 0 && ` (${fmtNumber(r.turnedAway)} turned away)`}
              </div>
            )}
          </div>
        ),
      },
      { accessorKey: 'input', header: 'Input', cell: ({ getValue }) => num(getValue<number>()) },
      { accessorKey: 'output', header: 'Output', cell: ({ getValue }) => num(getValue<number>()) },
      { accessorKey: 'cached', header: 'Cached', cell: ({ getValue }) => num(getValue<number>()) },
      { accessorKey: 'total', header: 'Total', cell: ({ getValue }) => num(getValue<number>()) },
      {
        accessorKey: 'value',
        header: 'Value',
        cell: ({ row: { original: r } }) =>
          r.value === 0 && r.unpricedTokens > 0 ? (
            <span className="text-muted-foreground">No price</span>
          ) : (
            <span className="tabular" title={r.unpricedTokens ? `${fmtNumber(r.unpricedTokens)} tokens have no price and are left out` : 'At public API prices'}>
              {fmtUsd(r.value)}
              {r.unpricedTokens > 0 && <span className="text-muted-foreground">*</span>}
            </span>
          ),
      },
      {
        accessorKey: 'avgLatency',
        header: 'Avg latency',
        sortUndefined: 'last',
        cell: ({ getValue }) => <span className="tabular">{fmtMs(getValue<number | null>())}</span>,
      },
      {
        id: 'share',
        accessorFn: (r) => r.requests,
        header: 'Share',
        cell: ({ row: { original: r } }) => {
          const share = totalRequests ? r.requests / totalRequests : 0
          return (
            <div className="flex items-center gap-2">
              <div className="h-1.5 w-10 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-chart-1" style={{ width: `${share * 100}%` }} />
              </div>
              <span className="w-8 text-right text-xs text-muted-foreground tabular">{fmtPercent(share, 0)}</span>
            </div>
          )
        },
      },
    ],
    [dim, labels, totalRequests],
  )

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    sortDescFirst: true,
  })

  if (!rows.length) return <p className="py-6 text-center text-sm text-muted-foreground">No data for this range.</p>

  return (
    <Table>
      <TableHeader>
        {table.getHeaderGroups().map((hg) => (
          <TableRow key={hg.id} className="hover:bg-transparent">
            {hg.headers.map((h) => {
              const sorted = h.column.getIsSorted()
              const numeric = h.column.id !== 'name'
              return (
                <TableHead key={h.id} className={cn(numeric && 'text-right', HIDDEN[h.column.id])} aria-sort={sorted ? (sorted === 'asc' ? 'ascending' : 'descending') : undefined}>
                  <button
                    type="button"
                    className={cn(
                      'inline-flex items-center gap-1 hover:text-foreground',
                      numeric && 'flex-row-reverse',
                      sorted ? 'text-foreground' : 'text-muted-foreground',
                    )}
                    onClick={h.column.getToggleSortingHandler()}
                  >
                    {flexRender(h.column.columnDef.header, h.getContext())}
                    {sorted === 'asc' ? <ArrowUpIcon className="size-3.5" /> : sorted === 'desc' ? <ArrowDownIcon className="size-3.5" /> : <span className="size-3.5" />}
                  </button>
                </TableHead>
              )
            })}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows.map((row) => {
          const selectable = !!row.original.key
          return (
            <TableRow
              key={row.id}
              tabIndex={selectable ? 0 : undefined}
              className={cn(selectable && 'cursor-pointer')}
              onClick={() => onSelect(row.original)}
              onKeyDown={(e) => e.key === 'Enter' && onSelect(row.original)}
            >
              {row.getVisibleCells().map((cell) => (
                <TableCell
                  key={cell.id}
                  className={cn(cell.column.id !== 'name' && 'text-right', cell.column.id === 'share' && 'w-px', HIDDEN[cell.column.id])}
                >
                  <div className={cn(cell.column.id === 'share' && 'flex justify-end')}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</div>
                </TableCell>
              ))}
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
