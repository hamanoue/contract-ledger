import { useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { ErrorBox } from '../components/ui'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    setBusy(false)
    if (error) setError(error.message === 'Invalid login credentials' ? 'メールアドレスまたはパスワードが違います' : error.message)
  }

  async function reset() {
    if (!email) {
      setError('メールアドレスを入力してください')
      return
    }
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.href.split('#')[0] })
    if (error) setError(error.message)
    else setSent(true)
  }

  return (
    <div className="center-screen">
      <form className="card narrow" onSubmit={submit}>
        <h1>定期契約・経過勘定管理</h1>
        <p className="muted">総務経理部・管理部の担当者用です。</p>
        <ErrorBox error={error} />
        {sent && <div className="alert alert-ok">パスワード再設定メールを送信しました。</div>}
        <label className="field">
          <span className="field-label">メールアドレス</span>
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="field">
          <span className="field-label">パスワード</span>
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <button className="primary block" disabled={busy}>{busy ? 'ログイン中…' : 'ログイン'}</button>
        <button type="button" className="link" onClick={reset}>パスワードを忘れた場合</button>
      </form>
    </div>
  )
}
