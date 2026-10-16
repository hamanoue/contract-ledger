import { useEffect, useRef } from 'react'
import { useBlocker } from 'react-router-dom'

const MESSAGE = '保存していない変更があります。\nこのページを離れると入力した内容は失われます。移動しますか？'

/**
 * 未保存の変更があるとき、画面移動・再読み込み・タブを閉じる前に確認する。
 * 保存直後など確認せずに移動したいときは、返り値の allowNextLeave() を呼んでから navigate する。
 */
export function useUnsavedGuard(dirty: boolean) {
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const allowRef = useRef(false)

  // アプリ内の画面移動（メニュー・リンク・戻る/進む）
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    dirtyRef.current && !allowRef.current && currentLocation.pathname !== nextLocation.pathname)

  useEffect(() => {
    if (blocker.state !== 'blocked') return
    if (window.confirm(MESSAGE)) blocker.proceed()
    else blocker.reset()
  }, [blocker])

  // 再読み込み・タブを閉じる・別サイトへ移動（文言はブラウザ既定のものになる）
  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  return {
    allowNextLeave: () => { allowRef.current = true },
  }
}
