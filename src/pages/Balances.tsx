import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase, check } from '../lib/supabase'
import { useSession } from '../lib/session'
import type { BalanceRow, OpeningBalance } from '../lib/types'
import { addMonths, downloadCsvUtf8, fromMonthInput, monthLabel, monthStart, toMonthInput, yen } from '../lib/format'
import { AccountSelect, Empty, ErrorBox, Field, Loading, MoneyInput, Notice, PageHeader } from '../components/ui'

interface ContractRef { id: number; contract_no: number; version: number; contract_name: string; property_code: number; vendor_name: string | null }
interface Suggest { contract_no: number; account_code: number; account_name: string; contract_name: string; property_name: string; amount: number; basis: string }

export default function Balances() {
  const { masters, propertyName, canEdit } = useSession()
  const [from, setFrom] = useState(addMonths(monthStart(), -5))
  const [to, setTo] = useState(monthStart())
  const [rows, setRows] = useState<BalanceRow[] | null>(null)
  const [refs, setRefs] = useState<Map<number, ContractRef>>(new Map())
  const [sel, setSel] = useState<{ account: number; period: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'balance' | 'opening'>('balance')

  const load = useCallback(async () => {
    setRows(null)
    setError(null)
    try {
      const [b, c] = await Promise.all([
        supabase.rpc('ct_accrual_balances', { p_from: from, p_to: to }),
        supabase.from('ct_contracts').select('id, contract_no, version, contract_name, property_code, vendor_name').order('version').range(0, 9999),
      ])
      setRows(check(b) as BalanceRow[])
      const m = new Map<number, ContractRef>()
      ;(check(c) as ContractRef[]).forEach((r) => m.set(r.contract_no, r))
      setRefs(m)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [from, to])

  useEffect(() => {
    load()
  }, [load])

  const months = useMemo(() => {
    const out: string[] = []
    for (let p = from; p <= to; p = addMonths(p, 1)) out.push(p)
    return out
  }, [from, to])

  const accrualAccounts = masters.accounts.filter((a) => a.is_accrual)

  const matrix = useMemo(() => {
    const m = new Map<string, { closing: number; debit: number; credit: number; opening: number; negatives: number }>()
    ;(rows ?? []).forEach((r) => {
      const k = `${r.account_code}|${r.period}`
      const v = m.get(k) ?? { closing: 0, debit: 0, credit: 0, opening: 0, negatives: 0 }
      v.closing += Number(r.closing)
      v.debit += Number(r.debit)
      v.credit += Number(r.credit)
      v.opening += Number(r.opening)
      if (Number(r.closing) < 0) v.negatives++
      m.set(k, v)
    })
    return m
  }, [rows])

  const detail = useMemo(() => {
    if (!sel || !rows) return []
    return rows
      .filter((r) => r.account_code === sel.account && r.period === sel.period)
      .sort((a, b) => Number(b.closing) - Number(a.closing))
  }, [sel, rows])

  function exportCsv() {
    if (!rows) return
    const head = ['年月', '科目コード', '科目名', '契約ID', '物件', '契約名', '月初残高', '借方', '貸方', '月末残高']
    const body = rows.map((r) => {
      const c = r.contract_no ? refs.get(r.contract_no) : undefined
      return [r.period.slice(0, 7), r.account_code, r.account_name, r.contract_no, c ? propertyName(c.property_code) : '', c?.contract_name ?? '', r.opening, r.debit, r.credit, r.closing]
    })
    downloadCsvUtf8([head, ...body], `経過勘定残高_${from.slice(0, 7)}_${to.slice(0, 7)}.csv`)
  }

  return (
    <>
      <PageHeader
        title="経過勘定残高"
        sub="前払費用・未払費用・未払金など、経過勘定として残高管理する科目の月末残高（税込）。月次計上・支払仕訳と開始残高から集計します。"
        actions={
          <>
            <input type="month" value={toMonthInput(from)} onChange={(e) => e.target.value && setFrom(fromMonthInput(e.target.value))} />
            <span>〜</span>
            <input type="month" value={toMonthInput(to)} onChange={(e) => e.target.value && setTo(fromMonthInput(e.target.value))} />
            <button onClick={exportCsv} disabled={!rows}>CSV出力</button>
          </>
        }
      />
      <ErrorBox error={error} />
      <div className="tabs">
        <button className={tab === 'balance' ? 'on' : ''} onClick={() => setTab('balance')}>月末残高</button>
        <button className={tab === 'opening' ? 'on' : ''} onClick={() => setTab('opening')}>開始残高</button>
      </div>

      {tab === 'balance' &&
        (!rows ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty>
            残高がありません。まず「開始残高」タブで運用開始月の残高を登録し、<Link to="/monthly">月次計上</Link>で仕訳を生成してください。
          </Empty>
        ) : (
          <>
            <div className="table-wrap">
              <table className="data matrix">
                <thead>
                  <tr>
                    <th>科目</th>
                    {months.map((m) => <th key={m} className="r">{monthLabel(m)}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {accrualAccounts.filter((a) => months.some((m) => matrix.has(`${a.code}|${m}`))).map((a) => (
                    <tr key={a.code}>
                      <th className="nowrap">{a.code} {a.name}<div className="muted small">{a.normal_side}残</div></th>
                      {months.map((m) => {
                        const v = matrix.get(`${a.code}|${m}`)
                        const on = sel?.account === a.code && sel.period === m
                        return (
                          <td key={m} className={`r mono clickable${on ? ' selected' : ''}`} onClick={() => setSel({ account: a.code, period: m })}>
                            {v ? yen(v.closing) : '—'}
                            {v && v.negatives > 0 && <div className="neg small">マイナス{v.negatives}件</div>}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted small">金額をクリックすると、その月の契約別内訳を表示します。</p>
            {sel && (
              <section className="card">
                <h2>
                  {sel.account} {masters.accounts.find((a) => a.code === sel.account)?.name}　{monthLabel(sel.period)}　契約別
                </h2>
                {detail.length === 0 ? (
                  <p className="muted">この月の残高・動きはありません。</p>
                ) : (
                  <table className="data compact">
                    <thead>
                      <tr><th>契約ID</th><th>物件</th><th>契約名</th><th className="r">月初残高</th><th className="r">借方</th><th className="r">貸方</th><th className="r">月末残高</th></tr>
                    </thead>
                    <tbody>
                      {detail.map((r) => {
                        const c = r.contract_no ? refs.get(r.contract_no) : undefined
                        return (
                          <tr key={`${r.contract_no}`}>
                            <td className="mono">{c ? <Link to={`/contracts/${c.id}`}>{r.contract_no}</Link> : r.contract_no ?? '（契約なし）'}</td>
                            <td className="nowrap">{c ? propertyName(c.property_code) : ''}</td>
                            <td className="ellipsis">{c?.contract_name}<span className="muted small">　{c?.vendor_name}</span></td>
                            <td className="r mono">{yen(r.opening)}</td>
                            <td className="r mono">{yen(r.debit)}</td>
                            <td className="r mono">{yen(r.credit)}</td>
                            <td className={`r mono${Number(r.closing) < 0 ? ' neg' : ''}`}>{yen(r.closing)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={3}>合計</td>
                        <td className="r mono">{yen(detail.reduce((a, r) => a + Number(r.opening), 0))}</td>
                        <td className="r mono">{yen(detail.reduce((a, r) => a + Number(r.debit), 0))}</td>
                        <td className="r mono">{yen(detail.reduce((a, r) => a + Number(r.credit), 0))}</td>
                        <td className="r mono">{yen(detail.reduce((a, r) => a + Number(r.closing), 0))}</td>
                      </tr>
                    </tfoot>
                  </table>
                )}
              </section>
            )}
          </>
        ))}

      {tab === 'opening' && <Opening defaultPeriod={from} canEdit={canEdit} refs={refs} onChanged={load} />}
    </>
  )
}

function Opening({ defaultPeriod, canEdit, refs, onChanged }: { defaultPeriod: string; canEdit: boolean; refs: Map<number, ContractRef>; onChanged: () => void }) {
  const { masters, propertyName } = useSession()
  const [period, setPeriod] = useState(defaultPeriod)
  const [list, setList] = useState<OpeningBalance[] | null>(null)
  const [suggest, setSuggest] = useState<Suggest[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [add, setAdd] = useState<{ contract_no: string; account: number | null; amount: number | null; note: string }>({ contract_no: '', account: null, amount: null, note: '' })

  const load = useCallback(async () => {
    setList(null)
    const r = await supabase.from('ct_opening_balances').select('*').eq('period', period).order('account_code').order('contract_no')
    if (r.error) setError(r.error.message)
    else setList(r.data as OpeningBalance[])
  }, [period])

  useEffect(() => {
    load()
    setSuggest(null)
  }, [load])

  async function preview() {
    setBusy(true)
    setError(null)
    const r = await supabase.rpc('ct_suggest_opening', { p_period: period })
    setBusy(false)
    if (r.error) setError(r.error.message)
    else setSuggest(r.data as Suggest[])
  }

  async function apply() {
    setBusy(true)
    setError(null)
    const r = await supabase.rpc('ct_apply_suggested_opening', { p_period: period })
    setBusy(false)
    if (r.error) setError(r.error.message)
    else {
      setMsg(`${r.data} 件の開始残高を登録しました`)
      setSuggest(null)
      load()
      onChanged()
    }
  }

  async function addOne() {
    if (!add.account || add.amount == null) {
      setError('科目と金額を入力してください')
      return
    }
    const r = await supabase.from('ct_opening_balances').insert({
      period,
      contract_no: add.contract_no ? Number(add.contract_no) : null,
      account_code: add.account,
      amount: add.amount,
      note: add.note || '手入力',
    })
    if (r.error) setError(r.error.message)
    else {
      setAdd({ contract_no: '', account: null, amount: null, note: '' })
      load()
      onChanged()
    }
  }

  async function del(id: number) {
    const r = await supabase.from('ct_opening_balances').delete().eq('id', id)
    if (r.error) setError(r.error.message)
    else {
      load()
      onChanged()
    }
  }

  const sumBy = (xs: { account_code: number; amount: number }[]) => {
    const m = new Map<number, number>()
    xs.forEach((x) => m.set(x.account_code, (m.get(x.account_code) ?? 0) + Number(x.amount)))
    return [...m.entries()]
  }

  return (
    <section className="card">
      <h2>開始残高（運用開始月の月初残高）</h2>
      <p className="muted small">
        このアプリで仕訳を作り始める前の時点で残っている前払費用・未払費用などです。契約の支払ルールから自動計算できます
        （月次契約：未払いのままの過去月分／前月払い分、年次契約：未償却の前払額・未払の累計額）。
        会計ソフトの残高と突き合わせて、差があれば手入力で調整してください。
      </p>
      <ErrorBox error={error} />
      {msg && <Notice tone="ok">{msg}</Notice>}
      <div className="row wrap">
        <Field label="対象月（この月の月初残高）">
          <input type="month" value={toMonthInput(period)} onChange={(e) => e.target.value && setPeriod(fromMonthInput(e.target.value))} />
        </Field>
        {canEdit && <button onClick={preview} disabled={busy}>自動計算（プレビュー）</button>}
        {canEdit && suggest && <button className="primary" onClick={apply} disabled={busy}>この内容で登録（既存を置き換え）</button>}
      </div>

      {suggest && (
        <>
          <h3>自動計算の結果（{suggest.length} 件・未登録）</h3>
          <div className="sum-line">
            {sumBy(suggest).map(([code, amt]) => (
              <span key={code}>{code} {masters.accounts.find((a) => a.code === code)?.name}：<b>{yen(amt)}</b> 円</span>
            ))}
          </div>
          <div className="table-wrap short">
            <table className="data compact">
              <thead><tr><th>契約ID</th><th>物件</th><th>契約名</th><th>科目</th><th className="r">金額</th><th>根拠</th></tr></thead>
              <tbody>
                {suggest.map((s, i) => (
                  <tr key={i}>
                    <td className="mono">{s.contract_no}</td>
                    <td className="nowrap">{s.property_name}</td>
                    <td className="ellipsis">{s.contract_name}</td>
                    <td className="nowrap">{s.account_name}</td>
                    <td className={`r mono${s.amount < 0 ? ' neg' : ''}`}>{yen(s.amount)}</td>
                    <td className="small">{s.basis}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h3>登録済みの開始残高（{monthLabel(period)}）</h3>
      {!list ? (
        <Loading />
      ) : list.length === 0 ? (
        <p className="muted">未登録です。</p>
      ) : (
        <>
          <div className="sum-line">
            {sumBy(list).map(([code, amt]) => (
              <span key={code}>{code} {masters.accounts.find((a) => a.code === code)?.name}：<b>{yen(amt)}</b> 円</span>
            ))}
          </div>
          <div className="table-wrap short">
            <table className="data compact">
              <thead><tr><th>契約ID</th><th>物件</th><th>契約名</th><th>科目</th><th className="r">金額</th><th>メモ</th><th /></tr></thead>
              <tbody>
                {list.map((o) => {
                  const c = o.contract_no ? refs.get(o.contract_no) : undefined
                  return (
                    <tr key={o.id}>
                      <td className="mono">{o.contract_no}</td>
                      <td className="nowrap">{c ? propertyName(c.property_code) : ''}</td>
                      <td className="ellipsis">{c?.contract_name}</td>
                      <td className="nowrap">{o.account_code} {masters.accounts.find((a) => a.code === o.account_code)?.name}</td>
                      <td className="r mono">{yen(o.amount)}</td>
                      <td className="small">{o.note}</td>
                      <td>{canEdit && <button className="small" onClick={() => del(o.id)}>削除</button>}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      {canEdit && (
        <div className="row wrap add-row">
          <Field label="契約ID（任意）"><input className="mono" value={add.contract_no} onChange={(e) => setAdd({ ...add, contract_no: e.target.value })} /></Field>
          <Field label="科目"><AccountSelect value={add.account} onChange={(v) => setAdd({ ...add, account: v })} accounts={masters.accounts} filter={(a) => a.is_accrual} /></Field>
          <Field label="金額（正残でプラス）"><MoneyInput value={add.amount} onChange={(v) => setAdd({ ...add, amount: v })} /></Field>
          <Field label="メモ"><input value={add.note} onChange={(e) => setAdd({ ...add, note: e.target.value })} /></Field>
          <button onClick={addOne}>追加</button>
        </div>
      )}
    </section>
  )
}
