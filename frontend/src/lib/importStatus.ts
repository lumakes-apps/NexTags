// 匯入精靈的狀態顯示、接續相關的共用工具（新增歌曲頁與快取頁共用）
import { isAxiosError } from 'axios'
import { api } from '@/lib/api'

export const IMPORT_STATUS_LABELS: Record<string, string> = {
  uploaded: '已上傳，待讀取標籤',
  converted: '已轉檔，待讀取標籤',
  tags_extracted: '待編輯標籤',
  tags_edited: '標籤已儲存，待確認歌手',
  artist_ready: '待處理歌手照片與專輯',
  album_ready: '專輯已建立，待確認檔名',
  ready_to_move: '待確認移動',
  completed: '已完成',
  failed: '失敗',
  orphaned: '進度遺失，可從檔案重新開始',
  unknown: '非匯入檔案，可從檔案開始處理',
}

export const importStatusLabel = (status: string) => IMPORT_STATUS_LABELS[status] ?? status

/** 各步驟對應的進度條位置 */
export const IMPORT_PROGRESS: Record<string, number> = {
  uploaded: 20, converted: 40, tags_extracted: 60, tags_edited: 70,
  artist_ready: 75, album_ready: 80, ready_to_move: 95, completed: 100,
}

export interface PendingImport {
  file_id: string
  original_filename: string
  status: string
  created_at: string
  updated_at: string
  base_folder: string
  errors: string[]
  next_action?: string | null
  /** 進度已遺失：接續時要重新選目標資料夾 */
  needs_base_folder?: boolean
}

export const fetchPendingImports = async (): Promise<PendingImport[]> => {
  const data = await api.get('music-import/pending')
  return data.pending_imports ?? []
}

export const deletePendingImport = (fileId: string) =>
  fetch(api.url('music-import/delete'), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
  }).then(response => {
    if (!response.ok) throw new Error('刪除失敗，請重試')
  })

/** 取出後端回傳的錯誤說明（axios 預設訊息只有狀態碼） */
export const errorText = (error: unknown, fallback: string) => {
  if (isAxiosError(error)) {
    const detail = error.response?.data?.detail
    if (typeof detail === 'string' && detail) return detail
  }
  return error instanceof Error && error.message ? error.message : fallback
}

/** 標籤值可能是字串或陣列（多值），轉成以分號分隔的文字 */
export const tagText = (value: unknown) =>
  Array.isArray(value) ? value.map(String).join(';') : value == null ? '' : String(value)
