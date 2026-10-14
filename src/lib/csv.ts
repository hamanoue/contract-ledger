import Encoding from 'encoding-japanese'
import type { JournalEntry, TaxCode } from './types'
import { csvCell } from './format'

/** シート「仕訳CSV」と同じ28列 */
export const JOURNAL_CSV_HEADER = [
  '伝票日付', '借方科目コード', '借方科目別補助コード', '借方部門コード', '借方取引先コード', '借方銀行コード', '借方ｾｸﾞﾒﾝﾄ1コード',
  '(コクヨ)借方消費税コード', '(コクヨ)借方消費税率区分', '(コクヨ)借方金額', '(コクヨ)借方消費税額', '期日',
  '貸方科目コード', '貸方科目別補助コード', '貸方部門コード', '貸方取引先コード', '貸方銀行コード', '貸方ｾｸﾞﾒﾝﾄ1コード',
  '(コクヨ)貸方消費税コード', '(コクヨ)貸方消費税率区分', '(コクヨ)貸方金額', '(コクヨ)貸方消費税額',
  '摘要', 'ダミー項目', '伝票NO', '仕訳入力形式', '(コクヨ)借方外税同時入力区分', '(コクヨ)貸方外税同時入力区分',
]

export interface CsvOptions {
  taxCodes: TaxCode[]
  setting: (key: string) => string
  startSlipNo: number
}

function fmtDate(iso: string, pattern: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-')
  return pattern === 'yyyyMMdd' ? `${y}${m}${d}` : `${y}/${m}/${d}`
}

export function buildJournalRows(entries: JournalEntry[], o: CsvOptions): string[][] {
  const tax = new Map(o.taxCodes.map((t) => [t.name, t]))
  const none = o.setting('csv_tax_code_none')
  const on = o.setting('csv_sotozei_on')
  const off = o.setting('csv_sotozei_off')
  const fmt = o.setting('csv_input_format')
  const datePattern = o.setting('csv_date_format') || 'yyyy/MM/dd'
  return entries.map((e, i) => {
    const drTax = e.dr_tax_code ? tax.get(e.dr_tax_code) : undefined
    const crTax = e.cr_tax_code ? tax.get(e.cr_tax_code) : undefined
    const s = (v: unknown) => (v === null || v === undefined ? '' : String(v))
    return [
      fmtDate(e.entry_date, datePattern),
      s(e.dr_account), s(e.dr_sub_code), s(e.dr_dept), s(e.dr_vendor), '', '',
      drTax ? s(drTax.kokuyo_tax_code) : none, drTax ? s(drTax.kokuyo_rate_kbn) : '',
      s(e.dr_amount), s(e.dr_tax_amount || ''), '',
      s(e.cr_account), s(e.cr_sub_code), s(e.cr_dept), s(e.cr_vendor), '', '',
      crTax ? s(crTax.kokuyo_tax_code) : none, crTax ? s(crTax.kokuyo_rate_kbn) : '',
      s(e.cr_amount), s(e.cr_tax_amount || ''),
      s(e.description), '', String(o.startSlipNo + i), fmt,
      Number(e.dr_tax_amount) ? on : off, Number(e.cr_tax_amount) ? on : off,
    ]
  })
}

export function encodeCsv(rows: string[][], encoding: string): Uint8Array | string {
  const text = rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
  if (encoding.toUpperCase().replace('-', '_') === 'SHIFT_JIS' || encoding.toUpperCase() === 'SJIS') {
    const codes = Encoding.convert(Encoding.stringToCode(text), { to: 'SJIS', from: 'UNICODE' })
    return new Uint8Array(codes)
  }
  return '﻿' + text
}
