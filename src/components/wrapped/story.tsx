import { ChevronLeftIcon, ChevronRightIcon, PauseIcon, PlayIcon, XIcon } from 'lucide-react'
import { useEffect, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { H, W } from '@/lib/wrapped'
import { SlideCanvas } from './canvas'

/** How long each slide stays up before the next. */
const SLIDE_MS = 6000

export interface StorySlide {
  id: string
  accent: string
  content: React.ReactNode
}

/**
 * The slides one at a time, full screen, like a story: they advance on their own, a tap on the left
 * goes back and anywhere else forward. Arrows step, space pauses, Escape closes.
 */
export function StoryPlayer({ slides, month, onClose }: { slides: StorySlide[]; month: string; onClose: () => void }) {
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const [scale, setScale] = useState(1)
  const last = slides.length - 1
  const next = () => (index < last ? setIndex(index + 1) : onClose())
  const prev = () => setIndex(Math.max(0, index - 1))

  useLayoutEffect(() => {
    const fit = () => setScale(Math.min((window.innerWidth * 0.94) / W, (window.innerHeight - 140) / H))
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight') next()
      else if (e.key === 'ArrowLeft') prev()
      else if (e.key === ' ') setPaused((p) => !p)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = overflow
    }
  })

  const slide = slides[index]
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={`${month} wrapped`} className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-black/90 p-4">
      <div className="flex w-full gap-1.5" style={{ maxWidth: W * scale }}>
        {slides.map((s, i) => (
          <button key={s.id} type="button" aria-label={`Slide ${i + 1}`} className="h-1 flex-1 overflow-hidden rounded-full bg-white/25" onClick={() => setIndex(i)}>
            <div
              key={i === index ? `${index}-active` : i}
              className="h-full bg-white"
              style={
                i < index
                  ? { width: '100%' }
                  : i === index
                    ? { animation: `wrapped-progress ${SLIDE_MS}ms linear forwards`, animationPlayState: paused ? 'paused' : 'running' }
                    : { width: 0 }
              }
              onAnimationEnd={i === index ? next : undefined}
            />
          </button>
        ))}
      </div>

      <div className="relative overflow-hidden rounded-2xl shadow-2xl" style={{ width: W * scale, height: H * scale }}>
        <div key={slide.id} className="animate-in duration-500 fade-in zoom-in-95" style={{ width: W, height: H, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
          <SlideCanvas accent={slide.accent} month={month}>
            {slide.content}
          </SlideCanvas>
        </div>
        {/* Tap zones: the left third goes back, the rest forward. */}
        <button type="button" aria-label="Previous slide" className="absolute inset-y-0 left-0 w-1/3 cursor-w-resize" onClick={prev} />
        <button type="button" aria-label="Next slide" className="absolute inset-y-0 right-0 w-2/3 cursor-e-resize" onClick={next} />
      </div>

      <div className="flex items-center gap-2 text-white">
        <Button variant="ghost" size="icon" className="text-white hover:bg-white/15 hover:text-white" aria-label="Previous" disabled={index === 0} onClick={prev}>
          <ChevronLeftIcon />
        </Button>
        <Button variant="ghost" size="icon" className="text-white hover:bg-white/15 hover:text-white" aria-label={paused ? 'Play' : 'Pause'} onClick={() => setPaused(!paused)}>
          {paused ? <PlayIcon /> : <PauseIcon />}
        </Button>
        <span className="w-16 text-center text-sm text-white/70 tabular">
          {index + 1} / {slides.length}
        </span>
        <Button variant="ghost" size="icon" className="text-white hover:bg-white/15 hover:text-white" aria-label="Next" onClick={next}>
          <ChevronRightIcon />
        </Button>
        <Button variant="ghost" size="icon" className="ml-4 text-white hover:bg-white/15 hover:text-white" aria-label="Close" onClick={onClose}>
          <XIcon />
        </Button>
      </div>
    </div>,
    document.body,
  )
}
