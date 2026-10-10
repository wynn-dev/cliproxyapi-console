import { RotateCcwIcon, SaveIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@/components/ui/input-group'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import type { FieldSpec, SectionForm } from './form-state'

export function SectionCard({
  title,
  description,
  form,
  children,
  onSave,
  footerNote,
}: {
  title: string
  description: React.ReactNode
  form: SectionForm
  children: React.ReactNode
  onSave?: () => void
  footerNote?: React.ReactNode
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
        {form.dirty && (
          <CardAction>
            <UnsavedBadge />
          </CardAction>
        )}
      </CardHeader>
      <CardContent>{form.loaded ? <FieldGroup>{children}</FieldGroup> : <FormSkeleton />}</CardContent>
      <CardFooter className="justify-between gap-3">
        <div className="text-xs text-muted-foreground">{footerNote}</div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" disabled={!form.dirty || form.saving} onClick={form.reset}>
            <RotateCcwIcon />
            Reset
          </Button>
          <Button size="sm" disabled={!form.dirty || !form.valid || form.saving} onClick={onSave ?? (() => void form.save())}>
            {form.saving ? <Spinner /> : <SaveIcon />}
            Save
          </Button>
        </div>
      </CardFooter>
    </Card>
  )
}

export function UnsavedBadge({ className }: { className?: string }) {
  return (
    <Badge variant="outline" className={cn('gap-1.5 text-muted-foreground', className)}>
      <span className="size-1.5 rounded-full bg-warning" />
      Unsaved changes
    </Badge>
  )
}

function FormSkeleton() {
  return (
    <div className="space-y-5">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-start justify-between gap-6">
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-full max-w-md" />
          </div>
          <Skeleton className="h-8 w-28" />
        </div>
      ))}
    </div>
  )
}

const fieldId = (path: string) => `setting-${path.replaceAll('.', '-')}`

function FieldLabelText({ form, path, label }: { form: SectionForm; path: string; label: React.ReactNode }) {
  return (
    <FieldLabel htmlFor={fieldId(path)}>
      {label}
      {form.isDirty(path) && (
        <span className="size-1.5 rounded-full bg-warning" title="Modified">
          <span className="sr-only">(modified)</span>
        </span>
      )}
    </FieldLabel>
  )
}

interface FieldProps {
  form: SectionForm
  path: string
  label: React.ReactNode
  description: React.ReactNode
  disabled?: boolean
  children?: React.ReactNode
}

export function SwitchField({ form, path, label, description, disabled, children }: FieldProps) {
  return (
    <Field orientation="horizontal" data-disabled={disabled || undefined}>
      <FieldContent>
        <FieldLabelText form={form} path={path} label={label} />
        <FieldDescription>{description}</FieldDescription>
        {children}
      </FieldContent>
      <Switch id={fieldId(path)} checked={form.value(path) === true} disabled={disabled} onCheckedChange={(v) => form.set(path, v)} />
    </Field>
  )
}

export function NumberField({ form, path, label, description, unit, disabled }: FieldProps & { unit?: string }) {
  const spec = form.specs[path] as Extract<FieldSpec, { kind: 'number' }>
  const err = form.error(path)
  const input = (
    <InputGroupInput
      id={fieldId(path)}
      inputMode="numeric"
      className="tabular"
      placeholder={String(spec.default)}
      value={String(form.value(path))}
      aria-invalid={!!err}
      disabled={disabled}
      onChange={(e) => form.set(path, e.target.value)}
    />
  )
  return (
    <Field orientation="responsive" data-invalid={!!err || undefined} data-disabled={disabled || undefined}>
      <FieldContent>
        <FieldLabelText form={form} path={path} label={label} />
        <FieldDescription>{description}</FieldDescription>
        <FieldError>{err}</FieldError>
      </FieldContent>
      <InputGroup className="@md/field-group:w-36!">
        {input}
        {unit && (
          <InputGroupAddon align="inline-end">
            <InputGroupText>{unit}</InputGroupText>
          </InputGroupAddon>
        )}
      </InputGroup>
    </Field>
  )
}

export function TextField({
  form,
  path,
  label,
  description,
  placeholder,
  disabled,
  className,
  mono,
}: FieldProps & { placeholder?: string; className?: string; mono?: boolean }) {
  const spec = form.specs[path] as Extract<FieldSpec, { kind: 'text' }>
  const err = form.error(path)
  return (
    <Field orientation="responsive" data-invalid={!!err || undefined} data-disabled={disabled || undefined}>
      <FieldContent>
        <FieldLabelText form={form} path={path} label={label} />
        <FieldDescription>{description}</FieldDescription>
        <FieldError>{err}</FieldError>
      </FieldContent>
      <Input
        id={fieldId(path)}
        className={cn('@md/field-group:w-72!', mono && 'font-mono text-[13px]', className)}
        placeholder={placeholder ?? spec.default}
        value={String(form.value(path))}
        aria-invalid={!!err}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => form.set(path, e.target.value)}
      />
    </Field>
  )
}

export function SelectField({
  form,
  path,
  label,
  description,
  options,
}: FieldProps & { options: { value: string; label: string }[] }) {
  return (
    <Field orientation="responsive">
      <FieldContent>
        <FieldLabelText form={form} path={path} label={label} />
        <FieldDescription>{description}</FieldDescription>
      </FieldContent>
      <Select value={String(form.value(path))} onValueChange={(v) => form.set(path, v)}>
        <SelectTrigger id={fieldId(path)} className="@md/field-group:w-56!">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}
