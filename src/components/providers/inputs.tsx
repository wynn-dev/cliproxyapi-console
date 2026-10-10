import { EyeIcon, EyeOffIcon, PlusIcon, XIcon } from 'lucide-react'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { cn } from '@/lib/utils'
import { rowId, type PairRow } from './model'

export function SecretInput({ value, onChange, className, ...props }: Omit<React.ComponentProps<'input'>, 'onChange' | 'value'> & {
  value: string
  onChange: (v: string) => void
}) {
  const [shown, setShown] = useState(false)
  return (
    <InputGroup className={className}>
      <InputGroupInput
        {...props}
        type={shown ? 'text' : 'password'}
        autoComplete="off"
        spellCheck={false}
        className="font-mono text-[13px]"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <InputGroupAddon align="inline-end">
        <InputGroupButton size="icon-xs" aria-label={shown ? 'Hide key' : 'Show key'} onClick={() => setShown(!shown)}>
          {shown ? <EyeOffIcon /> : <EyeIcon />}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  )
}

/** Editable list of two-column rows (header name → value, model name → alias). */
export function PairRows({
  rows,
  onChange,
  placeholders,
  addLabel,
  arrow,
  mono,
}: {
  rows: PairRow[]
  onChange: (rows: PairRow[]) => void
  placeholders: [string, string]
  addLabel: string
  arrow?: boolean
  mono?: boolean
}) {
  const update = (id: string, patch: Partial<PairRow>) => onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.id} className="flex items-center gap-2">
          <Input
            value={r.a}
            placeholder={placeholders[0]}
            aria-label={placeholders[0]}
            className={cn(mono && 'font-mono text-[13px]')}
            onChange={(e) => update(r.id, { a: e.target.value })}
          />
          {arrow && <span className="shrink-0 text-muted-foreground">→</span>}
          <Input
            value={r.b}
            placeholder={placeholders[1]}
            aria-label={placeholders[1]}
            className={cn(mono && 'font-mono text-[13px]')}
            onChange={(e) => update(r.id, { b: e.target.value })}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0 text-muted-foreground"
            aria-label="Remove row"
            onClick={() => onChange(rows.filter((x) => x.id !== r.id))}
          >
            <XIcon />
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={() => onChange([...rows, { id: rowId(), a: '', b: '' }])}>
        <PlusIcon />
        {addLabel}
      </Button>
    </div>
  )
}

/** Free-form tag input: type and press Enter (or comma) to add; Backspace on empty removes the last tag. */
export function TagInput({ values, onChange, placeholder }: { values: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [draft, setDraft] = useState('')
  const commit = () => {
    const items = draft
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((s) => s && !values.includes(s))
    if (items.length) onChange([...values, ...new Set(items)])
    setDraft('')
  }
  return (
    <div className="flex min-h-8 w-full flex-wrap items-center gap-1.5 rounded-lg border border-input px-2 py-1.5 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30">
      {values.map((v) => (
        <Badge key={v} variant="secondary" className="gap-0.5 pr-0.5 font-mono">
          {v}
          <button
            type="button"
            className="rounded-full p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
            aria-label={`Remove ${v}`}
            onClick={() => onChange(values.filter((x) => x !== v))}
          >
            <XIcon className="size-3" />
          </button>
        </Badge>
      ))}
      <input
        value={draft}
        placeholder={values.length ? '' : placeholder}
        className="min-w-32 flex-1 bg-transparent font-mono text-[13px] outline-none placeholder:font-sans placeholder:text-muted-foreground"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Backspace' && !draft && values.length) {
            onChange(values.slice(0, -1))
          }
        }}
      />
    </div>
  )
}
