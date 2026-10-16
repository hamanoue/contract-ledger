// 契約期間の判定：解約・期間内・自動更新中・期限切れ を見分け、「今期の終了日」を求める
import type { Contract } from './types'

export type TermKind = 'cancel' | 'active' | 'auto' | 'expired' | 'none'

export interface TermInfo {
  kind: TermKind
  /** 表示・アラートに使う日付（解約日／今期の終了日／過ぎた終了日）。'none' は null */
  date: string | null
  /** 登録されているサービス終了日（自動更新中は元の終了日） */
  originalEnd: string | null
  /** 自動更新の期間（か月）。自動更新中のときだけ */
  termMonths: number | null
  /** 更新期間がどこから来たか */
  termSource: 'input' | 'period' | 'default' | null
}

const toYmd = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`

const lastDay = (y: number, m: number) => new Date(y, m, 0).getDate()

/** n か月後の日付。元が月末なら月末にそろえる（3/31 → 6/30 → 9/30） */
export function addMonthsKeepEnd(iso: string, n: number): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  const t = new Date(y, m - 1 + n, 1)
  const ty = t.getFullYear()
  const tm = t.getMonth() + 1
  const end = lastDay(ty, tm)
  return toYmd(ty, tm, d >= lastDay(y, m) ? end : Math.min(d, end))
}

/** 開始日〜終了日の長さ（か月）。2025-04-01〜2026-03-31 → 12。1か月未満・読めない場合は null */
export function termMonthsOf(start: string | null, end: string | null): number | null {
  if (!start || !end || end < start) return null
  const [sy, sm, sd] = start.slice(0, 10).split('-').map(Number)
  const [ey, em, ed] = end.slice(0, 10).split('-').map(Number)
  // 終了日の翌日までの月数（端数は四捨五入）
  const next = new Date(ey, em - 1, ed + 1)
  const months = (next.getFullYear() - sy) * 12 + (next.getMonth() + 1 - sm) + (next.getDate() - sd) / 30
  const r = Math.round(months)
  return r >= 1 ? r : null
}

export const todayIso = () => {
  const d = new Date()
  return toYmd(d.getFullYear(), d.getMonth() + 1, d.getDate())
}

type TermFields = Pick<Contract, 'cancel_date' | 'service_start' | 'service_end' | 'renewal_type'> &
  Partial<Pick<Contract, 'renewal_term_months'>>

export function termInfo(c: TermFields, today = todayIso()): TermInfo {
  const base = { originalEnd: c.service_end ?? null, termMonths: null, termSource: null } as const
  if (c.cancel_date) return { ...base, kind: 'cancel', date: c.cancel_date }
  if (!c.service_end) return { ...base, kind: 'none', date: null }
  if (c.service_end >= today) return { ...base, kind: 'active', date: c.service_end }
  if (c.renewal_type !== '自動更新') return { ...base, kind: 'expired', date: c.service_end }

  const fromPeriod = termMonthsOf(c.service_start, c.service_end)
  const term = c.renewal_term_months || fromPeriod || 12
  const source = c.renewal_term_months ? 'input' : fromPeriod ? 'period' : 'default'
  let end = c.service_end
  for (let k = 1; end < today && k <= 1200; k++) end = addMonthsKeepEnd(c.service_end, term * k)
  return { kind: 'auto', date: end, originalEnd: c.service_end, termMonths: term, termSource: source }
}

export const TERM_KIND_LABEL: Record<TermKind, string> = {
  active: '期間内',
  auto: '自動更新中',
  expired: '期限切れ（要確認）',
  cancel: '解約・解約予定',
  none: '終了日未入力',
}

export const TERM_SOURCE_LABEL ={ input: '入力値', period: '契約期間から計算', default: '未設定のため12か月' } as const
