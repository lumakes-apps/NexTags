import { useState, useEffect, useCallback } from 'react'
import { useBlocker, useSearchParams } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import MusicImportTagEditor from '@/components/MusicImportTagEditor'
import { api } from '@/lib/api'
import {
    IMPORT_PROGRESS, deletePendingImport, errorText, fetchPendingImports, importStatusLabel, tagText,
    type PendingImport,
} from '@/lib/importStatus'

// 匯入狀態枚舉
enum ImportStatus {
    UPLOADED = 'uploaded',
    CONVERTED = 'converted',
    TAGS_EXTRACTED = 'tags_extracted',
    TAGS_EDITED = 'tags_edited',
    ARTIST_READY = 'artist_ready',
    ALBUM_READY = 'album_ready',
    READY_TO_MOVE = 'ready_to_move',
    COMPLETED = 'completed',
    FAILED = 'failed'
}

// 類型定義
interface ImportSession {
    file_id: string
    original_filename: string
    status: ImportStatus
    temp_path: string
    base_folder: string
    needs_conversion: boolean
    format: string
    extracted_tags?: Record<string, unknown>
    suggested_filename?: string
    artist_name?: string
    album_name?: string
    final_filename?: string
    preview_final_path?: string
    needs_artist_image?: boolean
    errors?: string[]
}

interface ArtistCheckResult {
    artist_name: string
    artist_exists: boolean
    artist_folder_path: string
    needs_artist_image: boolean
}

interface BaseFolderOption {
    value: string
    label: string
}

interface ChunkUploadInitResponse {
    upload_id: string
    chunk_size: number
    total_chunks: number
}

const DEFAULT_UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024

export default function NewMusicPage() {
    // 狀態管理
    const [currentSession, setCurrentSession] = useState<ImportSession | null>(null)
    const [baseFolders, setBaseFolders] = useState<BaseFolderOption[]>([])
    const [selectedBaseFolder, setSelectedBaseFolder] = useState<string>('')
    const [isLoading, setIsLoading] = useState(false)
    const [showTagEditor, setShowTagEditor] = useState(false)
    const [showArtistImageDialog, setShowArtistImageDialog] = useState(false)
    const [artistName, setArtistName] = useState('')
    const [artistsNeedingImage, setArtistsNeedingImage] = useState<ArtistCheckResult[]>([])
    const [currentArtistIndex, setCurrentArtistIndex] = useState(0)
    const [albumName, setAlbumName] = useState('')
    const [finalFilename, setFinalFilename] = useState('')
    const [error, setError] = useState<string | null>(null)
    const [progress, setProgress] = useState<number>(0)
    const [isDragging, setIsDragging] = useState(false)
    const [isArtistImageDragging, setIsArtistImageDragging] = useState(false)
    // 未完成的匯入（WaitImport 裡的暫存檔）
    const [pendingImports, setPendingImports] = useState<PendingImport[]>([])
    // 進度遺失的檔案要重新選的目標資料夾（依 file_id）
    const [recoverFolders, setRecoverFolders] = useState<Record<string, string>>({})
    const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null)
    const [searchParams, setSearchParams] = useSearchParams()

    const loadPendingImports = useCallback(async () => {
        try {
            setPendingImports(await fetchPendingImports())
        } catch (error) {
            console.error('載入未完成的匯入失敗:', error)
        }
    }, [])

    // 載入基礎資料夾選項與未完成的匯入
    useEffect(() => {
        fetchBaseFolders()
        loadPendingImports()
    }, [loadPendingImports])

    // 處理中或標籤編輯中離開會中斷目前這一步（已完成的步驟都已存檔，之後可以接續）
    const leaveWarning = isLoading
        ? '目前步驟還在處理中，離開會中斷這一步（已完成的步驟會保留，之後可以接續）。確定要離開？'
        : showTagEditor
            ? '標籤尚未儲存，離開會捨棄這次的修改（匯入進度會保留，之後可以接續）。確定要離開？'
            : ''
    const blocker = useBlocker(({ currentLocation, nextLocation }) =>
        !!leaveWarning && currentLocation.pathname !== nextLocation.pathname)
    useEffect(() => {
        if (blocker.state !== 'blocked') return
        if (window.confirm(leaveWarning || '確定要離開？')) blocker.proceed()
        else blocker.reset()
    }, [blocker, leaveWarning])
    useEffect(() => {
        if (!leaveWarning) return
        const warn = (event: BeforeUnloadEvent) => {
            event.preventDefault()
            event.returnValue = ''
        }
        window.addEventListener('beforeunload', warn)
        return () => window.removeEventListener('beforeunload', warn)
    }, [leaveWarning])

    const fetchBaseFolders = async () => {
        try {
            const data = await api.get('tags/baseFolders')
            if (data.success) {
                const folders = data.base_folders.map((folder: string) => ({
                    value: folder,
                    label: folder
                }))
                setBaseFolders(folders)
                if (folders.length > 0) {
                    setSelectedBaseFolder(folders[0].value)
                }
            }
        } catch (error) {
            console.error('載入基礎資料夾失敗:', error)
            setError('載入基礎資料夾失敗')
        }
    }

    const postChunkWithRetry = async (formData: FormData, maxRetries = 2) => {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                return await api.postFormData('music-import/upload/chunk', formData)
            } catch (error) {
                if (attempt === maxRetries) {
                    throw error
                }
                await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)))
            }
        }
    }

    const uploadFileInChunks = async (file: File) => {
        const init = await api.post('music-import/upload/init', {
            filename: file.name,
            size: file.size,
            base_folder: selectedBaseFolder
        }) as ChunkUploadInitResponse

        const chunkSize = init.chunk_size || DEFAULT_UPLOAD_CHUNK_SIZE
        const totalChunks = init.total_chunks || Math.ceil(file.size / chunkSize)

        for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
            const start = chunkIndex * chunkSize
            const end = Math.min(file.size, start + chunkSize)
            const chunk = file.slice(start, end)
            const formData = new FormData()

            formData.append('upload_id', init.upload_id)
            formData.append('chunk_index', String(chunkIndex))
            formData.append('total_chunks', String(totalChunks))
            formData.append('file', chunk, file.name)

            await postChunkWithRetry(formData)

            const uploadProgress = 5 + Math.round(((chunkIndex + 1) / totalChunks) * 15)
            setProgress(Math.min(uploadProgress, 20))
        }

        return await api.post('music-import/upload/complete', {
            upload_id: init.upload_id
        })
    }

    // 處理文件（通用函數）
    const processFile = async (file: File) => {
        if (!file || !selectedBaseFolder) return

        setIsLoading(true)
        setError(null)
        setProgress(5)

        try {
            const data = await uploadFileInChunks(file)

            setCurrentSession(data)
            setProgress(20)

            // 如果需要轉換，自動執行轉換
            if (data.needs_conversion) {
                await convertFile(data.file_id)
            } else {
                await extractTags(data.file_id)
            }

        } catch (error) {
            console.error('檔案上傳失敗:', error)
            setError(errorText(error, '檔案上傳失敗'))
        } finally {
            setIsLoading(false)
        }
    }

    // 檔案上傳處理
    const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0]
        if (file) {
            await processFile(file)
        }
    }

    // 拖放處理
    const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
        event.preventDefault()
        setIsDragging(true)
    }

    const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
        event.preventDefault()
        setIsDragging(false)
    }

    const handleDrop = async (event: React.DragEvent<HTMLDivElement>) => {
        event.preventDefault()
        setIsDragging(false)

        const file = event.dataTransfer.files[0]
        if (file) {
            // 驗證檔案格式
            const validExtensions = ['.mp3', '.flac', '.ogg', '.m4a']
            const fileExtension = file.name.substring(file.name.lastIndexOf('.')).toLowerCase()

            if (!validExtensions.includes(fileExtension)) {
                setError(`不支援的檔案格式: ${fileExtension}。支援格式: ${validExtensions.join(', ')}`)
                return
            }

            await processFile(file)
        }
    }

    // 轉換檔案
    const convertFile = async (fileId: string) => {
        try {
            setProgress(30)
            const data = await api.post('music-import/convert', { file_id: fileId })

            // 更新當前會話狀態
            await refreshSessionStatus(fileId)
            setProgress(40)

            // 繼續提取標籤
            await extractTags(fileId)

        } catch (error) {
            console.error('檔案轉換失敗:', error)
            setError(errorText(error, '檔案轉換失敗'))
        }
    }

    // 提取標籤
    const extractTags = async (fileId: string) => {
        try {
            setProgress(50)
            const data = await api.post('music-import/extract-tags', { file_id: fileId })

            // 更新當前會話狀態
            await refreshSessionStatus(fileId)
            setProgress(60)

            // 顯示標籤編輯器
            setShowTagEditor(true)

        } catch (error) {
            console.error('標籤提取失敗:', error)
            setError(errorText(error, '標籤提取失敗'))
        }
    }

    // 更新標籤
    const handleUpdateTags = async (tags: Record<string, unknown>) => {
        if (!currentSession) return

        try {
            const data = await api.post('music-import/update-tags', {
                file_id: currentSession.file_id,
                tags: tags
            })

            // 更新當前會話狀態
            await refreshSessionStatus(currentSession.file_id)
            setProgress(70)
            setShowTagEditor(false)

            // 從標籤中提取歌手和專輯名稱
            const artistName = String(tags.artist || '')
            const albumName = String(tags.album || '')
            setArtistName(artistName)
            setAlbumName(albumName)

            // 檢查歌手資料夾 - 直接使用從標籤提取的值
            await checkArtist(currentSession.file_id, artistName, albumName)

        } catch (error) {
            console.error('標籤更新失敗:', error)
            setError(errorText(error, '標籤更新失敗'))
        }
    }

    // 檢查歌手資料夾
    const checkArtist = async (fileId: string, artistName: string, albumName: string) => {
        try {
            const data = await api.post('music-import/check-artist', {
                file_id: fileId,
                artist_name: artistName
            })

            // 更新當前會話狀態
            await refreshSessionStatus(fileId)

            // 找出需要上傳圖片的歌手
            const artistsNeeding = data.artists?.filter((artist: ArtistCheckResult) => artist.needs_artist_image) || []

            if (artistsNeeding.length > 0) {
                setArtistsNeedingImage(artistsNeeding)
                setCurrentArtistIndex(0)
                setShowArtistImageDialog(true)
            } else {
                // 所有歌手都不需要圖片，直接處理專輯
                await processAlbum(fileId, artistName, albumName)
            }

        } catch (error) {
            console.error('檢查歌手資料夾失敗:', error)
            setError(errorText(error, '檢查歌手資料夾失敗'))
        }
    }

    // 前進到下一個需要圖片的歌手，或完成
    const advanceToNextArtist = async () => {
        const nextIndex = currentArtistIndex + 1
        if (nextIndex < artistsNeedingImage.length) {
            setCurrentArtistIndex(nextIndex)
        } else {
            // 所有歌手圖片都處理完了
            setShowArtistImageDialog(false)
            setArtistsNeedingImage([])
            setCurrentArtistIndex(0)
            if (currentSession) {
                await processAlbum(currentSession.file_id, artistName, albumName)
            }
        }
    }

    // 上傳歌手圖片
    const uploadArtistImage = async (file: File) => {
        if (!file || !currentSession || artistsNeedingImage.length === 0) return

        const currentArtist = artistsNeedingImage[currentArtistIndex]

        try {
            const formData = new FormData()
            formData.append('file_id', currentSession.file_id)
            formData.append('artist_name', currentArtist.artist_name)
            formData.append('image', file)

            await api.postFormData('music-import/upload-artist-image', formData)

            await advanceToNextArtist()

        } catch (error) {
            console.error('歌手圖片上傳失敗:', error)
            setError(errorText(error, '歌手圖片上傳失敗'))
        }
    }

    const handleArtistImageUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0]
        if (file) {
            await uploadArtistImage(file)
        }
    }

    // 歌手圖片拖放處理
    const handleArtistImageDragOver = (event: React.DragEvent<HTMLDivElement>) => {
        event.preventDefault()
        setIsArtistImageDragging(true)
    }

    const handleArtistImageDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
        event.preventDefault()
        setIsArtistImageDragging(false)
    }

    const handleArtistImageDrop = async (event: React.DragEvent<HTMLDivElement>) => {
        event.preventDefault()
        setIsArtistImageDragging(false)

        const file = event.dataTransfer.files[0]
        if (file) {
            // 驗證檔案格式
            const validExtensions = ['.jpg', '.jpeg', '.png']
            const fileExtension = file.name.substring(file.name.lastIndexOf('.')).toLowerCase()

            if (!validExtensions.includes(fileExtension)) {
                setError(`不支援的圖片格式: ${fileExtension}。支援格式: ${validExtensions.join(', ')}`)
                return
            }

            await uploadArtistImage(file)
        }
    }

    // 處理專輯
    const processAlbum = async (fileId: string, artistName: string, albumName: string) => {
        try {
            setProgress(80)
            const data = await api.post('music-import/process-album', {
                file_id: fileId,
                artist_name: artistName,
                album_name: albumName
            })

            // 更新當前會話狀態
            const session = await refreshSessionStatus(fileId)

            // 使用此次請求取得的最新標籤檔名，避免讀到舊的 React state。
            const suggestedFilename = session.suggested_filename || `01 - ${session.original_filename}`
            setFinalFilename(suggestedFilename)

            // 準備檔案
            await finalizeFile(fileId, suggestedFilename)

        } catch (error) {
            console.error('專輯處理失敗:', error)
            setError(errorText(error, '專輯處理失敗'))
        }
    }

    // 準備檔案
    const finalizeFile = async (fileId: string, filename: string) => {
        if (!filename.trim()) {
            throw new Error('最終檔案名稱不能為空')
        }

        setProgress(90)
        const data = await api.post('music-import/finalize', {
            file_id: fileId,
            final_filename: filename
        })

        // 顯示後端實際採用的檔名；準備失敗時由呼叫端停止後續移動。
        setFinalFilename(data.preview_final_path.split('/').pop())
        await refreshSessionStatus(fileId)
        setProgress(95)
    }

    // 確認移動檔案
    const confirmMove = async () => {
        if (!currentSession) return

        try {
            setIsLoading(true)
            setError(null)
            await finalizeFile(currentSession.file_id, finalFilename)
            const data = await api.post('music-import/confirm-move', {
                file_id: currentSession.file_id
            })

            // 更新當前會話狀態
            await refreshSessionStatus(currentSession.file_id)
            setProgress(100)

            // 重置狀態
            setTimeout(() => {
                setCurrentSession(null)
                setProgress(0)
                setArtistName('')
                setAlbumName('')
                setFinalFilename('')
                setError(null)
                loadPendingImports()
            }, 2000)

        } catch (error) {
            console.error('檔案移動失敗:', error)
            setError(errorText(error, '檔案移動失敗'))
        } finally {
            setIsLoading(false)
        }
    }

    // 依目前狀態接續下一步（離開後回來、backend 重啟後都適用）
    const continueFrom = async (session: ImportSession) => {
        const fileId = session.file_id
        const tags = session.extracted_tags ?? {}
        const artist = session.artist_name || tagText(tags.artist)
        const album = session.album_name || tagText(tags.album)
        const suggested = session.suggested_filename || `01 - ${session.original_filename}`
        setArtistName(artist)
        setAlbumName(album)
        setProgress(IMPORT_PROGRESS[session.status] ?? 20)
        switch (session.status) {
            case ImportStatus.UPLOADED:
                return session.needs_conversion ? convertFile(fileId) : extractTags(fileId)
            case ImportStatus.CONVERTED:
                return extractTags(fileId)
            case ImportStatus.TAGS_EXTRACTED:
                setShowTagEditor(true)
                return
            case ImportStatus.TAGS_EDITED:
                return checkArtist(fileId, artist, album)
            case ImportStatus.ARTIST_READY:
                // 還有歌手缺照片就重新檢查（已上傳的會被略過），否則直接處理專輯
                return session.needs_artist_image ? checkArtist(fileId, artist, album) : processAlbum(fileId, artist, album)
            case ImportStatus.ALBUM_READY:
                setFinalFilename(suggested)
                try {
                    await finalizeFile(fileId, suggested)
                } catch (error) {
                    setError(errorText(error, '檔案準備失敗'))
                }
                return
            case ImportStatus.READY_TO_MOVE:
                setFinalFilename(session.final_filename || suggested)
                return
        }
    }

    // 接續某個未完成的匯入；進度遺失的檔案需要 baseFolder
    const resumeImport = async (fileId: string, baseFolder?: string) => {
        setIsLoading(true)
        setError(null)
        try {
            const data = await api.post('music-import/resume', { file_id: fileId, base_folder: baseFolder || undefined })
            const session: ImportSession = { ...data.file_info, file_id: data.file_id }
            setCurrentSession(session)
            await continueFrom(session)
        } catch (error) {
            setError(errorText(error, '無法接續這個匯入'))
            await loadPendingImports()
        } finally {
            setIsLoading(false)
        }
    }

    const continueCurrent = async () => {
        if (!currentSession) return
        setIsLoading(true)
        setError(null)
        try {
            await continueFrom(currentSession)
        } finally {
            setIsLoading(false)
        }
    }

    // 先放著，回到上傳畫面（進度已存，之後可從這裡或快取頁接續）
    const pauseImport = async () => {
        setCurrentSession(null)
        setProgress(0)
        setError(null)
        setShowTagEditor(false)
        setShowArtistImageDialog(false)
        await loadPendingImports()
    }

    const deletePending = async (fileId: string) => {
        try {
            await deletePendingImport(fileId)
            setConfirmingDelete(null)
            await loadPendingImports()
        } catch (error) {
            setError(errorText(error, '刪除失敗'))
        }
    }

    // 從快取頁的「繼續」進來：/new?resume=<file_id>
    const resumeParam = searchParams.get('resume')
    useEffect(() => {
        if (!resumeParam || pendingImports.length === 0) return
        const target = pendingImports.find(item => item.file_id === resumeParam)
        setSearchParams({}, { replace: true })
        // 進度遺失的要先選目標資料夾，留在清單上讓使用者選
        if (target && !target.needs_base_folder) resumeImport(target.file_id)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [resumeParam, pendingImports])

    // 刷新會話狀態
    const refreshSessionStatus = async (fileId: string) => {
        const data = await api.get('music-import/status', { file_id: fileId })

        if (!data.success) {
            throw new Error('刷新會話狀態失敗')
        }

        const session: ImportSession = { ...data.file_info, file_id: fileId }
        setCurrentSession(session)
        return session
    }

    // 取消匯入
    const cancelImport = async () => {
        if (!currentSession) return

        try {
            const response = await fetch(api.url('music-import/delete'), {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    file_id: currentSession.file_id
                })
            })

            if (response.ok) {
                setCurrentSession(null)
                setProgress(0)
                setError(null)
                await loadPendingImports()
            }
        } catch (error) {
            console.error('取消匯入失敗:', error)
        }
    }

    return (
        <div className="container mx-auto px-4 py-8 max-w-4xl">
            <div className="mb-6">
                <h1 className="text-3xl font-bold">新增音樂</h1>
                <p className="text-gray-600 mt-2">上傳音樂檔案並組織到音樂庫中</p>
            </div>

            {/* 進度條 */}
            {progress > 0 && (
                <div className="mb-6">
                    <div className="w-full bg-gray-200 rounded-full h-2">
                        <div
                            className="bg-gray-600 h-2 rounded-full transition-all duration-300"
                            style={{ width: `${progress}%` }}
                        ></div>
                    </div>
                    <p className="text-sm text-gray-600 mt-1">進度: {progress}%</p>
                </div>
            )}

            {/* 錯誤訊息 */}
            {error && (
                <div className="mb-6 p-4 bg-red-100 border border-red-400 text-red-700 rounded">
                    {error}
                </div>
            )}

            {/* 未完成的匯入：可接續或刪除 */}
            {!currentSession && pendingImports.length > 0 && (
                <Card className="mb-6" data-testid="pending-imports">
                    <CardHeader>
                        <CardTitle>未完成的匯入（{pendingImports.length}）</CardTitle>
                        <CardDescription>上次中途離開或伺服器重啟時沒做完的歌曲，可以從中斷的地方繼續，不用重新上傳。</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <ul className="divide-y">
                            {pendingImports.map(item => {
                                const folder = recoverFolders[item.file_id] ?? selectedBaseFolder
                                return (
                                    <li key={item.file_id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                                        <div className="min-w-0">
                                            <p className="truncate font-medium text-gray-900">{item.original_filename}</p>
                                            <p className="text-sm text-gray-600">
                                                {importStatusLabel(item.status)}
                                                {item.base_folder && ` · ${item.base_folder}`}
                                            </p>
                                            {item.needs_base_folder && (
                                                <label className="mt-1 flex items-center gap-2 text-sm text-gray-700">
                                                    目標資料夾
                                                    <select
                                                        value={folder}
                                                        onChange={event => setRecoverFolders(prev => ({ ...prev, [item.file_id]: event.target.value }))}
                                                        className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm"
                                                    >
                                                        {baseFolders.map(option => (
                                                            <option key={option.value} value={option.value}>{option.label}</option>
                                                        ))}
                                                    </select>
                                                </label>
                                            )}
                                        </div>
                                        <div className="flex shrink-0 gap-2">
                                            {confirmingDelete === item.file_id ? (
                                                <>
                                                    <Button variant="destructive" size="sm" onClick={() => deletePending(item.file_id)}>
                                                        確定刪除
                                                    </Button>
                                                    <Button variant="outline" size="sm" onClick={() => setConfirmingDelete(null)}>
                                                        取消
                                                    </Button>
                                                </>
                                            ) : (
                                                <>
                                                    <Button size="sm" disabled={isLoading || (item.needs_base_folder && !folder)}
                                                        aria-label={`繼續匯入 ${item.original_filename}`}
                                                        onClick={() => resumeImport(item.file_id, item.needs_base_folder ? folder : undefined)}>
                                                        {item.needs_base_folder ? '重新開始處理' : '繼續'}
                                                    </Button>
                                                    <Button variant="outline" size="sm" disabled={isLoading}
                                                        aria-label={`刪除 ${item.original_filename}`}
                                                        onClick={() => setConfirmingDelete(item.file_id)}>
                                                        刪除
                                                    </Button>
                                                </>
                                            )}
                                        </div>
                                    </li>
                                )
                            })}
                        </ul>
                    </CardContent>
                </Card>
            )}

            {/* 檔案上傳區域 */}
            {!currentSession && (
                <Card className="mb-6">
                    <CardHeader>
                        <CardTitle>上傳音樂檔案</CardTitle>
                        <CardDescription>
                            支援格式: MP3, FLAC, OGG, M4A (.m4a 檔案會自動轉換為 .flac)
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium mb-2">目標資料夾</label>
                                <Select value={selectedBaseFolder} onValueChange={setSelectedBaseFolder}>
                                    <SelectTrigger className="w-full">
                                        <SelectValue placeholder="選擇目標資料夾" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {baseFolders.map((folder) => (
                                            <SelectItem key={folder.value} value={folder.value}>
                                                {folder.label}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>

                            <div>
                                <label className="block text-sm font-medium mb-2">選擇音樂檔案</label>
                                <div
                                    onDragOver={handleDragOver}
                                    onDragLeave={handleDragLeave}
                                    onDrop={handleDrop}
                                    className={`
                                        relative border-2 border-dashed rounded-lg p-8 text-center transition-colors
                                        ${isDragging
                                            ? 'border-gray-600 bg-gray-50'
                                            : 'border-gray-300 bg-white'
                                        }
                                        ${isLoading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
                                    `}
                                >
                                    <input
                                        type="file"
                                        accept=".mp3,.flac,.ogg,.m4a"
                                        onChange={handleFileUpload}
                                        disabled={isLoading}
                                        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                                        id="file-upload"
                                    />
                                    <div className="space-y-2">
                                        <div className="text-gray-600">
                                            <p className="text-sm">拖放音樂檔案到此處</p>
                                            <p className="text-xs text-gray-500 mt-1">或</p>
                                        </div>
                                        <Button
                                            type="button"
                                            variant="outline"
                                            disabled={isLoading}
                                            onClick={() => document.getElementById('file-upload')?.click()}
                                            className="pointer-events-none"
                                        >
                                            選擇檔案
                                        </Button>
                                        <p className="text-xs text-gray-500 mt-2">
                                            支援格式: MP3, FLAC, OGG, M4A
                                        </p>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* 當前處理狀態 */}
            {currentSession && (
                <Card className="mb-6">
                    <CardHeader>
                        <CardTitle>處理中: {currentSession.original_filename}</CardTitle>
                        <CardDescription>
                            狀態: {importStatusLabel(currentSession.status)} | 格式: {currentSession.format}
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="space-y-4">
                            {/* 最終確認區域 */}
                            {currentSession.status === ImportStatus.READY_TO_MOVE && (
                                <div className="space-y-4">
                                    <h3 className="text-lg font-semibold">確認資訊</h3>
                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="space-y-2">
                                            <label className="block text-sm font-medium">歌手</label>
                                            <p className="text-gray-800">{artistName}</p>
                                        </div>
                                        <div className="space-y-2">
                                            <label className="block text-sm font-medium">專輯</label>
                                            <p className="text-gray-800">{albumName}</p>
                                        </div>
                                        <div className="col-span-2 space-y-2">
                                            <label className="block text-sm font-medium">最終檔案名稱</label>
                                            <Input
                                                value={finalFilename}
                                                onChange={(e) => setFinalFilename(e.target.value)}
                                                disabled={isLoading}
                                                className="mt-1"
                                            />
                                        </div>
                                        <div className="col-span-2 space-y-2">
                                            <label className="block text-sm font-medium">最終路徑</label>
                                            <p className="text-gray-600 text-sm">
                                                {currentSession.preview_final_path?.replace(/[^/]*$/, () => finalFilename)}
                                            </p>
                                        </div>
                                    </div>

                                    <div className="flex space-x-4 justify-end">
                                        <Button
                                            onClick={confirmMove}
                                            disabled={isLoading || !finalFilename.trim()}
                                            className="bg-gray-600 hover:bg-gray-700"
                                        >
                                            確認移動檔案
                                        </Button>
                                        <Button
                                            onClick={pauseImport}
                                            variant="outline"
                                            disabled={isLoading}
                                        >
                                            稍後再處理
                                        </Button>
                                        <Button
                                            onClick={cancelImport}
                                            variant="outline"
                                            disabled={isLoading}
                                            className="text-red-600"
                                        >
                                            取消並刪除
                                        </Button>
                                    </div>
                                </div>
                            )}

                            {/* 停在某一步（例如關掉了標籤編輯器、步驟失敗）：可以繼續、先放著或刪除 */}
                            {!isLoading && !showTagEditor && !showArtistImageDialog
                                && currentSession.status !== ImportStatus.READY_TO_MOVE
                                && currentSession.status !== ImportStatus.COMPLETED && (
                                <div className="flex flex-wrap justify-end gap-2" data-testid="import-actions">
                                    <Button onClick={continueCurrent}>繼續匯入</Button>
                                    <Button variant="outline" onClick={pauseImport}>稍後再處理</Button>
                                    <Button variant="outline" onClick={cancelImport} className="text-red-600">取消並刪除</Button>
                                </div>
                            )}

                            {/* 完成狀態 */}
                            {currentSession.status === ImportStatus.COMPLETED && (
                                <div className="text-center">
                                    <div className="text-green-600 text-lg font-semibold">檔案匯入完成!</div>
                                    <p className="text-gray-600 mt-2">檔案已成功移動到: {currentSession.preview_final_path}</p>
                                </div>
                            )}

                            {/* 錯誤列表 */}
                            {currentSession.errors && currentSession.errors.length > 0 && (
                                <div className="bg-red-50 p-4 rounded border border-red-200">
                                    <h4 className="text-red-800 font-medium">錯誤訊息:</h4>
                                    <ul className="text-red-700 text-sm mt-2">
                                        {currentSession.errors.map((error, index) => (
                                            <li key={index}>{error}</li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* 標籤編輯對話框 */}
            <Dialog open={showTagEditor} onOpenChange={setShowTagEditor}>
                <DialogContent className="max-w-4xl max-h-[80vh] overflow-auto">
                    <DialogHeader>
                        <DialogTitle>編輯音樂標籤</DialogTitle>
                        <DialogDescription>
                            請編輯音樂標籤資訊，完成後點擊儲存繼續
                        </DialogDescription>
                    </DialogHeader>
                    {currentSession?.extracted_tags && (
                        <MusicImportTagEditor
                            filePath={currentSession.temp_path}
                            onSave={handleUpdateTags}
                            onCancel={() => setShowTagEditor(false)}
                            initialTags={currentSession.extracted_tags}
                        />
                    )}
                </DialogContent>
            </Dialog>

            {/* 歌手圖片上傳對話框 */}
            <Dialog open={showArtistImageDialog} onOpenChange={setShowArtistImageDialog}>
                <DialogContent>
                    <DialogHeader className="grid">
                        <DialogTitle>上傳歌手圖片{artistsNeedingImage.length > 1 ? ` (${currentArtistIndex + 1}/${artistsNeedingImage.length})` : ''}</DialogTitle>
                        <DialogDescription>
                            歌手 &quot;{artistsNeedingImage[currentArtistIndex]?.artist_name}&quot; 的資料夾需要封面圖片，請上傳歌手圖片 (JPG/PNG 格式)，檔案將保存為 artist.jpg
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4">
                        <div
                            onDragOver={handleArtistImageDragOver}
                            onDragLeave={handleArtistImageDragLeave}
                            onDrop={handleArtistImageDrop}
                            className={`
                                relative border-2 border-dashed rounded-lg p-8 text-center transition-colors
                                ${isArtistImageDragging
                                    ? 'border-gray-600 bg-gray-50'
                                    : 'border-gray-300 bg-white'
                                }
                                cursor-pointer
                            `}
                        >
                            <input
                                type="file"
                                accept=".jpg,.jpeg,.png"
                                onChange={handleArtistImageUpload}
                                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                                id="artist-image-upload"
                            />
                            <div className="space-y-2">
                                <div className="text-gray-600">
                                    <p className="text-sm">拖放圖片到此處</p>
                                    <p className="text-xs text-gray-500 mt-1">或</p>
                                </div>
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={() => document.getElementById('artist-image-upload')?.click()}
                                    className="pointer-events-none"
                                >
                                    選擇檔案
                                </Button>
                                <p className="text-xs text-gray-500 mt-2">
                                    支援格式: JPG, JPEG, PNG
                                </p>
                            </div>
                        </div>
                        <div className="flex space-x-4 justify-end">
                            <Button
                                onClick={() => advanceToNextArtist()}
                                variant="outline"
                            >
                                {currentArtistIndex < artistsNeedingImage.length - 1 ? '跳過此歌手' : '跳過'}
                            </Button>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    )
}
