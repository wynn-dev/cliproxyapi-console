import { ThemeToggle } from '@/components/theme'

export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" className={className} aria-hidden>
      <rect width="32" height="32" rx="7" className="fill-primary" />
      <path d="M9 11h8M9 16h14M9 21h10" className="stroke-primary-foreground" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="22" cy="11" r="2" className="fill-chart-1" />
    </svg>
  )
}

export function AuthShell({ title, description, children }: { title: string; description: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-svh flex-col items-center justify-center p-6">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm">
        <div className="space-y-4 pb-7">
          <Logo className="size-7" />
          <div className="space-y-1">
            <h1 className="text-[1.6rem] leading-tight font-semibold tracking-[-0.02em]">{title}</h1>
            <p className="text-sm text-pretty text-muted-foreground">{description}</p>
          </div>
        </div>
        {children}
      </div>
    </div>
  )
}
