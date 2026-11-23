import { createFileRoute, useBlocker } from '@tanstack/react-router'
import { FileCodeIcon, NetworkIcon, RefreshCwIcon, ScrollTextIcon, ServerIcon, SplitIcon } from 'lucide-react'
import { useCallback, useState } from 'react'
import { PageHeader } from '@/components/common'
import { LimitChecksSection } from '@/components/settings/limit-checks-section'
import { LoggingSection, NetworkSection, ReserveSection, RetriesSection, RoutingSection } from '@/components/settings/sections'
import { OrderSection } from '@/components/settings/order-section'
import { ManagementSection, ServerSection } from '@/components/settings/server-section'
import { YamlSection } from '@/components/settings/yaml-editor'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const SECTIONS = [
  { id: 'routing', label: 'Routing', icon: SplitIcon },
  { id: 'retries', label: 'Retries & cooldown', icon: RefreshCwIcon },
  { id: 'network', label: 'Network & requests', icon: NetworkIcon },
  { id: 'logging', label: 'Logging & usage', icon: ScrollTextIcon },
  { id: 'server', label: 'Server & access', icon: ServerIcon },
  { id: 'yaml', label: 'Config file', icon: FileCodeIcon },
] as const

type SectionId = (typeof SECTIONS)[number]['id']

export const Route = createFileRoute('/_app/settings')({
  validateSearch: (s: Record<string, unknown>): { section?: SectionId } => ({
    section: SECTIONS.find((x) => x.id === s.section)?.id,
  }),
  component: SettingsPage,
})

function SettingsPage() {
  const { section = 'routing' } = Route.useSearch()
  const navigate = Route.useNavigate()
  const [dirty, setDirty] = useState<Record<string, boolean>>({})
  const onDirty = useCallback((id: string, d: boolean) => setDirty((prev) => (prev[id] === d ? prev : { ...prev, [id]: d })), [])
  const anyDirty = Object.values(dirty).some(Boolean)
  // A tab can hold several cards, reported as `tab` and `tab.card`.
  const tabDirty = (tab: SectionId) => Object.entries(dirty).some(([id, d]) => d && id.split('.')[0] === tab)

  const blocker = useBlocker({
    shouldBlockFn: ({ next }) => anyDirty && next.pathname !== '/settings',
    enableBeforeUnload: () => anyDirty,
    withResolver: true,
  })

  // Sections stay mounted while hidden so switching keeps unsaved edits.
  const panel = (id: SectionId, children: React.ReactNode) => (
    <div role="tabpanel" id={`settings-${id}`} aria-labelledby={`settings-tab-${id}`} hidden={section !== id}>
      {children}
    </div>
  )

  return (
    <>
      <PageHeader title="Settings" />

      <div className="flex flex-col gap-2">
        <nav aria-label="Settings sections" className="-mx-4 overflow-x-auto border-b px-4 md:mx-0 md:px-0">
          <div role="tablist" aria-orientation="horizontal" className="flex gap-5">
            {SECTIONS.map(({ id, label }) => (
              <button
                key={id}
                id={`settings-tab-${id}`}
                role="tab"
                aria-selected={section === id}
                aria-controls={`settings-${id}`}
                data-active={section === id}
                onClick={() => navigate({ search: { section: id }, replace: true })}
                className="-mx-1 flex shrink-0 items-center gap-1.5 px-1 pt-1 pb-2.5 text-left text-[0.84rem] whitespace-nowrap text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:rounded-sm focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset data-[active=true]:text-foreground data-[active=true]:shadow-[inset_0_-1.5px_0_var(--foreground)]"
              >
                <span>{label}</span>
                {tabDirty(id) && (
                  <span className="size-1.5 rounded-full bg-warning" title="Unsaved changes">
                    <span className="sr-only">(unsaved changes)</span>
                  </span>
                )}
              </button>
            ))}
          </div>
        </nav>

        <div className="min-w-0 flex-1">
          {panel(
            'routing',
            <>
              <RoutingSection onDirty={onDirty} />
              <ReserveSection onDirty={onDirty} />
              <OrderSection onDirty={onDirty} />
              <LimitChecksSection onDirty={onDirty} />
            </>,
          )}
          {panel('retries', <RetriesSection onDirty={onDirty} />)}
          {panel('network', <NetworkSection onDirty={onDirty} />)}
          {panel('logging', <LoggingSection onDirty={onDirty} />)}
          {panel(
            'server',
            <>
              <ServerSection onDirty={onDirty} />
              <ManagementSection />
            </>,
          )}
          {panel('yaml', <YamlSection onDirty={onDirty} />)}
        </div>
      </div>

      <AlertDialog open={blocker.status === 'blocked'} onOpenChange={(open) => !open && blocker.reset?.()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved changes in {SECTIONS.filter((s) => tabDirty(s.id)).map((s) => s.label).join(', ')}. They will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => blocker.reset?.()}>Stay</AlertDialogCancel>
            <AlertDialogAction className={cn(buttonVariants({ variant: 'destructive' }))} onClick={() => blocker.proceed?.()}>
              Discard changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
