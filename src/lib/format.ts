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

/**
 * 手入力の日付を 'YYYY-MM-DD' に直す。空なら null、読めなければ undefined。
 * 受け付ける形：2026/10/1・2026-10-01・2026.10.1・2026年10月1日・20261001・10/1（今年）
 */
export const parseDateInput = (text: string): string | null | undefined => {
  const s = text.normalize('NFKC').trim()
  if (!s) return null
  let y: number, m: number, d: number
  let r: RegExpMatchArray | null
  if ((r = s.match(/^(\d{4})[/\-.年](\d{1,2})[/\-.月](\d{1,2})日?$/))) [y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])]
  else if ((r = s.match(/^(\d{4})(\d{2})(\d{2})$/))) [y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])]
  else if ((r = s.match(/^(\d{1,2})[/\-.月](\d{1,2})日?$/))) [y, m, d] = [new Date().getFullYear(), Number(r[1]), Number(r[2])]
  else return undefined
  const dt = new Date(y, m - 1, d)
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return undefined
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** n か月前の同じ日（その月に無い日は月末）。ローカル日付で計算する（toISOString は UTC になり1日ずれるため使わない） */
export const subtractMonths = (iso: string, n: number): string => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  const first = new Date(y, m - 1 - n, 1)
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
  return `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`
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
