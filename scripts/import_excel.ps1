<#
  「01.定期契約マスタ.xlsx」から初期データ投入用 SQL を生成する（scripts/import_excel.py の PowerShell 版）。
  Python や Excel が入っていない Windows でもそのまま動く。

  使い方:
    powershell -ExecutionPolicy Bypass -File scripts\import_excel.ps1 -Path "<01.定期契約マスタ.xlsx>" [-Out supabase\seed\seed_data.sql]

  取り込みルール（import_excel.py と同じ）
  - 物件・勘定科目・選択肢・取引先・契約を upsert（ON CONFLICT）で投入
  - 契約ID＋枝番が重複している行:
      * 同じ取引先で「ビル（200未満）＋ホテル（200〜299）」の組合せ → 1契約＋按分行に統合
      * それ以外 → 2行目以降に同じ物件の次の契約IDを採番し、備考2に旧契約IDを残す
  - 契約IDの先頭が物件コードと一致しない行は、物件の次の番号で再採番
  - 物件コード1（本社）の契約は総務経理部のみ閲覧（accounting_only）
#>
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [string]$Out = ''
)
$ErrorActionPreference = 'Stop'
if (-not $Out) { $Out = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..\supabase\seed\seed_data.sql' }
Add-Type -AssemblyName System.IO.Compression.FileSystem

$ACCRUAL_ACCOUNTS = @(1550, 3140, 3150, 1530, 3160)
$HEAD_OFFICE_CODES = @(1)

# ---------------------------------------------------------------------
# xlsx 読み込み（Excel 不要。zip を展開して XML を読む）
# ---------------------------------------------------------------------
$work = Join-Path ([IO.Path]::GetTempPath()) ('ct_import_' + [guid]::NewGuid())
[IO.Compression.ZipFile]::ExtractToDirectory((Resolve-Path $Path), $work)
try {
  $mainNs = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
  $relNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

  # 共有文字列（ふりがな rPh は除外）
  $strings = New-Object System.Collections.Generic.List[string]
  $sstPath = Join-Path $work 'xl\sharedStrings.xml'
  if (Test-Path $sstPath) {
    [xml]$sst = Get-Content -Raw -Encoding UTF8 $sstPath
    $ns = New-Object Xml.XmlNamespaceManager $sst.NameTable
    $ns.AddNamespace('m', $mainNs)
    foreach ($si in $sst.SelectNodes('//m:si', $ns)) {
      $strings.Add((($si.SelectNodes('m:t|m:r/m:t', $ns) | ForEach-Object { $_.InnerText }) -join ''))
    }
  }

  [xml]$wb = Get-Content -Raw -Encoding UTF8 (Join-Path $work 'xl\workbook.xml')
  [xml]$rels = Get-Content -Raw -Encoding UTF8 (Join-Path $work 'xl\_rels\workbook.xml.rels')
  $relMap = @{}
  foreach ($r in $rels.Relationships.Relationship) { $relMap[$r.Id] = $r.Target }
  $sheetFile = @{}
  foreach ($s in $wb.workbook.sheets.sheet) {
    $target = $relMap[$s.GetAttribute('id', $relNs)] -replace '^/xl/', ''
    $sheetFile[$s.name] = Join-Path $work ('xl\' + ($target -replace '/', '\'))
  }

  function ColNum([string]$ref) {
    $n = 0
    foreach ($ch in ($ref -replace '\d', '').ToCharArray()) { $n = $n * 26 + ([int]$ch - 64) }
    $n - 1   # 0 始まり
  }

  # 行番号（1始まり）→ { 列番号（0始まり）→ 値 } の配列
  function Read-Sheet([string]$name) {
    if (-not $sheetFile.ContainsKey($name)) { throw "シート「$name」が見つかりません" }
    [xml]$w = Get-Content -Raw -Encoding UTF8 $sheetFile[$name]
    $rows = @{}
    foreach ($r in $w.worksheet.sheetData.row) {
      $cells = @{}
      foreach ($c in $r.c) {
        $v = $c.v
        if ($v -is [Xml.XmlElement]) { $v = $v.InnerText }
        if ($c.t -eq 's') { $v = $strings[[int]$v] }
        elseif ($c.t -eq 'inlineStr') { $v = $c.is.InnerText }
        if ($null -ne $v -and "$v".Trim() -ne '') { $cells[(ColNum $c.r)] = "$v".Trim() }
      }
      $rows[[int]$r.r] = $cells
    }
    $rows
  }

  function Q($v) {
    if ($null -eq $v -or "$v" -eq '') { return 'null' }
    if ($v -is [bool]) { if ($v) { return 'true' } else { return 'false' } }
    if ($v -is [int] -or $v -is [long]) { return "$v" }
    "'" + ("$v" -replace "'", "''") + "'"
  }
  function ToInt($v) {
    $d = 0.0
    if ($null -eq $v -or "$v" -eq '' -or -not [double]::TryParse("$v", [ref]$d)) { return $null }
    [long][math]::Truncate($d)
  }
  function ToDate($v) {
    $d = 0.0
    if ($null -eq $v -or "$v" -eq '' -or -not [double]::TryParse("$v", [ref]$d)) { return $v }
    ([datetime]'1899-12-30').AddDays([math]::Floor($d)).ToString('yyyy-MM-dd')
  }
  function MonthFrom($text) {
    if ($text -and "$text" -match '(\d{1,2})\s*月') { return [int]$Matches[1] }
    $null
  }
  function NoticeMonths($text) {
    if ($text -and "$text" -match '(\d{1,2})\s*[ヶケカか]?月') { return [int]$Matches[1] }
    $null
  }
  function PropertyKind([long]$code, [string]$name) {
    if ($code -eq 1) { return '本社' }
    if ($code -ge 199 -and $code -lt 300) { return 'ホテル' }
    if (($code -ge 400 -and $code -lt 500) -or $name -match '寮|社宅') { return '寮・社宅' }
    if ($code -ge 500 -and $code -lt 600) { return '土地・その他' }
    if ($code -ge 99000) { return 'その他' }
    'ビル'
  }
  # 見出しの改行・空白を除いて照合する
  function HeaderKey([string]$h) { ($h -replace '\s', '') }

  $sql = New-Object System.Collections.Generic.List[string]
  function W([string]$line) { $sql.Add($line) }
  W '-- 自動生成: scripts/import_excel.ps1 （元ファイル: 01.定期契約マスタ）'
  W 'begin;'

  # ---------- 99_コードマスタ ----------
  $cm = Read-Sheet '99_コードマスタ'
  $cmHeader = $cm[4]
  $cols = @{}
  foreach ($i in $cmHeader.Keys) { $cols[(HeaderKey $cmHeader[$i])] = New-Object System.Collections.Generic.List[object] }
  foreach ($rn in ($cm.Keys | Where-Object { $_ -ge 5 } | Sort-Object)) {
    foreach ($i in $cmHeader.Keys) {
      if ($cm[$rn].ContainsKey($i)) { $cols[(HeaderKey $cmHeader[$i])].Add($cm[$rn][$i]) }
    }
  }
  # 物件コードと物件名は同じ行で対応させる
  $codeCol = ($cmHeader.Keys | Where-Object { (HeaderKey $cmHeader[$_]) -eq '物件コード' })[0]
  $nameCol = ($cmHeader.Keys | Where-Object { (HeaderKey $cmHeader[$_]) -eq '契約物件名' })[0]
  $props = [ordered]@{}
  foreach ($rn in ($cm.Keys | Where-Object { $_ -ge 5 } | Sort-Object)) {
    $code = ToInt $cm[$rn][$codeCol]
    if ($null -ne $code -and $cm[$rn].ContainsKey($nameCol)) { $props["$code"] = $cm[$rn][$nameCol] }
  }

  # ---------- 01_契約（費用） ----------
  $ws = Read-Sheet '01_契約（費用）'
  $hdr = $ws[5]
  $idx = @{}
  foreach ($i in $hdr.Keys) { $idx[(HeaderKey $hdr[$i])] = $i }
  function G($row, [string]$name) {
    $k = HeaderKey $name
    if (-not $idx.ContainsKey($k)) { throw "列「$name」が見つかりません" }
    $v = $row[$idx[$k]]
    if ($null -eq $v -or "$v" -eq '') { return $null }
    $v
  }
  $rows = @($ws.Keys | Where-Object { $_ -ge 6 } | Sort-Object | ForEach-Object { $ws[$_] } | Where-Object { $_.ContainsKey(0) })

  # 契約にしか出てこない物件（ホテル棟など）も登録する
  foreach ($r in $rows) {
    $pc = ToInt (G $r '物件コード')
    if ($null -ne $pc -and -not $props.Contains("$pc")) { $props["$pc"] = G $r '契約物件名' }
  }
  $i = 0
  foreach ($code in $props.Keys) {
    $name = $props[$code]
    $isHq = ($HEAD_OFFICE_CODES -contains [long]$code)
    W ("insert into public.ct_properties (code, name, kind, accounting_only, sort) values " +
       "($code, $(Q $name), $(Q (PropertyKind ([long]$code) $name)), $(Q $isHq), $i) " +
       'on conflict (code) do update set name = excluded.name;')
    $i++
  }

  # 選択肢
  $categories = [ordered]@{
    '契約状態' = 'status'; '取引区分' = 'txn_type'; '更新区分' = 'renewal_type'; '請求サイクル' = 'billing_cycle'
    '支払月' = 'payment_timing'; '金額基準' = 'amount_basis'; 'インボイス区分' = 'invoice_type'; '計上方式' = 'recognition_method'
    '端数処理' = 'rounding'; '仕訳日ルール' = 'journal_date_rule'; '契約担当部署名' = 'department'
  }
  $extra = @{ 'payment_timing' = @('翌月末', '適時') }
  foreach ($jp in $categories.Keys) {
    $key = $categories[$jp]
    $vals = @()
    if ($cols.ContainsKey($jp)) { $vals += $cols[$jp] }
    if ($extra.ContainsKey($key)) { $vals += $extra[$key] }
    $seen = @()
    foreach ($v in $vals) { if ($seen -notcontains "$v") { $seen += "$v" } }
    for ($j = 0; $j -lt $seen.Count; $j++) {
      W "insert into public.ct_code_values (category, value, sort) values ($(Q $key), $(Q $seen[$j]), $j) on conflict do nothing;"
    }
  }

  # 税区分
  $rates = @{ '課税10%' = '0.1'; '軽減8%' = '0.08' }
  $j = 0
  foreach ($name in $cols['税区分コード']) {
    $rate = if ($rates.ContainsKey($name)) { $rates[$name] } else { '0' }
    W "insert into public.ct_tax_codes (name, rate, sort) values ($(Q $name), $rate, $j) on conflict (name) do nothing;"
    $j++
  }

  # 勘定科目
  $acc = Read-Sheet '科目登録リスト'
  $accCodes = @{}
  foreach ($rn in ($acc.Keys | Where-Object { $_ -ge 2 } | Sort-Object)) {
    $row = $acc[$rn]
    $code = ToInt $row[0]
    if ($null -eq $code -or $accCodes.ContainsKey($code)) { continue }
    $accCodes[$code] = $true
    $normal = if ($row[8] -eq '貸方') { '貸方' } else { '借方' }
    $bsPl = ("$($row[9])" -replace 'ＢＳ', 'BS' -replace 'ＰＬ', 'PL')
    $name = if ($row[1]) { $row[1] } else { $row[2] }
    W ("insert into public.ct_accounts (code, name, short_name, bs_pl, normal_side, is_accrual) values " +
       "($code, $(Q $name), $(Q $row[2]), $(Q $bsPl), $(Q $normal), $(Q ($ACCRUAL_ACCOUNTS -contains $code))) " +
       'on conflict (code) do update set name = excluded.name, short_name = excluded.short_name, ' +
       'bs_pl = excluded.bs_pl, normal_side = excluded.normal_side;')
  }
  # コードマスタ側にしかない損益科目
  for ($j = 0; $j -lt $cols['損益科目コード'].Count; $j++) {
    $code = ToInt $cols['損益科目コード'][$j]
    if ($null -ne $code -and -not $accCodes.ContainsKey($code)) {
      $accCodes[$code] = $true
      $name = $cols['損益科目名'][$j]
      W "insert into public.ct_accounts (code, name, short_name, bs_pl, normal_side) values ($code, $(Q $name), $(Q $name), 'PL', '借方') on conflict (code) do nothing;"
    }
  }

  # 取引先
  $vendors = [ordered]@{}
  foreach ($r in $rows) {
    $vc = ToInt (G $r '取引先コード')
    if ($null -ne $vc -and -not $vendors.Contains("$vc") -and (G $r '取引先名')) { $vendors["$vc"] = G $r '取引先名' }
  }
  foreach ($vc in $vendors.Keys) {
    W "insert into public.ct_vendors (code, name) values ($vc, $(Q $vendors[$vc])) on conflict (code) do nothing;"
  }

  # ---------- 重複の整理 ----------
  $groups = [ordered]@{}
  foreach ($r in $rows) {
    $ver = ToInt (G $r '契約バージョン'); if (-not $ver) { $ver = 1 }
    $key = "$(ToInt (G $r '契約ID'))|$ver"
    if (-not $groups.Contains($key)) { $groups[$key] = New-Object System.Collections.Generic.List[object] }
    $groups[$key].Add($r)
  }
  $maxSeq = @{}
  foreach ($r in $rows) {
    $cid = ToInt (G $r '契約ID'); $pc = ToInt (G $r '物件コード')
    if ($cid -and $pc -and [math]::Floor($cid / 100000) -eq $pc) {
      $seq = $cid % 100000
      if (-not $maxSeq.ContainsKey($pc) -or $maxSeq[$pc] -lt $seq) { $maxSeq[$pc] = $seq }
    }
  }
  function NextId([long]$pc) {
    if (-not $maxSeq.ContainsKey($pc)) { $maxSeq[$pc] = 0 }
    $maxSeq[$pc]++
    $pc * 100000 + $maxSeq[$pc]
  }

  $contracts = New-Object System.Collections.Generic.List[object]
  $log = New-Object System.Collections.Generic.List[string]
  foreach ($key in $groups.Keys) {
    $grp = $groups[$key]
    $cid = [long]($key.Split('|')[0]); $ver = [int]($key.Split('|')[1])
    $pc0 = ToInt (G $grp[0] '物件コード')
    $allSame = @($grp | Where-Object { (ToInt (G $_ '物件コード')) -ne $pc0 }).Count -eq 0
    if ($pc0 -and [math]::Floor($cid / 100000) -ne $pc0 -and $allSame) {
      # 契約IDの先頭が物件コードと一致しない → 物件の次番号で再採番
      $newId = NextId $pc0
      foreach ($x in $grp) { $contracts.Add(@{ no = $newId; ver = $ver; row = $x; alloc = @(); note = "旧契約ID $cid（物件コード不一致のため再採番）" }) }
      $log.Add("-- 再採番: $cid $(G $grp[0] '契約物件名') $(G $grp[0] '契約名') → $newId")
      continue
    }
    if ($grp.Count -eq 1) { $contracts.Add(@{ no = $cid; ver = $ver; row = $grp[0]; alloc = @(); note = $null }); continue }
    $main = $grp[0]
    $allocRows = @($main)
    $rest = @()
    for ($k = 1; $k -lt $grp.Count; $k++) {
      $r = $grp[$k]
      $sameVendor = (ToInt (G $r '取引先コード')) -eq (ToInt (G $main '取引先コード'))
      $pcMain = ToInt (G $main '物件コード'); if (-not $pcMain) { $pcMain = 0 }
      $pcR = ToInt (G $r '物件コード'); if (-not $pcR) { $pcR = 0 }
      if ($sameVendor -and $pcMain -lt 200 -and $pcR -ge 200 -and $pcR -lt 300) { $allocRows += , $r } else { $rest += , $r }
    }
    if ($allocRows.Count -gt 1) {
      $contracts.Add(@{ no = $cid; ver = $ver; row = $main; alloc = $allocRows; note = $null })
      $log.Add("-- 按分に統合: 契約ID $cid = " + (($allocRows | ForEach-Object { "$(G $_ '契約物件名'):$(G $_ '契約名')" }) -join ' + '))
    } else {
      $contracts.Add(@{ no = $cid; ver = $ver; row = $main; alloc = @(); note = $null })
    }
    foreach ($r in $rest) {
      $newId = NextId (ToInt (G $r '物件コード'))
      $contracts.Add(@{ no = $newId; ver = 1; row = $r; alloc = @(); note = "旧契約ID $cid（重複のため再採番）" })
      $log.Add("-- 再採番: $cid $(G $r '契約物件名') $(G $r '契約名') → $newId")
    }
  }
  foreach ($line in $log) { W $line }

  # ---------- 契約 ----------
  foreach ($c in $contracts) {
    $r = $c.row
    if ($c.alloc.Count) {
      $amount = [long]0; $tax = [long]0
      foreach ($x in $c.alloc) { $amount += [long](ToInt (G $x '税抜契約金額')); $tax += [long](ToInt (G $x '消費税')) }
      $names = (($c.alloc | ForEach-Object { "$(G $_ '契約名')" }) | Select-Object -Unique) -join ' / '
    } else {
      $amount = ToInt (G $r '税抜契約金額'); $tax = ToInt (G $r '消費税'); $names = G $r '契約名'
    }
    $note2 = (@((G $r '備考2'), $c.note) | Where-Object { $_ }) -join '／'
    $url = G $r '契約書URL'
    if ($url -and "$url" -like '*example.com*') {
      $url = $null
      if ($note2.StartsWith('サンプル') -or $note2.Contains('のサンプル')) { $note2 = $null }
    }
    $isActive = ((G $r '有効フラグ') -eq '有効')
    $status = G $r '契約状態'; if (-not $status) { $status = '契約中' }
    $txn = G $r '取引区分'; if (-not $txn) { $txn = '費用' }
    $dateRule = G $r '仕訳日ルール'; if (-not $dateRule) { $dateRule = '月末' }
    $vals = [ordered]@{
      contract_no          = $c.no
      version              = $c.ver
      is_active            = $isActive
      status               = $status
      txn_type             = $txn
      property_code        = ToInt (G $r '物件コード')
      vendor_code          = ToInt (G $r '取引先コード')
      vendor_name          = G $r '取引先名'
      contract_name        = $names
      department           = G $r '契約担当部門'
      person_in_charge     = G $r '契約担当者'
      signed_date          = ToDate (G $r '契約締結日')
      service_start        = ToDate (G $r 'サービス開始日')
      service_end          = ToDate (G $r 'サービス終了日')
      cancel_date          = ToDate (G $r '解約日')
      renewal_type         = G $r '更新区分'
      renewal_notice       = G $r '解約通知期限'
      notice_months        = NoticeMonths (G $r '解約通知期限')
      first_billing_date   = ToDate (G $r '初回請求日')
      billing_cycle        = G $r '請求サイクル'
      payment_timing       = G $r '当月分支払月'
      annual_payment_month = MonthFrom (G $r '年払い支払月')
      annual_period_note   = G $r '年払いその他'
      amount_basis         = G $r '金額基準'
      amount_excl          = $amount
      tax_amount           = $tax
      note                 = G $r '備考'
      tax_code             = G $r '税区分コード'
      invoice_type         = G $r 'インボイス区分'
      recognition_method   = G $r '計上方式'
      rounding             = G $r '端数処理'
      journal_date_rule    = $dateRule
      pl_account_code      = ToInt (G $r '損益科目コード')
      counter_account_code = ToInt (G $r '相手科目コード')
      annual_start_month   = ToInt (G $r '年払対象開始月')
      ringi_no             = G $r '稟議書NO'
      contract_url         = $url
      note2                = $(if ($note2) { $note2 } else { $null })
    }
    $colsSql = ($vals.Keys) -join ', '
    $valsSql = ($vals.Values | ForEach-Object { Q $_ }) -join ', '
    $upd = (($vals.Keys | Where-Object { $_ -notin 'contract_no', 'version' }) | ForEach-Object { "$_ = excluded.$_" }) -join ', '
    W "insert into public.ct_contracts ($colsSql) values ($valsSql) on conflict (contract_no, version) do update set $upd;"
    if ($c.alloc.Count) {
      W "delete from public.ct_contract_allocations where contract_id = (select id from public.ct_contracts where contract_no = $($c.no) and version = $($c.ver));"
      for ($k = 0; $k -lt $c.alloc.Count; $k++) {
        $x = $c.alloc[$k]
        $amt = ToInt (G $x '税抜契約金額'); if ($null -eq $amt) { $amt = 0 }
        W ("insert into public.ct_contract_allocations (contract_id, property_code, label, amount_excl, sort) " +
           "select id, $(ToInt (G $x '物件コード')), $(Q (G $x '契約名')), $amt, $k " +
           "from public.ct_contracts where contract_no = $($c.no) and version = $($c.ver);")
      }
    }
  }

  # 設定
  $settings = @(
    @('cash_account', '1120', '支払・入金に使う預金科目コード'),
    @('input_tax_account', '1710', '仮払消費税の科目コード（参考表示用）'),
    @('auto_payment', 'true', '月次仕訳生成時に支払予定（経過勘定の取崩し）も作る'),
    @('csv_encoding', 'Shift_JIS', '仕訳CSVの文字コード（Shift_JIS / UTF-8）'),
    @('csv_input_format', '', '仕訳CSV「仕訳入力形式」列に出力する値'),
    @('csv_sotozei_on', '1', '外税同時入力区分：消費税額がある側に出力する値'),
    @('csv_sotozei_off', '0', '外税同時入力区分：消費税額がない側に出力する値'),
    @('csv_tax_code_none', '', '消費税コード：課税対象外の科目側に出力する値'),
    @('csv_date_format', 'yyyy/MM/dd', '伝票日付の書式（yyyy/MM/dd または yyyyMMdd）')
  )
  foreach ($s in $settings) {
    W "insert into public.ct_settings (key, value, label) values ($(Q $s[0]), $(Q $s[1]), $(Q $s[2])) on conflict (key) do update set label = excluded.label;"
  }
  W 'commit;'

  $dir = Split-Path $Out -Parent
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
  [IO.File]::WriteAllText($Out, (($sql -join "`n") + "`n"), (New-Object Text.UTF8Encoding $false))
  Write-Host "契約 $($contracts.Count) 件 / 物件 $($props.Count) 件 / 取引先 $($vendors.Count) 件 → $Out"
  foreach ($line in $log) { Write-Host $line }
}
finally {
  Remove-Item -Recurse -Force $work
}
