import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase, check } from './supabase'
import type { Account, CodeValue, Profile, Property, Setting, TaxCode, Vendor } from './types'

interface Masters {
  properties: Property[]
  accounts: Account[]
  vendors: Vendor[]
  taxCodes: TaxCode[]
  codeValues: CodeValue[]
  settings: Setting[]
}

interface SessionState {
  session: Session | null
  profile: Profile | null
  loading: boolean
  masters: Masters
  reloadMasters: () => Promise<void>
  reloadProfile: () => Promise<void>
  isAccounting: boolean
  canEdit: boolean
  isAdmin: boolean
  options: (category: string) => string[]
  propertyName: (code: number | null | undefined) => string
  accountName: (code: number | null | undefined) => string
  setting: (key: string) => string
}

const empty: Masters = { properties: [], accounts: [], vendors: [], taxCodes: [], codeValues: [], settings: [] }
const Ctx = createContext<SessionState | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [masters, setMasters] = useState<Masters>(empty)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      if (!data.session) setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  const reloadProfile = useCallback(async () => {
    if (!session) {
      setProfile(null)
      return
    }
    const res = await supabase.from('ct_profiles').select('*').eq('user_id', session.user.id).maybeSingle()
    setProfile((res.data as Profile | null) ?? null)
  }, [session])

  const reloadMasters = useCallback(async () => {
    const [p, a, v, t, c, s] = await Promise.all([
      supabase.from('ct_properties').select('*').order('sort').order('code'),
      supabase.from('ct_accounts').select('*').order('code'),
      supabase.from('ct_vendors').select('*').order('code'),
      supabase.from('ct_tax_codes').select('*').order('sort'),
      supabase.from('ct_code_values').select('*').order('category').order('sort'),
      supabase.from('ct_settings').select('*').order('key'),
    ])
    setMasters({
      properties: check(p) as Property[],
      accounts: check(a) as Account[],
      vendors: check(v) as Vendor[],
      taxCodes: check(t) as TaxCode[],
      codeValues: check(c) as CodeValue[],
      settings: check(s) as Setting[],
    })
  }, [])

  useEffect(() => {
    if (!session) {
      setProfile(null)
      setMasters(empty)
      return
    }
    setLoading(true)
    reloadProfile()
      .then(() => reloadMasters())
      .catch(() => undefined)
      .finally(() => setLoading(false))
  }, [session, reloadProfile, reloadMasters])

  const value = useMemo<SessionState>(() => {
    const propMap = new Map(masters.properties.map((p) => [p.code, p.name]))
    const accMap = new Map(masters.accounts.map((a) => [a.code, a.name]))
    const setMap = new Map(masters.settings.map((s) => [s.key, s.value ?? '']))
    return {
      session,
      profile,
      loading,
      masters,
      reloadMasters,
      reloadProfile,
      isAccounting: profile?.department === '総務経理部',
      canEdit: profile?.role === 'admin' || profile?.role === 'editor',
      isAdmin: profile?.role === 'admin',
      options: (category) => masters.codeValues.filter((c) => c.category === category).map((c) => c.value),
      propertyName: (code) => (code === null || code === undefined ? '' : propMap.get(code) ?? String(code)),
      accountName: (code) => (code === null || code === undefined ? '' : accMap.get(code) ?? '未登録'),
      setting: (key) => setMap.get(key) ?? '',
    }
  }, [session, profile, loading, masters, reloadMasters, reloadProfile])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useSession(): SessionState {
  const v = useContext(Ctx)
  if (!v) throw new Error('SessionProvider がありません')
  return v
}
