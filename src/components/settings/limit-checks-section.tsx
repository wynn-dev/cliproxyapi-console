import { useQuery } from '@tanstack/react-query'
import { AlertTriangleIcon } from 'lucide-react'
import { accountName } from '@/components/credentials/lib'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { fmtAgo, fmtWhen } from '@/lib/format'
import { queries, useLimitChecksWrite } from '@/lib/queries'
import { SectionCard, SwitchField } from './form'
import { useReportDirty, useSectionForm, type FieldSpec } from './form-state'
import { Default, type DirtyReporter } from './sections'

const specs: Record<string, FieldSpec> = { enabled: { kind: 'switch', default: false } }

/** Kept by the console rather than in CPA's config. Off by default: the endpoints are undocumented. */
export function LimitChecksSection({ onDirty }: { onDirty: DirtyReporter }) {
  const { data } = useQuery(queries.limitChecks())
  const credentials = useQuery({ ...queries.credentials(), refetchInterval: false })
  const write = useLimitChecksWrite()
  const form = useSectionForm(specs, data, 'Idle account limits', (changes) => write.mutateAsync(changes.enabled === true))
  useReportDirty('routing.limit-checks', form.dirty, onDirty)

  const names = new Map((credentials.data?.files ?? []).map((c) => [c.name, accountName(c)]))
  const checks = Object.entries(data?.accounts ?? {}).filter(([name]) => !credentials.data || names.has(name))
  const failing = data?.enabled ? checks.filter(([, c]) => c.error) : []
  const last = Math.max(0, ...checks.map(([, c]) => c.checkedAt))

  return (
    <SectionCard
      title="Idle account limits"
      description="With fill first, only the account in use reports its limits. The others show the numbers from their last request, and the reserve can't tell when a held-back account has recovered."
      form={form}
      footerNote={data?.enabled && last > 0 && `Last check ${fmtAgo(last)}.`}
    >
      <SwitchField
        form={form}
        path="enabled"
        label="Check the limits of idle accounts"
        description={
          <>
            About every 10 minutes, the console asks Anthropic or OpenAI for the limits of each Claude and Codex account that hasn't served a
            request in that time, signed in as that account. It uses the usage pages Claude Code and Codex read their own usage from. They're
            undocumented, and calling them like this is a terms-of-service grey area.
            <Default>off</Default>
          </>
        }
      />
      {failing.length > 0 && (
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertTitle>
            {failing.length === 1 ? 'An account' : `${failing.length} accounts`} couldn't be checked
          </AlertTitle>
          <AlertDescription>
            <ul className="space-y-1">
              {failing.map(([name, c]) => (
                <li key={name}>
                  <span className="font-medium">{names.get(name) ?? name}</span>: {c.error}
                  {c.retryAt && <span className="text-muted-foreground"> · next try {fmtWhen(c.retryAt)}</span>}
                </li>
              ))}
            </ul>
            {failing.some(([, c]) => c.status === 401 || c.status === 403) && <p>A 401 or 403 usually means the account has to sign in again.</p>}
          </AlertDescription>
        </Alert>
      )}
    </SectionCard>
  )
}
