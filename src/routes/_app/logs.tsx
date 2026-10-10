import { createFileRoute } from '@tanstack/react-router'
import { PageHeader } from '@/components/common'
import { AppLog } from '@/components/logs/app-log'
import { ProcessOutput } from '@/components/logs/process-output'
import { RequestLogs } from '@/components/logs/request-logs'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

export const Route = createFileRoute('/_app/logs')({ component: Logs })

function Logs() {
  return (
    <>
      <PageHeader title="Logs" description="Tail CLIProxyAPI's application log, its process output, and per-request logs." />
      <Tabs defaultValue="app" className="gap-4">
        <TabsList>
          <TabsTrigger value="app">Application log</TabsTrigger>
          <TabsTrigger value="output">Process output</TabsTrigger>
          <TabsTrigger value="requests">Request logs</TabsTrigger>
        </TabsList>
        <TabsContent value="app">
          <AppLog />
        </TabsContent>
        <TabsContent value="output">
          <ProcessOutput />
        </TabsContent>
        <TabsContent value="requests">
          <RequestLogs />
        </TabsContent>
      </Tabs>
    </>
  )
}
