import { H, REPO, W } from '@/lib/wrapped'

/**
 * A slide at its real 1200×675: the accent as `--slide` and a glow in one corner, the content, and
 * the footer. Everything in here ends up in the image.
 */
export function SlideCanvas({
  ref,
  accent,
  month,
  children,
}: {
  ref?: React.Ref<HTMLDivElement>
  accent: string
  month: string
  children: React.ReactNode
}) {
  return (
    <div
      ref={ref}
      className="flex flex-col bg-card p-16 text-card-foreground"
      style={
        {
          width: W,
          height: H,
          '--slide': accent,
          backgroundImage: `radial-gradient(circle at 100% 0%, color-mix(in oklab, ${accent} 20%, transparent), transparent 45%)`,
        } as React.CSSProperties
      }
    >
      <div className="min-h-0 flex-1">{children}</div>
      <div className="flex items-center justify-between pt-6 text-2xl text-muted-foreground">
        <span className="flex items-center gap-3 font-medium text-foreground">
          <span className="size-3 rounded-full" style={{ background: accent }} />
          {REPO}
        </span>
        <span>{month} wrapped</span>
      </div>
    </div>
  )
}
