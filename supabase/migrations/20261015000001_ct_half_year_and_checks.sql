-- =====================================================================
-- 計上ルールの追加
--   1. 請求サイクル「半年」：契約金額＝半年分。÷6 を毎月計上し、対象開始月と7か月後に端数を調整。
--      支払は「年払い 支払月」とその6か月後。
--   2. 金額基準「一括」：年次契約では「年額」と同じ扱い（÷12）。
--   3. 月次契約で支払区分が未設定・不明な場合、計上はするが「支払仕訳が作られない」ことを確認事項に出す。
-- 関数の引数・戻り値は変えていないので、既存の画面からそのまま使える。
-- =====================================================================

-- 年払い系（年次・半年）の1期間の月数。対象外は null
create or replace function public.ct_cycle_months(p_cycle text) returns integer
language sql immutable as $$
  select case p_cycle when '年次' then 12 when '半年' then 6 end
$$;

create or replace view public.ct_contracts_v with (security_invoker = true) as
select
  c.*,
  p.name  as property_name,
  p.kind  as property_kind,
  pa.name as pl_account_name,
  ca.name as counter_account_name,
  case
    when c.amount_basis = '月額' then c.amount_excl
    when c.amount_basis in ('年額', '一括') and c.billing_cycle = '半年' then round(c.amount_excl / 6.0)
    when c.amount_basis in ('年額', '一括') then round(c.amount_excl / 12.0)
  end as monthly_excl,
  case
    when c.amount_basis = '月額' then c.amount_excl * 12
    when c.amount_basis in ('年額', '一括') and c.billing_cycle = '半年' then c.amount_excl * 2
    when c.amount_basis in ('年額', '一括') then c.amount_excl
  end as annual_excl,
  (select count(*) from public.ct_contract_allocations a where a.contract_id = c.id) as allocation_count,
  case
    when not c.is_active then '対象外'
    when c.status in ('解約予定', '解約済') and c.cancel_date is null then '要設定'
    when c.amount_excl is null or c.pl_account_code is null or c.counter_account_code is null
      or c.amount_basis in ('従量', '手入力')
      or (c.billing_cycle in ('年次', '半年') and (c.annual_payment_month is null or c.annual_start_month is null))
      then '要設定'
    else '対象'
  end as calc_target,
  nullif(concat_ws('／',
    case when c.status in ('解約予定', '解約済') and c.cancel_date is null then '解約日未入力' end,
    case when c.amount_excl is null and coalesce(c.amount_basis, '') not in ('従量', '手入力') then '金額未入力' end,
    case when c.pl_account_code is null then '損益科目未入力' end,
    case when c.counter_account_code is null then '相手科目未入力' end,
    case when c.amount_basis in ('従量', '手入力') then '従量・手入力は毎月の実績入力が必要' end,
    case when c.billing_cycle in ('年次', '半年') and c.annual_payment_month is null then '年払月未入力' end,
    case when c.billing_cycle in ('年次', '半年') and c.annual_start_month is null then '年払対象開始月未入力' end,
    case when coalesce(c.billing_cycle, '月次') = '月次' and c.is_active
              and public.ct_payment_lag(c.payment_timing) is null then '支払区分未設定（支払仕訳が作られません）' end
  ), '') as issues
from public.ct_contracts c
left join public.ct_properties p  on p.code  = c.property_code
left join public.ct_accounts   pa on pa.code = c.pl_account_code
left join public.ct_accounts   ca on ca.code = c.counter_account_code;

create or replace function public.ct_calc_month(p_period date)
returns table (
  contract_id          bigint,
  contract_no          bigint,
  version              integer,
  property_code        integer,
  property_name        text,
  vendor_code          integer,
  vendor_name          text,
  contract_name        text,
  txn_type             text,
  billing_cycle        text,
  payment_timing       text,
  amount_basis         text,
  annual_payment_month integer,
  annual_start_month   integer,
  tax_code             text,
  pl_account_code      integer,
  pl_sub_code          text,
  counter_account_code integer,
  counter_sub_code     text,
  journal_date_rule    text,
  contract_amount_incl numeric,
  judgement            text,
  actual_excl          numeric,
  amount_excl          numeric,
  tax_amount           numeric,
  amount_incl          numeric,
  description          text,
  issues               text
)
language sql stable security invoker set search_path = public as $$
  with m as (
    select date_trunc('month', p_period)::date as d
  ), base as (
    select c.*, p.name as pname, coalesce(t.rate, 0) as rate,
           a.amount_excl as act_excl, a.tax_amount as act_tax, m.d as md,
           ct_cycle_months(c.billing_cycle) as n,
           (c.status in ('解約予定', '解約済') and c.cancel_date is null) as need_cancel,
           (c.is_active and c.status in ('契約中', '解約予定', '解約済')
             and (c.service_start is null or m.d >= date_trunc('month', c.service_start)::date)
             and case
                   when c.cancel_date is not null then m.d <= c.cancel_date
                   when c.service_end is null then true
                   when c.renewal_type = '自動更新' then true
                   else m.d <= c.service_end
                 end) as act
    from ct_contracts c
    cross join m
    left join ct_properties p      on p.code = c.property_code
    left join ct_tax_codes t       on t.name = c.tax_code
    left join ct_monthly_actuals a on a.contract_id = c.id and a.period = m.d
  ), j as (
    select b.*,
      case
        when b.need_cancel then '要設定'
        when not b.act then '対象外'
        when b.pl_account_code is null or b.counter_account_code is null then '要設定'
        when b.amount_basis in ('従量', '手入力') then
          case when b.act_excl is null then '実績入力待ち' else '実績入力済' end
        when b.billing_cycle = '月次' and b.amount_basis = '月額' and b.amount_excl is not null then '計上'
        when b.n is not null and b.amount_basis in ('年額', '一括') and b.amount_excl is not null
             and b.annual_start_month is not null and b.annual_payment_month is not null then '計上'
        else '要設定'
      end as jd,
      -- 年払い系：期間の初月（端数調整月）か
      (b.n is not null and b.annual_start_month is not null
        and ((extract(month from b.md)::int - b.annual_start_month + 12) % b.n) = 0) as is_first
    from base b
  ), v as (
    select j.*,
      case
        when j.jd = '実績入力済' then j.act_excl
        when j.jd = '計上' and j.billing_cycle = '月次' then j.amount_excl
        when j.jd = '計上' then
          case when j.is_first then j.amount_excl - trunc(j.amount_excl / j.n) * (j.n - 1)
               else trunc(j.amount_excl / j.n) end
      end as ex,
      case
        when j.jd = '実績入力済' then coalesce(j.act_tax, trunc(j.act_excl * j.rate))
        when j.jd = '計上' and j.billing_cycle = '月次' then coalesce(j.tax_amount, trunc(j.amount_excl * j.rate))
        when j.jd = '計上' then
          case when j.is_first
               then coalesce(j.tax_amount, trunc(j.amount_excl * j.rate))
                    - trunc(coalesce(j.tax_amount, trunc(j.amount_excl * j.rate)) / j.n) * (j.n - 1)
               else trunc(coalesce(j.tax_amount, trunc(j.amount_excl * j.rate)) / j.n) end
      end as tx
    from j
  )
  select v.id, v.contract_no, v.version, v.property_code, v.pname, v.vendor_code, v.vendor_name,
         v.contract_name, v.txn_type, v.billing_cycle, v.payment_timing, v.amount_basis,
         v.annual_payment_month, v.annual_start_month, v.tax_code,
         v.pl_account_code, v.pl_sub_code, v.counter_account_code, v.counter_sub_code, v.journal_date_rule,
         v.amount_incl,
         v.jd, v.act_excl, v.ex, v.tx, v.ex + v.tx,
         case when v.ex is not null then
           concat_ws(' ', v.pname, v.contract_name, to_char(v.md, 'YYYY"年"FMMM"月分"')) end,
         case
           when v.jd = '要設定' then nullif(concat_ws('／',
             case when v.need_cancel then '解約日未入力' end,
             case when v.amount_excl is null and coalesce(v.amount_basis, '') not in ('従量', '手入力') then '金額未入力' end,
             case when v.pl_account_code is null then '損益科目未入力' end,
             case when v.counter_account_code is null then '相手科目未入力' end,
             case when v.n is not null and v.annual_payment_month is null then '年払月未入力' end,
             case when v.n is not null and v.annual_start_month is null then '年払対象開始月未入力' end,
             case when coalesce(v.billing_cycle, '') not in ('月次', '年次', '半年')
                    or coalesce(v.amount_basis, '') not in ('月額', '年額', '一括', '従量', '手入力')
                    or (v.billing_cycle = '月次' and v.amount_basis in ('年額', '一括'))
                    or (v.n is not null and v.amount_basis = '月額')
                  then '請求サイクルと金額基準の組合せが計上対象外' end
           ), '')
           when v.jd = '実績入力待ち' then '当月の実績金額を入力してください'
           -- 計上はするが、支払区分が分からず支払仕訳が作られない（経過勘定が残り続ける）
           when v.jd in ('計上', '実績入力済') and coalesce(v.billing_cycle, '月次') = '月次'
                and ct_payment_lag(v.payment_timing) is null
             then '支払区分未設定（支払仕訳が作られません）'
         end
  from v
  order by v.property_code, v.contract_no, v.version
$$;

-- 年払い系の支払月か（年次＝支払月、半年＝支払月とその6か月後）
create or replace function public.ct_is_cycle_payment_month(p_cycle text, p_payment_month integer, p_period date)
returns boolean
language sql immutable as $$
  select case
    when p_payment_month is null then false
    when p_cycle = '年次' then extract(month from p_period)::int = p_payment_month
    when p_cycle = '半年' then (extract(month from p_period)::int - p_payment_month + 12) % 6 = 0
    else false
  end
$$;

-- 月次仕訳の生成（年払い系の支払判定だけ半年に対応。それ以外は従来どおり）
create or replace function public.ct_generate_month(p_period date) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  m          date := date_trunc('month', p_period)::date;
  m_end      date := (date_trunc('month', p_period) + interval '1 month - 1 day')::date;
  v_cash     integer;
  v_auto_pay boolean;
  r          record;
  a          record;
  v_date     date;
  v_n_alloc  integer;
  v_sum_alloc numeric;
  v_rest_ex  numeric;
  v_rest_tx  numeric;
  v_ex       numeric;
  v_tx       numeric;
  v_i        integer;
  v_lag      integer;
  n_accrual  integer := 0;
  n_payment  integer := 0;
  n_skipped  integer := 0;
begin
  if not (public.ct_is_accounting() and public.ct_can_edit()) then
    raise exception '月次仕訳の生成は総務経理部の編集権限が必要です';
  end if;
  if exists (select 1 from ct_periods where period = m and status = 'closed') then
    raise exception '% は締め済みです', to_char(m, 'YYYY年MM月');
  end if;

  select value::integer into v_cash from ct_settings where key = 'cash_account';
  v_auto_pay := coalesce((select value from ct_settings where key = 'auto_payment'), 'true') = 'true';

  delete from ct_journal_entries where period = m and source = 'auto' and exported_at is null;

  -- (1) 費用・収益の計上
  for r in select * from ct_calc_month(m) where judgement in ('計上', '実績入力済') loop
    if exists (select 1 from ct_journal_entries e where e.period = m and e.source = 'auto'
                 and e.entry_type = 'accrual' and e.contract_id = r.contract_id) then
      n_skipped := n_skipped + 1;  -- 出力済みのため残す
      continue;
    end if;
    v_date := case when r.journal_date_rule = '月初' then m else m_end end;

    select count(*), coalesce(sum(amount_excl), 0) into v_n_alloc, v_sum_alloc
      from ct_contract_allocations where contract_id = r.contract_id;

    v_rest_ex := r.amount_excl;
    v_rest_tx := r.tax_amount;
    v_i := 0;
    for a in
      select property_code as dept, amount_excl as w from ct_contract_allocations
       where contract_id = r.contract_id and v_n_alloc > 0 and v_sum_alloc <> 0
      union all
      select r.property_code, 1 where v_n_alloc = 0 or v_sum_alloc = 0
      order by 2 asc  -- 最後（最大）の行で端数を吸収
    loop
      v_i := v_i + 1;
      if v_i = greatest(v_n_alloc, 1) or v_sum_alloc = 0 then
        v_ex := v_rest_ex; v_tx := v_rest_tx;
      else
        v_ex := trunc(r.amount_excl * a.w / v_sum_alloc);
        v_tx := trunc(r.tax_amount  * a.w / v_sum_alloc);
      end if;
      v_rest_ex := v_rest_ex - v_ex;
      v_rest_tx := v_rest_tx - v_tx;

      if r.txn_type = '収益' then
        insert into ct_journal_entries (period, entry_date, entry_type, source, contract_id, contract_no,
          dr_account, dr_sub_code, dr_dept, dr_vendor, dr_amount, dr_tax_amount, dr_tax_code,
          cr_account, cr_sub_code, cr_dept, cr_vendor, cr_amount, cr_tax_amount, cr_tax_code, description)
        values (m, v_date, 'accrual', 'auto', r.contract_id, r.contract_no,
          r.counter_account_code, r.counter_sub_code, r.property_code, r.vendor_code, v_ex + v_tx, 0, null,
          r.pl_account_code, r.pl_sub_code, a.dept, r.vendor_code, v_ex, v_tx, r.tax_code, r.description);
      else
        insert into ct_journal_entries (period, entry_date, entry_type, source, contract_id, contract_no,
          dr_account, dr_sub_code, dr_dept, dr_vendor, dr_amount, dr_tax_amount, dr_tax_code,
          cr_account, cr_sub_code, cr_dept, cr_vendor, cr_amount, cr_tax_amount, cr_tax_code, description)
        values (m, v_date, 'accrual', 'auto', r.contract_id, r.contract_no,
          r.pl_account_code, r.pl_sub_code, a.dept, r.vendor_code, v_ex, v_tx, r.tax_code,
          r.counter_account_code, r.counter_sub_code, r.property_code, r.vendor_code, v_ex + v_tx, 0, null,
          r.description);
      end if;
      n_accrual := n_accrual + 1;
    end loop;
  end loop;

  -- (2) 支払（入金）予定：経過勘定の取崩し
  if v_auto_pay and v_cash is not null then
    -- 月次契約：当月に支払う分（支払月のずれ分だけ前後の月の計上額）
    for v_lag in select unnest(array[-1, 0, 1, 2]) loop
      for r in
        select * from ct_calc_month((m - make_interval(months => v_lag))::date) c
         where c.judgement in ('計上', '実績入力済') and c.billing_cycle = '月次'
           and ct_payment_lag(c.payment_timing) = v_lag
      loop
        if exists (select 1 from ct_journal_entries e where e.period = m and e.source = 'auto'
                     and e.entry_type = 'payment' and e.contract_id = r.contract_id) then
          continue;
        end if;
        perform public.ct_insert_payment(m, m_end, r.contract_id, r.contract_no, r.txn_type,
          r.counter_account_code, r.counter_sub_code, r.property_code, r.vendor_code, v_cash, r.amount_incl,
          concat_ws(' ', r.property_name, r.contract_name,
                    to_char((m - make_interval(months => v_lag))::date, 'YYYY"年"FMMM"月分"'),
                    case when r.txn_type = '収益' then '入金' else '支払' end));
        n_payment := n_payment + 1;
      end loop;
    end loop;

    -- 年次・半年契約：支払月に1期間分（税込）を支払
    for r in
      select * from ct_calc_month(m) c
       where c.judgement = '計上' and c.billing_cycle in ('年次', '半年')
         and ct_is_cycle_payment_month(c.billing_cycle, c.annual_payment_month, m)
    loop
      if exists (select 1 from ct_journal_entries e where e.period = m and e.source = 'auto'
                   and e.entry_type = 'payment' and e.contract_id = r.contract_id) then
        continue;
      end if;
      perform public.ct_insert_payment(m, m_end, r.contract_id, r.contract_no, r.txn_type,
        r.counter_account_code, r.counter_sub_code, r.property_code, r.vendor_code, v_cash, r.contract_amount_incl,
        concat_ws(' ', r.property_name, r.contract_name, case r.billing_cycle when '半年' then '半年分' else '年額' end,
                  case when r.txn_type = '収益' then '入金' else '支払' end));
      n_payment := n_payment + 1;
    end loop;
  end if;

  return jsonb_build_object('accrual', n_accrual, 'payment', n_payment, 'kept_exported', n_skipped);
end $$;

insert into public.ct_code_values (category, value, sort) values ('billing_cycle', '半年', 90)
on conflict do nothing;

revoke execute on function public.ct_cycle_months(text), public.ct_is_cycle_payment_month(text, integer, date) from public, anon;
grant execute on function public.ct_cycle_months(text), public.ct_is_cycle_payment_month(text, integer, date) to authenticated;
