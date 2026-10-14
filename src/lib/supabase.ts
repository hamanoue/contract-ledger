import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const isConfigured = Boolean(url && key)

export const supabase = createClient(url ?? 'http://localhost', key ?? 'missing', {
  auth: { persistSession: true, autoRefreshToken: true },
})

/** Supabase のエラーを日本語メッセージに寄せて投げる */
export function check<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) {
    const m = res.error.message
    if (m.includes('row-level security')) throw new Error('権限がありません（この操作は許可されていません）')
    if (m.includes('duplicate key')) throw new Error('同じキーのデータが既に存在します')
    throw new Error(m)
  }
  return res.data
}
