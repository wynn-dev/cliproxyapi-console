import { useQuery } from '@tanstack/react-query'
import { Link, Outlet, createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { AlertTriangleIcon } from 'lucide-react'
import { useEffect } from 'react'
import { AppNav } from '@/components/app-sidebar'
import { Button } from '@/components/ui/button'
import { auth, consoleApi } from '@/lib/api'
import { queries } from '@/lib/queries'
import type { ConsoleState } from '@/lib/types'

export const Route = createFileRoute('/_app')({
  beforeLoad: async () => {
    const state = await consoleApi<ConsoleState>('/state')
    if (!state.configured) throw redirect({ to: '/setup' })
    if (!auth.get()) throw redirect({ to: '/login' })
  },
  component: AppLayout,
})

function AppLayout() {
  const navigate = useNavigate()
  const { data: status } = useQuery(queries.status())

  useEffect(() => {
    const onLogout = () => navigate({ to: '/login' })
    window.addEventListener('cpa-console:logout', onLogout)
    return () => window.removeEventListener('cpa-console:logout', onLogout)
  }, [navigate])

  const state = status?.process.state
  const down = state === 'stopped' || state === 'crashed'

  return (
    <div className="@container/main flex min-h-svh flex-col">
      <AppNav />
      {down && (
        <div className="flex items-center gap-3 border-b bg-critical/10 px-5 py-2 text-[13px]">
          <AlertTriangleIcon className="size-4 shrink-0 text-critical" />
          <span className="flex-1">
            CLIProxyAPI is {state}. Management pages are unavailable until it runs.
            {status?.process.lastError && <span className="text-muted-foreground"> {status.process.lastError}</span>}
          </span>
          <Button size="sm" variant="outline" asChild>
            <Link to="/">Go to overview</Link>
          </Button>
        </div>
      )}
      <main className="mx-auto w-full max-w-[90rem] flex-1 space-y-4 px-3 pt-4 pb-10 md:px-5 md:pt-5">
        <Outlet />
      </main>
    </div>
  )
}
