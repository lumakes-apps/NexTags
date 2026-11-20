import { useEffect, useState } from 'react'
import { fetchPinyin } from '@/lib/artists'

/**
 * 由文字自動產生排序名稱（拼音），不讓使用者手動編輯。
 *
 * 文字與原本相同且原本已有排序名稱時沿用原值，避免只改其他欄位時排序被悄悄改掉；
 * 文字改變或原本沒有排序名稱時，以拼音重新產生。打字時延遲轉換以減少請求，
 * 存檔時呼叫 resolve() 取得最終值。sort 為 null 代表還在轉換中。
 */
export function useAutoSort(text: string, originalText: string, originalSort: string) {
  const value = text.trim()
  const keep = value === originalText.trim() && originalSort !== ''
  const [sort, setSort] = useState<string | null>(keep ? originalSort : null)

  useEffect(() => {
    if (keep) { setSort(originalSort); return }
    if (!value) { setSort(''); return }
    setSort(null)
    let cancelled = false
    const timer = setTimeout(() => {
      fetchPinyin(value)
        .then(result => { if (!cancelled) setSort(result) })
        .catch(() => { /* 存檔時 resolve() 會再試一次 */ })
    }, 300)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [value, keep, originalSort])

  const resolve = async (): Promise<string> => {
    if (keep) return originalSort
    if (!value) return ''
    return fetchPinyin(value)
  }

  return { sort, resolve }
}
