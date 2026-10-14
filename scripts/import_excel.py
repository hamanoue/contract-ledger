#!/usr/bin/env python3
"""
「01.定期契約マスタ.xlsx」から初期データ投入用SQLを生成する。

使い方:
    python3 scripts/import_excel.py <01.定期契約マスタ.xlsx> > supabase/seed/seed_data.sql

取り込みルール
- 物件・勘定科目・選択肢・取引先・契約をupsert（ON CONFLICT）で投入
- 契約ID＋枝番が重複している行:
    * 同じ取引先で「ビル（200未満）＋ホテル（201〜299）」の組合せ → 1契約＋按分行に統合
    * それ以外 → 2行目以降に同じ物件の次の契約IDを採番し、備考2に旧契約IDを残す
- 物件コード1（本社）の契約は総務経理部のみ閲覧（accounting_only）
- 経過勘定として残高管理する科目: 1550 前払費用 / 3140 未払金 / 3150 未払費用
"""
import re
import sys
import datetime
from collections import defaultdict, OrderedDict

import openpyxl

ACCRUAL_ACCOUNTS = {1550, 3140, 3150, 1530, 3160}
HEAD_OFFICE_CODES = {1}


def q(v):
    if v is None or v == "":
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        if isinstance(v, float) and v.is_integer():
            v = int(v)
        return str(v)
    if isinstance(v, (datetime.datetime, datetime.date)):
        return "'" + v.strftime("%Y-%m-%d") + "'"
    s = str(v).replace("'", "''")
    return "'" + s + "'"


def to_int(v):
    if v is None or v == "":
        return None
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def property_kind(code, name):
    if code == 1:
        return "本社"
    if 199 <= code < 300:
        return "ホテル"
    if 400 <= code < 500 or "寮" in name or "社宅" in name:
        return "寮・社宅"
    if 500 <= code < 600:
        return "土地・その他"
    if code >= 99000:
        return "その他"
    return "ビル"


def main(path):
    wb = openpyxl.load_workbook(path, data_only=True)
    out = []
    w = out.append
    w("-- 自動生成: scripts/import_excel.py （元ファイル: 01.定期契約マスタ）")
    w("begin;")

    # ---------- 99_コードマスタ ----------
    cm = wb["99_コードマスタ"]
    header = [c.value for c in cm[4]]
    cols = defaultdict(list)
    for row in cm.iter_rows(min_row=5, values_only=True):
        for i, h in enumerate(header):
            if h and i < len(row) and row[i] not in (None, ""):
                cols[h].append(row[i])

    # 物件
    props = OrderedDict()
    for code, name in zip(cols["物件コード"], cols["契約物件名"]):
        code = to_int(code)
        if code is not None:
            props[code] = str(name)
    for i, (code, name) in enumerate(props.items()):
        w(
            "insert into public.ct_properties (code, name, kind, accounting_only, sort) values "
            f"({code}, {q(name)}, {q(property_kind(code, name))}, {q(code in HEAD_OFFICE_CODES)}, {i}) "
            "on conflict (code) do update set name = excluded.name;"
        )

    # 選択肢
    categories = {
        "契約状態": "status", "取引区分": "txn_type", "更新区分": "renewal_type",
        "請求サイクル": "billing_cycle", "支払月": "payment_timing", "金額基準": "amount_basis",
        "インボイス区分": "invoice_type", "計上方式": "recognition_method", "端数処理": "rounding",
        "仕訳日ルール": "journal_date_rule", "契約担当部署名": "department",
    }
    extra = {"payment_timing": ["翌月末", "適時"]}
    for jp, key in categories.items():
        vals = [str(v) for v in cols.get(jp, [])] + extra.get(key, [])
        seen = []
        for v in vals:
            if v not in seen:
                seen.append(v)
        for i, v in enumerate(seen):
            w(f"insert into public.ct_code_values (category, value, sort) values ({q(key)}, {q(v)}, {i}) on conflict do nothing;")

    # 税区分
    rates = {"課税10%": 0.10, "軽減8%": 0.08}
    for i, name in enumerate(cols["税区分コード"]):
        w(
            "insert into public.ct_tax_codes (name, rate, sort) values "
            f"({q(name)}, {rates.get(name, 0)}, {i}) on conflict (name) do nothing;"
        )

    # 勘定科目
    acc = wb["科目登録リスト"]
    acc_codes = set()
    for row in acc.iter_rows(min_row=2, values_only=True):
        code = to_int(row[0])
        if code is None or code in acc_codes:
            continue
        acc_codes.add(code)
        normal = "貸方" if row[8] == "貸方" else "借方"
        bs_pl = (row[9] or "").replace("ＢＳ", "BS").replace("ＰＬ", "PL")
        w(
            "insert into public.ct_accounts (code, name, short_name, bs_pl, normal_side, is_accrual) values "
            f"({code}, {q(row[1] or row[2])}, {q(row[2])}, {q(bs_pl)}, {q(normal)}, {q(code in ACCRUAL_ACCOUNTS)}) "
            "on conflict (code) do update set name = excluded.name, short_name = excluded.short_name, "
            "bs_pl = excluded.bs_pl, normal_side = excluded.normal_side;"
        )
    # コードマスタ側にしかない損益科目
    for code, name in zip(cols["損益科目コード"], cols["損益科目名"]):
        code = to_int(code)
        if code is not None and code not in acc_codes:
            acc_codes.add(code)
            w(
                "insert into public.ct_accounts (code, name, short_name, bs_pl, normal_side) values "
                f"({code}, {q(name)}, {q(name)}, 'PL', '借方') on conflict (code) do nothing;"
            )

    # ---------- 契約 ----------
    ws = wb["01_契約（費用）"]
    hdr = [c.value for c in ws[5]]
    idx = {h: i for i, h in enumerate(hdr)}

    def g(row, name):
        v = row[idx[name]]
        if isinstance(v, str):
            v = v.strip()
            if v == "":
                return None
        return v

    rows = [r for r in ws.iter_rows(min_row=6, values_only=True) if r[0] not in (None, "")]

    vendors = OrderedDict()
    for r in rows:
        vc = to_int(g(r, "取引先コード"))
        if vc is not None and vc not in vendors and g(r, "取引先名"):
            vendors[vc] = g(r, "取引先名")
    for vc, name in vendors.items():
        w(f"insert into public.ct_vendors (code, name) values ({vc}, {q(name)}) on conflict (code) do nothing;")

    # 重複の整理
    groups = defaultdict(list)
    for r in rows:
        groups[(to_int(g(r, "契約ID")), to_int(g(r, "契約バージョン")) or 1)].append(r)

    max_seq = defaultdict(int)
    for r in rows:
        cid = to_int(g(r, "契約ID"))
        pc = to_int(g(r, "物件コード"))
        if cid and pc and cid // 100000 == pc:
            max_seq[pc] = max(max_seq[pc], cid % 100000)

    contracts = []   # (contract_no, version, row, allocations[list of rows], note_extra)
    log = []
    for (cid, ver), grp in list(groups.items()):
        pc0 = to_int(g(grp[0], "物件コード"))
        if pc0 and cid // 100000 != pc0 and all(to_int(g(x, "物件コード")) == pc0 for x in grp):
            # 契約IDの先頭が物件コードと一致しない → 物件の次番号で再採番
            max_seq[pc0] += 1
            new_id = pc0 * 100000 + max_seq[pc0]
            for x in grp:
                contracts.append((new_id, ver, x, [], f"旧契約ID {cid}（物件コード不一致のため再採番）"))
            log.append(f"-- 再採番: {cid} {g(grp[0], '契約物件名')} {g(grp[0], '契約名')} → {new_id}")
            continue
        if len(grp) == 1:
            contracts.append((cid, ver, grp[0], [], None))
            continue
        main_row = grp[0]
        alloc_rows = [main_row]
        rest = []
        for r in grp[1:]:
            same_vendor = to_int(g(r, "取引先コード")) == to_int(g(main_row, "取引先コード"))
            pc_main = to_int(g(main_row, "物件コード")) or 0
            pc_r = to_int(g(r, "物件コード")) or 0
            if same_vendor and pc_main < 200 and 200 <= pc_r < 300:
                alloc_rows.append(r)
            else:
                rest.append(r)
        if len(alloc_rows) > 1:
            contracts.append((cid, ver, main_row, alloc_rows, None))
            log.append(f"-- 按分に統合: 契約ID {cid} = " + " + ".join(
                f"{g(x, '契約物件名')}:{g(x, '契約名')}" for x in alloc_rows))
        else:
            contracts.append((cid, ver, main_row, [], None))
        for r in rest:
            pc = to_int(g(r, "物件コード"))
            max_seq[pc] += 1
            new_id = pc * 100000 + max_seq[pc]
            contracts.append((new_id, 1, r, [], f"旧契約ID {cid}（重複のため再採番）"))
            log.append(f"-- 再採番: {cid} {g(r, '契約物件名')} {g(r, '契約名')} → {new_id}")

    for line in log:
        w(line)

    def month_from(text):
        if not text:
            return None
        m = re.search(r"(\d{1,2})\s*月", str(text))
        return int(m.group(1)) if m else None

    def notice_months(text):
        if not text:
            return None
        m = re.search(r"(\d{1,2})\s*[ヶケカか]?月", str(text))
        return int(m.group(1)) if m else None

    for cno, ver, r, alloc_rows, note_extra in contracts:
        if alloc_rows:
            amount = sum(to_int(g(x, "税抜契約金額")) or 0 for x in alloc_rows)
            tax = sum(to_int(g(x, "消費税")) or 0 for x in alloc_rows)
            names = " / ".join(dict.fromkeys(str(g(x, "契約名")) for x in alloc_rows))
        else:
            amount = to_int(g(r, "税抜契約金額"))
            tax = to_int(g(r, "消費税"))
            names = g(r, "契約名")
        pc = to_int(g(r, "物件コード"))
        payment_timing = g(r, "当月分\n支払月")
        note2 = "／".join(x for x in [g(r, "備考2"), note_extra] if x)
        url = g(r, "契約書URL")
        if url and "example.com" in str(url):
            url = None
            note2 = None if (note2 or "").startswith("サンプル") or "のサンプル" in (note2 or "") else note2
        vals = OrderedDict([
            ("contract_no", cno),
            ("version", ver),
            ("is_active", g(r, "有効フラグ") == "有効"),
            ("status", g(r, "契約状態") or "契約中"),
            ("txn_type", g(r, "取引区分") or "費用"),
            ("property_code", pc),
            ("vendor_code", to_int(g(r, "取引先コード"))),
            ("vendor_name", g(r, "取引先名")),
            ("contract_name", names),
            ("department", g(r, "契約担当部門")),
            ("person_in_charge", g(r, "契約担当者")),
            ("signed_date", g(r, "契約締結日")),
            ("service_start", g(r, "サービス開始日")),
            ("service_end", g(r, "サービス終了日")),
            ("cancel_date", g(r, "解約日")),
            ("renewal_type", g(r, "更新区分")),
            ("renewal_notice", g(r, "解約通知期限")),
            ("notice_months", notice_months(g(r, "解約通知期限"))),
            ("first_billing_date", g(r, "初回請求日")),
            ("billing_cycle", g(r, "請求サイクル")),
            ("payment_timing", payment_timing),
            ("annual_payment_month", month_from(g(r, "年払い\n支払月"))),
            ("annual_period_note", g(r, "年払い\nその他")),
            ("amount_basis", g(r, "金額基準")),
            ("amount_excl", amount),
            ("tax_amount", tax),
            ("note", g(r, "備考")),
            ("tax_code", g(r, "税区分コード")),
            ("invoice_type", g(r, "インボイス区分")),
            ("recognition_method", g(r, "計上方式")),
            ("rounding", g(r, "端数処理")),
            ("journal_date_rule", g(r, "仕訳日ルール") or "月末"),
            ("pl_account_code", to_int(g(r, "損益科目コード"))),
            ("counter_account_code", to_int(g(r, "相手科目\nコード"))),
            ("annual_start_month", to_int(g(r, "年払対象開始月"))),
            ("ringi_no", g(r, "稟議書NO")),
            ("contract_url", url),
            ("note2", note2 or None),
        ])
        cols_sql = ", ".join(vals.keys())
        vals_sql = ", ".join(q(v) for v in vals.values())
        upd = ", ".join(f"{k} = excluded.{k}" for k in vals.keys() if k not in ("contract_no", "version"))
        w(f"insert into public.ct_contracts ({cols_sql}) values ({vals_sql}) "
          f"on conflict (contract_no, version) do update set {upd};")
        if alloc_rows:
            w(f"delete from public.ct_contract_allocations where contract_id = "
              f"(select id from public.ct_contracts where contract_no = {cno} and version = {ver});")
            for i, x in enumerate(alloc_rows):
                w("insert into public.ct_contract_allocations (contract_id, property_code, label, amount_excl, sort) "
                  f"select id, {to_int(g(x, '物件コード'))}, {q(g(x, '契約名'))}, {to_int(g(x, '税抜契約金額')) or 0}, {i} "
                  f"from public.ct_contracts where contract_no = {cno} and version = {ver};")

    # 設定
    settings = [
        ("cash_account", "1120", "支払・入金に使う預金科目コード"),
        ("input_tax_account", "1710", "仮払消費税の科目コード（参考表示用）"),
        ("auto_payment", "true", "月次仕訳生成時に支払予定（経過勘定の取崩し）も作る"),
        ("csv_encoding", "Shift_JIS", "仕訳CSVの文字コード（Shift_JIS / UTF-8）"),
        ("csv_input_format", "", "仕訳CSV「仕訳入力形式」列に出力する値"),
        ("csv_sotozei_on", "1", "外税同時入力区分：消費税額がある側に出力する値"),
        ("csv_sotozei_off", "0", "外税同時入力区分：消費税額がない側に出力する値"),
        ("csv_tax_code_none", "", "消費税コード：課税対象外の科目側に出力する値"),
        ("csv_date_format", "yyyy/MM/dd", "伝票日付の書式（yyyy/MM/dd または yyyyMMdd）"),
    ]
    for k, v, label in settings:
        w(f"insert into public.ct_settings (key, value, label) values ({q(k)}, {q(v)}, {q(label)}) "
          "on conflict (key) do update set label = excluded.label;")

    w("commit;")
    print("\n".join(out))


if __name__ == "__main__":
    main(sys.argv[1])
