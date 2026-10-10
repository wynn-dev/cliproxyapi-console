import { useEffect, useState } from 'react'

/** Current time rounded down to `stepMs`, re-rendering when it advances. Keeps query keys stable. */
export function useNow(stepMs = 30_000) {
  const round = () => Math.floor(Date.now() / stepMs) * stepMs + stepMs
  const [now, setNow] = useState(round)
  useEffect(() => {
    const id = setInterval(() => setNow(round()), 5_000)
    return () => clearInterval(id)
  }, [stepMs])
  return now
}
