import { useQuery } from '@tanstack/react-query'
import { InfoIcon } from 'lucide-react'
import { accountName } from '@/components/credentials/lib'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { providerLabel } from '@/lib/providers'
import { queries, useOrderWrite } from '@/lib/queries'
import { strategyLabel } from '@/lib/routing'
import { SectionCard, SwitchField } from './form'
import { useReportDirty, useSectionForm, type FieldSpec } from './form-state'
import { Default, type DirtyReporter } from './sections'

const orderSpecs: Record<string, FieldSpec> = { enabled: { kind: 'switch', default: true } }

/** Kept by the console rather than in CPA's config. */
export function OrderSection({ onDirty }: { onDirty: DirtyReporter }) {
  const { data } = useQuery(queries.order())
  const credentials = useQuery({ ...queries.credentials(), refetchInterval: false })
  const write = useOrderWrite()
  const form = useSectionForm(orderSpecs, data, 'Smart account order', (changes) => write.mutateAsync(changes.enabled === true))
  useReportDirty('routing.order', form.dirty, onDirty)
  const idle = data?.enabled && !data.active && data.strategy

  // Current order per provider, first to last.
  const names = new Map((credentials.data?.files ?? []).map((c) => [c.name, { name: accountName(c), provider: c.provider }]))
  const lines = new Map<string, { name: string; held: boolean }[]>()
  for (const [file, p] of Object.entries(data?.accounts ?? {}).sort(([, a], [, b]) => a.rank - b.rank)) {
    const c = names.get(file)
    if (!c) continue
    const line = lines.get(c.provider) ?? []
    line.push({ name: c.name, held: p.tier === 'held' })
    lines.set(c.provider, line)
  }

  return (
    <SectionCard
      title="Smart account order"
      description="Decides which Claude and Codex account takes new conversations, by setting each account's priority."
      form={form}
    >
      <SwitchField
        form={form}
        path="enabled"
        label="Use the weekly limit that resets soonest first"
        description={
          <>
            Accounts whose weekly limit resets soonest go first, so their allowance doesn't expire unused while others run low. An account
            within 3% of its reserve stops taking new conversations
            {data?.affinity ? '; ones already on it stay, keeping their prompt cache' : ''}. Otherwise your own priorities still decide:
            this only reorders accounts with the same priority. Turning it off puts back the priorities you set.
            <Default>on</Default>
          </>
        }
      />
      {idle && (
        <Alert>
          <InfoIcon />
          <AlertTitle>Only works with fill first</AlertTitle>
          <AlertDescription>
            Routing uses {strategyLabel(data.strategy!)}, which would stop rotating if priorities differed, so account priorities are left as
            you set them.
          </AlertDescription>
        </Alert>
      )}
      {data?.active && lines.size > 0 && (
        <dl className="space-y-1.5 rounded-lg border px-3 py-2.5 text-sm">
          {[...lines].map(([provider, accounts]) => (
            <div key={provider} className="flex gap-3">
              <dt className="w-14 shrink-0 text-muted-foreground">{providerLabel(provider)}</dt>
              <dd className="min-w-0">
                <ol className="flex flex-wrap gap-x-1.5">
                  {accounts.map((a, i) => (
                    <li key={a.name} className={a.held ? 'text-muted-foreground' : undefined}>
                      {i > 0 && <span className="mr-1.5 text-muted-foreground">→</span>}
                      <span className="break-all">{a.name}</span>
                      {a.held && ' (held)'}
                    </li>
                  ))}
                </ol>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </SectionCard>
  )
}
