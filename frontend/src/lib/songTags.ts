// 首頁標籤編輯器的歌曲資料 ↔ 後端標籤欄位，以及編輯後的檔案移動

export interface EditableSong {
  Title: string
  Artist: string
  Album: string
  AlbumArtist?: string
  Composer?: string
  Performer?: string
  SortTitle?: string
  SortArtist?: string
  SortAlbum?: string
  SortAlbumArtist?: string
  SortComposer?: string
  SortPerformer?: string
  TrackNumber?: string
  TrackTotal?: string
  DiscNumber?: string
  DiscTotal?: string
  Genre: string[]
  Language: string
  Favorite: string
  Lyrics?: string
  Comment?: string
}

/**
 * 只送編輯器可修改的欄位：後端把空值視為刪除，
 * ReplayGain 由後端計算寫入、列表 API 也不回傳 album gain，不能由這裡覆寫。
 */
export const songToTags = (song: EditableSong) => ({
  title: song.Title,
  artist: song.Artist,
  album: song.Album,
  albumartist: song.AlbumArtist || '',
  composer: song.Composer || '',
  performer: song.Performer || '',
  titlesort: song.SortTitle,
  artistsort: song.SortArtist,
  albumsort: song.SortAlbum,
  albumartistsort: song.SortAlbumArtist || '',
  composersort: song.SortComposer || '',
  performersort: song.SortPerformer || '',
  tracknumber: song.TrackNumber || '',
  tracktotal: song.TrackTotal || '',
  discnumber: song.DiscNumber || '',
  disctotal: song.DiscTotal || '',
  genre: song.Genre,
  language: song.Language,
  favorite: song.Favorite,
  lyrics: song.Lyrics || '',
  comment: song.Comment || '',
})

export interface MoveProposal {
  current: string
  proposed: string
  changed: ('artist' | 'album' | 'filename')[]
}

export interface MovePreview {
  proposal: MoveProposal | null
  conflict?: boolean
  others_in_folder?: number
}

export interface PendingMove {
  source: string
  target: string
  created_at: string
  status: 'pending' | 'failed'
  error: string | null
}

/** 儲存時的檔案移動選擇；filename 為確認視窗中修改後的檔名（不含副檔名）。 */
export interface MoveChoice {
  move: boolean
  filename?: string
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new Error(typeof data?.detail === 'string' ? data.detail : '請求失敗，請重試')
  return data as T
}

export const previewMove = (path: string, song: EditableSong) =>
  request<MovePreview>('/api/audios/move-preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, tags: [songToTags(song)] }),
  })

export const fetchPendingMoves = () => request<PendingMove[]>('/api/audios/pending-moves')

export const cancelPendingMove = (path: string) =>
  request<{ success: boolean }>(`/api/audios/pending-moves?path=${encodeURIComponent(path)}`, { method: 'DELETE' })

export const splitPath = (path: string) => {
  const slash = path.lastIndexOf('/')
  const name = path.slice(slash + 1)
  const dot = name.lastIndexOf('.')
  return { dir: path.slice(0, slash), stem: dot > 0 ? name.slice(0, dot) : name, ext: dot > 0 ? name.slice(dot) : '' }
}
