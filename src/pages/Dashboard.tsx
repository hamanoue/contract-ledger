import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useSession } from '../lib/session'
import type { ContractView } from '../lib/types'
import { dateJa, daysUntil, monthLabel, monthStart, subtractMonths, yen } from '../lib/format'
import { Badge, ErrorBox, Loading, PageHeader, Stat } from '../components/ui'
import { fetchContracts } from './Contracts'
import { termInfo } from '../lib/term'

interface Alert {
  c: ContractView
  kind: '解約通知期限' | '契約終了' | '自動更新日' | '期限切れ'
  date: string
  days: number
}

export default function Dashboard() {
  const { profile, isAccounting } = useSession()
  const [rows, setRows] = useState<ContractView[] | null>(null)
  const [period, setPeriod] = useState<{ generated: number; closed: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const thisMonth = monthStart()

  useEffect(() => {
    fetchContracts().then(setRows).catch((e) => setError(e.message))
    if (isAccounting) {
      Promise.all([
        supabase.from('ct_journal_entries').select('id', { count: 'exact', head: true }).eq('period', thisMonth).eq('entry_type', 'accrual'),
        supabase.from('ct_periods').select('status').eq('period', thisMonth).maybeSingle(),
      ]).then(([j, p]) => setPeriod({ generated: j.count ?? 0, closed: (p.data as { status: string } | null)?.status === 'closed' }))
    }
  }, [isAccounting, thisMonth])

  const stats = useMemo(() => {
    if (!rows) return null
    const maxVer = new Map<number, number>()
    rows.forEach((r) => maxVer.set(r.contract_no, Math.max(maxVer.get(r.contract_no) ?? 0, r.version)))
    const live = rows.filter((r) => r.is_active && r.status !== '解約済' && r.status !== '停止')
    const alerts: Alert[] = []
    live.forEach((r) => {
      if (r.version !== maxVer.get(r.contract_no)) return
      // 自動更新中は「今期の終了日（次回更新日）」で判定する
      const t = termInfo(r)
      if (!t.date) return
      if (t.kind === 'expired') {
        alerts.push({ c: r, kind: '期限切れ', date: t.date, days: daysUntil(t.date)! })
        return
      }
      if (r.notice_months != null && t.kind !== 'cancel') {
        const deadline = subtractMonths(t.date, r.notice_months)
        const d = daysUntil(deadline)!
        if (d <= 60 && d >= -30) alerts.push({ c: r, kind: '解約通知期限', date: deadline, days: d })
      }
      const d2 = daysUntil(t.date)!
      if (d2 <= 90 && d2 >= -30) alerts.push({ c: r, kind: t.kind === 'auto' ? '自動更新日' : '契約終了', date: t.date, days: d2 })
    })
    alerts.sort((a, b) => a.days - b.days)
    return {
      total: rows.length,
      live: live.length,
      monthly: live.reduce((a, r) => a + Number(r.monthly_excl ?? 0), 0),
      needs: rows.filter((r) => r.calc_target === '要設定'),
      variable: live.filter((r) => r.amount_basis === '従量' || r.amount_basis === '手入力').length,
      alerts,
    }
  }, [rows])

  return (
    <>
      <PageHeader title="ダッシュボード" sub={`${profile?.display_name ?? ''}さん（${profile?.department}）`} />
      <ErrorBox error={error} />
      {!stats ? (
        <Loading />
      ) : (
        <>
          <div className="stats">
            <Stat label="登録契約（全枝番）" value={stats.total} />
            <Stat label="有効な契約" value={stats.live} />
            <Stat label="月額換算（税抜）" value={`${yen(stats.monthly)} 円`} sub="月額＋年額÷12" />
            <Stat label="要設定" value={stats.needs.length} tone={stats.needs.length ? 'bad' : 'ok'} sub="計上に必要な項目が未入力" />
            <Stat label="従量・手入力の契約" value={stats.variable} sub="毎月の実績入力が必要" />
            {isAccounting && period && (
              <Stat
                label={`${monthLabel(thisMonth)}の仕訳`}
                value={period.closed ? '締め済' : period.generated ? '生成済' : '未生成'}
                tone={period.closed ? 'ok' : period.generated ? undefined : 'warn'}
                sub={<Link to="/monthly">月次計上へ</Link>}
              />
            )}
          </div>

          <div className="two-col">
            <section className="card">
              <h2>更新・解約の期限（60〜90日以内）・期限切れ</h2>
              {stats.alerts.length === 0 ? (
                <p className="muted">直近の期限はありません。解約通知の「何か月前」とサービス終了日を入れると、ここに表示されます。</p>
              ) : (
                <table className="data compact">
                  <thead><tr><th>期限</th><th>種類</th><th>物件</th><th>契約</th><th>更新</th></tr></thead>
                  <tbody>
                    {stats.alerts.map((a, i) => (
                      <tr key={i}>
                        <td className="nowrap">
                          {dateJa(a.date)} <Badge tone={a.days < 0 ? 'bad' : a.days <= 30 ? 'warn' : 'neutral'}>{a.days < 0 ? `${-a.days}日超過` : `あと${a.days}日`}</Badge>
                        </td>
                        <td className={`nowrap${a.kind === '期限切れ' ? ' danger-text' : ''}`}
                          title={a.kind === '期限切れ' ? '自動更新ではない契約で、サービス終了日を過ぎています。更新・解約の状況を確認してください' : undefined}>{a.kind}</td>
                        <td className="nowrap">{a.c.property_name}</td>
                        <td><Link to={`/contracts/${a.c.id}`}>{a.c.contract_name}</Link><div className="muted small">{a.c.vendor_name}</div></td>
                        <td className="nowrap small">{a.c.renewal_type}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
            <section className="card">
              <h2>要設定の契約</h2>
              {stats.needs.length === 0 ? (
                <p className="muted">すべての有効契約が計上できる状態です。</p>
              ) : (
                <table className="data compact">
                  <thead><tr><th>契約</th><th>確認事項</th></tr></thead>
                  <tbody>
                    {stats.needs.slice(0, 30).map((r) => (
                      <tr key={r.id}>
                        <td><Link to={`/contracts/${r.id}`}>{r.contract_no}-{r.version}</Link> {r.property_name}<div className="small">{r.contract_name}</div></td>
                        <td className="small">{r.issues}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>
        </>
      )}
    </>
  )
}
