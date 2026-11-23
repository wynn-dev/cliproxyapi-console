import * as React from "react"
import { cn } from "@/lib/utils"

/** A panel: a titled strip over its content, framed by hairlines. Inside `Panels` it shares its frame. */
function Card({
  className,
  size = "default",
  ...props
}: React.ComponentProps<"div"> & { size?: "default" | "sm" }) {
  return (
    <div
      data-slot="card"
      data-size={size}
      className={cn(
        "group/card flex min-w-0 flex-col rounded-md border bg-card text-sm text-card-foreground in-data-[slot=panels]:rounded-none in-data-[slot=panels]:border-0",
        className
      )}
      {...props}
    />
  )
}

/** Panels laid out in one frame: the gaps between them are the hairlines. */
function Panels({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="panels"
      className={cn("grid gap-px overflow-hidden rounded-md border bg-border", className)}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "group/card-header flex min-h-10 min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-b px-3 py-2",
        className
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn("font-heading text-[13px] leading-snug font-medium", className)}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("min-w-0 truncate text-xs text-muted-foreground", className)}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn("-my-1 -mr-1.5 ml-auto flex items-center gap-1", className)}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("min-w-0 flex-1 p-3", className)}
      {...props}
    />
  )
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex min-w-0 items-center border-t px-3 py-2", className)}
      {...props}
    />
  )
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
  Panels,
}
