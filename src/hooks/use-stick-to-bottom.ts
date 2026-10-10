import { useCallback, useLayoutEffect, useRef, useState } from 'react'

const THRESHOLD = 32

/**
 * Keeps a scroll container pinned to the bottom while new content arrives, unless the user scrolled up.
 * `version` should change whenever content is appended.
 */
export function useStickToBottom<T extends HTMLElement = HTMLDivElement>(version: unknown) {
  const ref = useRef<T>(null)
  const stuck = useRef(true)
  const [pinned, setPinned] = useState(true)
  const [unseen, setUnseen] = useState(false)

  const onScroll = useCallback(() => {
    const el = ref.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < THRESHOLD
    if (atBottom === stuck.current) return
    stuck.current = atBottom
    setPinned(atBottom)
    if (atBottom) setUnseen(false)
  }, [])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (stuck.current) el.scrollTop = el.scrollHeight
    else setUnseen(true)
  }, [version])

  const scrollToBottom = useCallback(() => {
    const el = ref.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    stuck.current = true
    setPinned(true)
    setUnseen(false)
  }, [])

  return { ref, onScroll, pinned, unseen, scrollToBottom }
}
