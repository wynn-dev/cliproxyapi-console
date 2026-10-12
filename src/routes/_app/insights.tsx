import { createFileRoute } from '@tanstack/react-router'
import { PageHeader } from '@/components/common'
import { CacheBreaksCard } from '@/components/insights/cache-breaks'
import { DigestCard } from '@/components/insights/digest'
import { ForecastCard } from '@/components/insights/forecast'

export const Route = createFileRoute('/_app/insights')({ component: Insights })

function Insights() {
  return (
    <>
      <PageHeader title="Insights" description="When the pool runs out, conversations that lost their prompt cache, and how the last week went." />
      <ForecastCard />
      <CacheBreaksCard />
      <DigestCard />
    </>
  )
}
