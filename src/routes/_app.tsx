import { useQuery } from '@tanstack/react-query'
import { Link, Outlet, createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { AlertTriangleIcon, MenuIcon } from 'lucide-react'
import { useEffect } from 'react'
import { AppSidebar } from '@/components/app-sidebar'
import { Logo } from '@/components/auth-shell'
import { ThemeToggle } from '@/components/theme'
import { Button } from '@/components/ui/button'
import { SidebarInset, SidebarProvider, useSidebar } from '@/components/ui/sidebar'
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
      <SidebarInset className="@container/main min-w-0">
        <PhoneBar />
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
        <div className="mx-auto w-full max-w-[72rem] flex-1 space-y-6 px-4 pt-5 pb-12 md:px-10 md:pt-9">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}

/** Phones get a slim bar with the menu; on wider screens the sidebar is always there. */
function PhoneBar() {
  const { toggleSidebar } = useSidebar()
  return (
    <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 border-b bg-background px-2 md:hidden">
      <Button variant="ghost" size="icon" aria-label="Menu" onClick={toggleSidebar}>
        <MenuIcon />
      </Button>
      <Logo className="size-5" />
      <span className="flex-1 text-sm font-semibold">CPA Console</span>
      <ThemeToggle />
    </header>
  )
}
