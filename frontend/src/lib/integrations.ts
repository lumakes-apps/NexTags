import { useEffect, useState } from 'react'

export interface IntegrationField {
  name: string
  label: string
  kind: 'text' | 'url' | 'number' | 'bool' | 'secret'
  default: unknown
  help: string
}

export interface FavoritesSyncResult {
  ok: boolean
  started_at: string
  finished_at: string
  strategy?: string
  applied?: Record<'star' | 'unstar' | 'favorite' | 'unfavorite', number>
  errors?: string[]
  error?: string
}

export interface Integration {
  key: string
  name: string
  description: string
  enabled: boolean
  /** 已啟用且設定齊全，可實際使用 */
  available: boolean
  fields: IntegrationField[]
  settings: Record<string, unknown>
  /** 密鑰只標示來源：'env'、'database' 或 null（未設定），不含內容 */
  secrets: Record<string, 'env' | 'database' | null>
  master_key_configured: boolean
  status: {
    scan?: { ok: boolean; request_requested_at: string; completed_at: string } | null
    favorites?: { initialized: boolean; last: FavoritesSyncResult | null }
  }
}

export interface FavoritesPreview {
  initialized: boolean
  matched_songs: number
  local_favorites: number
  remote_favorites: number
  only_local: string[]
  only_remote: string[]
  only_local_count: number
  only_remote_count: number
  not_in_navidrome: number
  not_in_nextags: number
  plan: Record<'star' | 'unstar' | 'favorite' | 'unfavorite', number>
}

export type SyncStrategy = 'union' | 'local' | 'remote'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new Error(typeof data?.detail === 'string' ? data.detail : '請求失敗，請重試')
  return data as T
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export const fetchIntegrations = () => request<Integration[]>('/api/integrations')

export const saveIntegration = (
  key: string,
  update: { enabled?: boolean; settings?: Record<string, unknown>; secrets?: Record<string, string | null> },
) => request<Integration>(`/api/integrations/${key}`, json('PUT', update))

export const testIntegration = (key: string) =>
  request<{ ok: boolean; message: string }>(`/api/integrations/${key}/test`, { method: 'POST' })

export const previewFavorites = (strategy: SyncStrategy) =>
  request<FavoritesPreview>('/api/integrations/navidrome/favorites/preview', json('POST', { strategy }))

export const syncFavorites = (strategy?: SyncStrategy) =>
  request<FavoritesSyncResult>('/api/integrations/navidrome/favorites/sync', json('POST', { strategy }))

/** 某個整合是否可用（已啟用且設定齊全）；載入中或失敗時視為不可用。 */
export function useIntegrationAvailable(key: string): boolean {
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    let cancelled = false
    fetchIntegrations()
      .then(list => { if (!cancelled) setAvailable(list.find(item => item.key === key)?.available ?? false) })
      .catch(() => { if (!cancelled) setAvailable(false) })
    return () => { cancelled = true }
  }, [key])
  return available
}

/** AI 整理歌詞；失敗時拋出後端的錯誤訊息（例如未設定金鑰）。 */
export async function cleanLyricsWithAI(lyric: string): Promise<string> {
  const data = await request<{ result: string }>('/api/tools/lyric', json('POST', { lyric }))
  if (!data.result) throw new Error('AI 沒有回傳結果，請重試')
  return data.result
}
