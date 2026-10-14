import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase, check } from '../lib/supabase'
import { useSession } from '../lib/session'
import type { CalcRow } from '../lib/types'
import { addMonths, fromMonthInput, monthLabel, monthStart, toMonthInput, yen } from '../lib/format'
import { Badge, Empty, ErrorBox, Loading, MoneyInput, Notice, PageHeader, Select, Stat, judgementTone } from '../components/ui'

type Filter = '' | '計上' | '実績' | '要設定' | '対象外'

export default function Monthly() {
  const { isAccounting, canEdit, isAdmin, masters } = useSession()
  const [period, setPeriod] = useState(monthStart())
  const [rows, setRows] = useState<CalcRow[] | null>(null)
  const [closed, setClosed] = useState(false)
  const [generated, setGenerated] = useState<{ accrual: number; payment: number; exported: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState<Filter>('')
  const [prop, setProp] = useState('')
  const [drafts, setDrafts] = useState<Record<number, number | null>>({})

  const load = useCallback(async () => {
    setRows(null)
    setError(null)
    try {
      const [c, p] = await Promise.all([
        supabase.rpc('ct_calc_month', { p_period: period }),
        supabase.from('ct_periods').select('status').eq('period', period).maybeSingle(),
      ])
      setRows(check(c) as CalcRow[])
      setClosed((p.data as { status: string } | null)?.status === 'closed')
      setDrafts({})
      if (isAccounting) {
        const j = check(await supabase.from('ct_journal_entries').select('entry_type, exported_at').eq('period', period).eq('source', 'auto').range(0, 9999)) as {
          entry_type: string
          exported_at: string | null
        }[]
        setGenerated({
          accrual: j.filter((x) => x.entry_type === 'accrual').length,
          payment: j.filter((x) => x.entry_type === 'payment').length,
          exported: j.filter((x) => x.exported_at).length,
        })
      }
    } catch (e) {
      setError((e as Error).message)
    }
  }, [period, isAccounting])

  useEffect(() => {
    load()
  }, [load])

  const shown = useMemo(() => {
    if (!rows) return []
    return rows.filter((r) => {
      if (prop && String(r.property_code) !== prop) return false
      if (filter === '計上') return r.judgement === '計上' || r.judgement === '実績入力済'
      if (filter === '実績') return r.judgement === '実績入力待ち' || r.judgement === '実績入力済'
      if (filter === '要設定') return r.judgement === '要設定'
      if (filter === '対象外') return r.judgement === '対象外'
      return r.judgement !== '対象外'
    })
  }, [rows, filter, prop])

  const sum = useMemo(() => {
    const r = rows ?? []
    const posted = r.filter((x) => x.judgement === '計上' || x.judgement === '実績入力済')
    return {
      count: posted.length,
      excl: posted.reduce((a, x) => a + Number(x.amount_excl ?? 0), 0),
      incl: posted.reduce((a, x) => a + Number(x.amount_incl ?? 0), 0),
      waiting: r.filter((x) => x.judgement === '実績入力待ち').length,
      needs: r.filter((x) => x.judgement === '要設定').length,
    }
  }, [rows])

  async function saveActual(r: CalcRow) {
    const v = drafts[r.contract_id]
    setBusy(true)
    setError(null)
    try {
      if (v === null || v === undefined) {
        check(await supabase.from('ct_monthly_actuals').delete().eq('contract_id', r.contract_id).eq('period', period))
      } else {
        check(await supabase.from('ct_monthly_actuals').upsert({ contract_id: r.contract_id, period, amount_excl: v, tax_amount: null }))
      }
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function generate() {
    setBusy(true)
    setError(null)
    setMsg(null)
    const { data, error } = await supabase.rpc('ct_generate_month', { p_period: period })
    setBusy(false)
    if (error) setError(error.message)
    else {
      const d = data as { accrual: number; payment: number; kept_exported: number }
      setMsg(`${monthLabel(period)}の仕訳を生成しました：計上 ${d.accrual} 行・支払 ${d.payment} 行${d.kept_exported ? `（CSV出力済みの ${d.kept_exported} 件はそのまま残しました）` : ''}`)
      load()
    }
  }

  async function setStatus(status: 'open' | 'closed') {
    setBusy(true)
    setError(null)
    const { error } = await supabase.rpc('ct_set_period_status', { p_period: period, p_status: status })
    setBusy(false)
    if (error) setError(error.message)
    else load()
  }

  const usedProps = useMemo(() => {
    const set = new Set((rows ?? []).map((r) => r.property_code))
    return masters.properties.filter((p) => set.has(p.code))
  }, [rows, masters.properties])

  return (
    <>
      <PageHeader
        title="月次計上"
        sub="契約マスタから当月の計上額を計算します。従量・手入力の契約は、当月の実績（税抜）を入力してください。"
        actions={
          <div className="month-nav">
            <button onClick={() => setPeriod(addMonths(period, -1))} aria-label="前月">◀</button>
            <input type="month" value={toMonthInput(period)} onChange={(e) => e.target.value && setPeriod(fromMonthInput(e.target.value))} />
            <button onClick={() => setPeriod(addMonths(period, 1))} aria-label="翌月">▶</button>
          </div>
        }
      />
      <ErrorBox error={error} />
      {msg && <Notice tone="ok">{msg} <Link to={`/journals?period=${period}`}>仕訳を確認 →</Link></Notice>}
      {closed && <Notice tone="warn">{monthLabel(period)}は締め済みです。実績入力・仕訳の変更はできません。</Notice>}

      <div className="stats">
        <Stat label="計上件数" value={sum.count} />
        <Stat label="税抜合計" value={`${yen(sum.excl)} 円`} />
        <Stat label="税込合計" value={`${yen(sum.incl)} 円`} />
        <Stat label="実績入力待ち" value={sum.waiting} tone={sum.waiting ? 'warn' : 'ok'} />
        <Stat label="要設定" value={sum.needs} tone={sum.needs ? 'bad' : 'ok'} />
        {isAccounting && generated && (
          <Stat
            label="仕訳"
            value={generated.accrual ? `生成済` : '未生成'}
            tone={generated.accrual ? 'ok' : 'warn'}
            sub={generated.accrual ? `計上${generated.accrual}・支払${generated.payment}・出力済${generated.exported}` : undefined}
          />
        )}
      </div>

      {isAccounting && canEdit && (
        <div className="toolbar">
          <button className="primary" onClick={generate} disabled={busy || closed}>
            {generated?.accrual ? '仕訳を作り直す' : '仕訳を生成'}
          </button>
          <span className="muted small">
            計上仕訳（費用／経過勘定）と、支払月に応じた支払仕訳（経過勘定／{masters.settings.find((s) => s.key === 'cash_account')?.value ?? '預金'}）を作ります。CSV出力済みの仕訳は作り直しません。
          </span>
          <span className="spacer" />
          {closed ? (
            isAdmin && <button onClick={() => setStatus('open')} disabled={busy}>締めを解除</button>
          ) : (
            <button onClick={() => setStatus('closed')} disabled={busy || !generated?.accrual}>この月を締める</button>
          )}
        </div>
      )}

      <div className="filters">
        <div className="seg">
          {(['', '計上', '実績', '要設定', '対象外'] as Filter[]).map((f) => (
            <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
              {f === '' ? '対象外以外' : f === '実績' ? '従量・手入力' : f}
            </button>
          ))}
        </div>
        <Select value={prop} onChange={setProp} placeholder="すべての物件" options={usedProps.map((p) => ({ value: p.code, label: `${p.code} ${p.name}` }))} />
      </div>

      {!rows ? (
        <Loading />
      ) : shown.length === 0 ? (
        <Empty>該当する契約はありません。</Empty>
      ) : (
        <div className="table-wrap">
          <table className="data narrow-text">
            <thead>
              <tr>
                <th>判定</th>
                <th>契約ID</th>
                <th>物件</th>
                <th>取引先</th>
                <th>契約名</th>
                <th>条件</th>
                <th className="r">実績（税抜）</th>
                <th className="r">税抜</th>
                <th className="r">消費税</th>
                <th className="r">税込</th>
                <th>確認事項</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const variable = r.amount_basis === '従量' || r.amount_basis === '手入力'
                const draft = r.contract_id in drafts ? drafts[r.contract_id] : r.actual_excl
                const dirty = r.contract_id in drafts && drafts[r.contract_id] !== r.actual_excl
                return (
                  <tr key={r.contract_id}>
                    <td><Badge tone={judgementTone(r.judgement)}>{r.judgement}</Badge></td>
                    <td className="mono nowrap"><Link to={`/contracts/${r.contract_id}`}>{r.contract_no}-{r.version}</Link></td>
                    <td className="nowrap">{r.property_name}</td>
                    <td className="ellipsis" title={r.vendor_name ?? ''}>{r.vendor_name}</td>
                    <td className="ellipsis" title={r.contract_name}>{r.contract_name}</td>
                    <td className="small nowrap">
                      {r.billing_cycle}・{r.amount_basis}
                      <div className="muted">{r.billing_cycle === '年次' && r.annual_payment_month ? `毎年${r.annual_payment_month}月払`
                        : r.billing_cycle === '半年' && r.annual_payment_month ? `${r.annual_payment_month}月・${((r.annual_payment_month + 5) % 12) + 1}月払`
                        : r.payment_timing}</div>
                    </td>
                    <td className="r">
                      {variable && r.judgement !== '対象外' && r.judgement !== '要設定' ? (
                        <div className="row tight end">
                          <MoneyInput value={draft} onChange={(v) => setDrafts((d) => ({ ...d, [r.contract_id]: v }))} disabled={closed || !canEdit} placeholder="未入力" />
                          {dirty && <button className="small primary" onClick={() => saveActual(r)} disabled={busy}>保存</button>}
                        </div>
                      ) : null}
                    </td>
                    <td className="r mono">{yen(r.amount_excl)}</td>
                    <td className="r mono">{yen(r.tax_amount)}</td>
                    <td className="r mono">{yen(r.amount_incl)}</td>
                    <td className="small">{r.issues}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
