import { useQuery } from '@tanstack/react-query'
import { Link, Outlet, createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { AlertTriangleIcon } from 'lucide-react'
import { useEffect } from 'react'
import { AppSidebar } from '@/components/app-sidebar'
import { ThemeToggle } from '@/components/theme'
import { Button } from '@/components/ui/button'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
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
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 rounded-t-xl border-b bg-background/80 px-4 backdrop-blur">
          <SidebarTrigger className="-ml-1" />
          <div className="flex-1" />
          <ThemeToggle />
        </header>
        {down && (
          <div className="flex items-center gap-3 border-b bg-critical/10 px-6 py-2.5 text-sm">
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
        <div className="mx-auto w-full max-w-7xl flex-1 space-y-6 p-4 md:p-6 lg:p-8">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
