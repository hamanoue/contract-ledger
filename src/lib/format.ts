export const yen = (v: number | null | undefined): string =>
  v === null || v === undefined || Number.isNaN(v) ? '' : Math.round(Number(v)).toLocaleString('ja-JP')

export const dateJa = (v: string | null | undefined): string => (v ? v.slice(0, 10).replaceAll('-', '/') : '')

/** 'YYYY-MM-01' */
export const monthStart = (d = new Date()): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`

export const addMonths = (ym: string, n: number): string => {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(y, m - 1 + n, 1)
  return monthStart(d)
}

export const monthLabel = (ym: string): string => {
  const [y, m] = ym.split('-').map(Number)
  return `${y}年${m}月`
}

/** <input type="month"> の値 ⇔ 'YYYY-MM-01' */
export const toMonthInput = (ym: string) => ym.slice(0, 7)
export const fromMonthInput = (v: string) => (v ? `${v}-01` : '')

export const daysUntil = (iso: string | null): number | null => {
  if (!iso) return null
  const t = new Date(iso + 'T00:00:00').getTime()
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.round((t - today.getTime()) / 86400000)
}

export const subtractMonths = (iso: string, n: number): string => {
  const d = new Date(iso + 'T00:00:00')
  d.setMonth(d.getMonth() - n)
  return d.toISOString().slice(0, 10)
}

export const toNumberOrNull = (v: string): number | null => {
  const s = v.replaceAll(',', '').trim()
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** 文字列をCSV用にエスケープ */
export const csvCell = (v: unknown): string => {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

export function downloadBlob(data: BlobPart, filename: string, type: string) {
  const blob = new Blob([data], { type })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

/** Excel用（UTF-8 BOM付き）で一覧をダウンロード */
export function downloadCsvUtf8(rows: unknown[][], filename: string) {
  const text = rows.map((r) => r.map(csvCell).join(',')).join('\r\n')
  downloadBlob('﻿' + text, filename, 'text/csv;charset=utf-8')
}
