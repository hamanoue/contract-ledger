import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useSession } from '../lib/session'
import { ErrorBox, Loading, Notice, PageHeader } from '../components/ui'

interface UserRow {
  user_id: string
  email: string
  display_name: string | null
  department: string | null
  role: string | null
  last_sign_in_at: string | null
}

export default function Users() {
  const { session, reloadProfile } = useSession()
  const [rows, setRows] = useState<UserRow[] | null>(null)
  const [drafts, setDrafts] = useState<Record<string, Partial<UserRow>>>({})
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const load = useCallback(async () => {
    const r = await supabase.rpc('ct_admin_list_users')
    if (r.error) setError(r.error.message)
    else {
      setRows(r.data as UserRow[])
      setDrafts({})
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const val = (u: UserRow, k: keyof UserRow) => (drafts[u.user_id]?.[k] ?? u[k] ?? '') as string

  async function save(u: UserRow) {
    setError(null)
    setMsg(null)
    const d = { ...u, ...drafts[u.user_id] }
    if (!d.department) {
      setError('部署を選んでください')
      return
    }
    const r = await supabase.from('ct_profiles').upsert({
      user_id: u.user_id,
      display_name: d.display_name ?? '',
      department: d.department,
      role: d.role || 'editor',
      updated_at: new Date().toISOString(),
    })
    if (r.error) setError(r.error.message)
    else {
      setMsg(`${u.email} の権限を保存しました`)
      if (u.user_id === session?.user.id) reloadProfile()
      load()
    }
  }

  async function revoke(u: UserRow) {
    if (u.user_id === session?.user.id) {
      setError('自分自身の権限は削除できません')
      return
    }
    const r = await supabase.from('ct_profiles').delete().eq('user_id', u.user_id)
    if (r.error) setError(r.error.message)
    else load()
  }

  return (
    <>
      <PageHeader
        title="ユーザー権限"
        sub="Supabase（fixed-asset-ledger）に登録されているユーザーに、このアプリの部署と権限を割り当てます。新しいユーザーの追加は Supabase の Authentication 画面（招待）で行ってください。"
      />
      <ErrorBox error={error} />
      {msg && <Notice tone="ok">{msg}</Notice>}
      <Notice>
        <b>総務経理部</b>：全契約（本社含む）・仕訳・経過勘定残高を扱えます。<b>管理部</b>：ビル等の契約の入力・閲覧と従量実績の入力ができます（本社契約・仕訳は表示されません）。
        権限：<b>管理者</b>＝全操作＋ユーザー管理・締め解除／<b>編集</b>＝入力・更新／<b>閲覧</b>＝見るだけ。
      </Notice>
      {!rows ? (
        <Loading />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>メールアドレス</th><th>表示名</th><th>部署</th><th>権限</th><th>最終ログイン</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.user_id} className={u.department ? '' : 'dim'}>
                  <td>{u.email}</td>
                  <td><input value={val(u, 'display_name')} onChange={(e) => setDrafts((d) => ({ ...d, [u.user_id]: { ...d[u.user_id], display_name: e.target.value } }))} /></td>
                  <td>
                    <select value={val(u, 'department')} onChange={(e) => setDrafts((d) => ({ ...d, [u.user_id]: { ...d[u.user_id], department: e.target.value } }))}>
                      <option value="">（権限なし）</option>
                      <option value="総務経理部">総務経理部</option>
                      <option value="管理部">管理部</option>
                    </select>
                  </td>
                  <td>
                    <select value={val(u, 'role') || 'editor'} onChange={(e) => setDrafts((d) => ({ ...d, [u.user_id]: { ...d[u.user_id], role: e.target.value } }))}>
                      <option value="admin">管理者</option>
                      <option value="editor">編集</option>
                      <option value="viewer">閲覧</option>
                    </select>
                  </td>
                  <td className="small">{u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleString('ja-JP') : '—'}</td>
                  <td className="nowrap">
                    <button className="small primary" onClick={() => save(u)} disabled={!drafts[u.user_id]}>保存</button>
                    {u.department && <button className="small" onClick={() => revoke(u)}>権限を外す</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
