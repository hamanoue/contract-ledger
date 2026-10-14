-- 計上・支払・残高・権限の検証（架空データ）。失敗すると例外で止まる。
\set ON_ERROR_STOP 1
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'keiri@test'),
  ('00000000-0000-0000-0000-00000000000b', 'kanri@test');
insert into ct_profiles values
  ('00000000-0000-0000-0000-00000000000a', '経理', '総務経理部', 'admin'),
  ('00000000-0000-0000-0000-00000000000b', '管理', '管理部', 'editor');
insert into ct_properties (code, name, kind, accounting_only) values (1, '本社', '本社', true), (11, 'テストビル', 'ビル', false), (201, 'テストホテル', 'ホテル', false);
insert into ct_accounts (code, name, bs_pl, normal_side, is_accrual) values
  (1120, '普通預金', 'BS', '借方', false), (1550, '前払費用', 'BS', '借方', true),
  (3140, '未払金', 'BS', '貸方', true), (3150, '未払費用', 'BS', '貸方', true),
  (5310, '管理費(BM)Ⅰ', 'PL', '借方', false), (6310, '顧問料', 'PL', '借方', false);
insert into ct_tax_codes (name, rate) values ('課税10%', 0.10);
insert into ct_settings (key, value) values ('cash_account', '1120'), ('auto_payment', 'true');

insert into ct_contracts (contract_no, property_code, vendor_code, vendor_name, contract_name, billing_cycle, payment_timing,
  amount_basis, amount_excl, tax_amount, tax_code, pl_account_code, counter_account_code, renewal_type)
values
  (1100001, 11, 1, 'A社', 'ビル管理費', '月次', '翌月払い', '月額', 100000, 10000, '課税10%', 5310, 3150, '自動更新'),
  (100001,  1,  2, 'B事務所', '顧問料',   '月次', '当月払い', '月額',  50000,  5000, '課税10%', 6310, 3140, '自動更新');
insert into ct_contracts (contract_no, property_code, vendor_name, contract_name, billing_cycle, payment_timing,
  annual_payment_month, annual_start_month, amount_basis, amount_excl, tax_amount, tax_code, pl_account_code, counter_account_code, renewal_type)
values (1100002, 11, 'C社', '保守料（年払）', '年次', '年払い', 9, 9, '年額', 120001, 12000, '課税10%', 5310, 1550, '自動更新');
insert into ct_contract_allocations (contract_id, property_code, amount_excl)
  select id, 11, 70000 from ct_contracts where contract_no = 1100001 union all
  select id, 201, 30000 from ct_contracts where contract_no = 1100001;

set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);

do $$
declare v numeric;
begin
  -- 年額 120001 → 毎月 10000、開始月（9月）は 10001
  select amount_excl into v from ct_calc_month('2026-09-01') where contract_no = 1100002;
  if v <> 10001 then raise exception '年払の初月調整が不正: %', v; end if;
  select amount_excl into v from ct_calc_month('2026-10-01') where contract_no = 1100002;
  if v <> 10000 then raise exception '年払の月額が不正: %', v; end if;
end $$;

select ct_apply_suggested_opening('2026-09-01');
select ct_generate_month(d::date) from generate_series('2026-09-01'::date, '2027-09-01', '1 month') d;

do $$
declare v numeric;
begin
  -- 按分 70:30
  select sum(dr_amount) into v from ct_journal_entries where contract_no = 1100001 and period = '2026-10-01' and entry_type = 'accrual' and dr_dept = 201;
  if v <> 30000 then raise exception '按分が不正: %', v; end if;
  -- 未払費用：翌月払いなので毎月末に当月分(税込110000)が残る
  select closing into v from ct_accrual_balances('2026-09-01', '2027-09-01') where contract_no = 1100001 and period = '2027-03-01';
  if v <> 110000 then raise exception '未払費用残高が不正: %', v; end if;
  -- 未払金：当月払いなので残高0
  select coalesce(sum(closing), 0) into v from ct_accrual_balances('2026-09-01', '2027-09-01') where contract_no = 100001;
  if v <> 0 then raise exception '未払金残高が不正: %', v; end if;
  -- 前払費用：9月に132001支払、9月末残高 = 132001 - (10001+1000) = 121000、翌年8月末に0
  select closing into v from ct_accrual_balances('2026-09-01', '2027-09-01') where contract_no = 1100002 and period = '2026-09-01';
  if v <> 121000 then raise exception '前払費用(9月)が不正: %', v; end if;
  select closing into v from ct_accrual_balances('2026-09-01', '2027-09-01') where contract_no = 1100002 and period = '2027-08-01';
  if v <> 0 then raise exception '前払費用(翌8月)が不正: %', v; end if;
end $$;

-- 締めた月は変更不可
select ct_set_period_status('2026-09-01', 'closed');
do $$ begin
  begin
    delete from ct_journal_entries where period = '2026-09-01';
    raise exception 'NG: 締め済み月の仕訳が削除できた';
  exception when raise_exception then
    if sqlerrm like 'NG:%' then raise; end if;
  end;
end $$;

-- 管理部：本社契約・仕訳は見えない
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
do $$ begin
  if exists (select 1 from ct_contracts where property_code = 1) then raise exception '管理部に本社契約が見えている'; end if;
  if exists (select 1 from ct_journal_entries) then raise exception '管理部に仕訳が見えている'; end if;
end $$;

reset role;
\echo 'ALL TESTS PASSED'
