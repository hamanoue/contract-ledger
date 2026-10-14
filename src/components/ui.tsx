import { useEffect, useState, type ReactNode } from 'react'
import type { Account } from '../lib/types'

export function PageHeader({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {sub && <p className="sub">{sub}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  )
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'info' | 'muted' }) {
  return <span className={`badge badge-${tone}`}>{children}</span>
}

export function judgementTone(j: string): 'ok' | 'warn' | 'bad' | 'info' | 'muted' {
  switch (j) {
    case '計上':
    case '対象':
    case '契約中':
      return 'ok'
    case '実績入力済':
      return 'info'
    case '実績入力待ち':
    case '解約予定':
    case '申請中':
      return 'warn'
    case '要設定':
      return 'bad'
    default:
      return 'muted'
  }
}

export function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null
  return <div className="alert alert-bad">{error}</div>
}

export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' | 'ok' }) {
  return <div className={`alert alert-${tone}`}>{children}</div>
}

export function Field({ label, children, hint, wide, required }: { label: string; children: ReactNode; hint?: string; wide?: boolean; required?: boolean }) {
  return (
    <label className={`field${wide ? ' wide' : ''}`}>
      <span className="field-label">
        {label}
        {required && <em className="req">必須</em>}
      </span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}

export function Select({ value, onChange, options, placeholder = '—', disabled }: {
  value: string | number | null | undefined
  onChange: (v: string) => void
  options: (string | { value: string | number; label: string })[]
  placeholder?: string
  disabled?: boolean
}) {
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
      <option value="">{placeholder}</option>
      {options.map((o) =>
        typeof o === 'string' ? (
          <option key={o} value={o}>{o}</option>
        ) : (
          <option key={o.value} value={o.value}>{o.label}</option>
        ),
      )}
    </select>
  )
}

export function AccountSelect({ value, onChange, accounts, filter, disabled }: {
  value: number | null
  onChange: (v: number | null) => void
  accounts: Account[]
  filter?: (a: Account) => boolean
  disabled?: boolean
}) {
  const list = accounts.filter((a) => a.is_active && (!filter || filter(a) || a.code === value))
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)} disabled={disabled}>
      <option value="">—</option>
      {list.map((a) => (
        <option key={a.code} value={a.code}>
          {a.code} {a.name}
        </option>
      ))}
    </select>
  )
}

/** カンマ区切りで表示する金額入力 */
export function MoneyInput({ value, onChange, disabled, placeholder }: {
  value: number | null | undefined
  onChange: (v: number | null) => void
  disabled?: boolean
  placeholder?: string
}) {
  const [text, setText] = useState(value === null || value === undefined ? '' : Number(value).toLocaleString('ja-JP'))
  const [focus, setFocus] = useState(false)
  useEffect(() => {
    if (!focus) setText(value === null || value === undefined ? '' : Number(value).toLocaleString('ja-JP'))
  }, [value, focus])
  return (
    <input
      className="num"
      inputMode="numeric"
      value={text}
      disabled={disabled}
      placeholder={placeholder}
      onFocus={() => {
        setFocus(true)
        setText(value === null || value === undefined ? '' : String(value))
      }}
      onBlur={() => setFocus(false)}
      onChange={(e) => {
        setText(e.target.value)
        const s = e.target.value.replaceAll(',', '').trim()
        if (s === '') onChange(null)
        else if (/^-?\d+$/.test(s)) onChange(Number(s))
      }}
    />
  )
}

export function Loading({ label = '読み込み中…' }: { label?: string }) {
  return <div className="loading">{label}</div>
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>
}

export function Stat({ label, value, tone, sub }: { label: string; value: ReactNode; tone?: 'warn' | 'bad' | 'ok'; sub?: ReactNode }) {
  return (
    <div className={`stat${tone ? ' stat-' + tone : ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  )
}
