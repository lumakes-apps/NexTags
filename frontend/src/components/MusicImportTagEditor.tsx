'use client'

import { useState, useEffect, useMemo, useId } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import ArtistTagInput from '@/components/ArtistTagInput'
import { useAutoSort } from '@/lib/useAutoSort'
import { cleanLyricsWithAI, useIntegrationAvailable } from '@/lib/integrations'
import {
    SORT_FIELD,
    chipsFromTags,
    fetchArtistDirectory,
    joinNames,
    joinSorts,
    resolveChips,
    type ArtistChip,
    type ArtistDirectory,
    type ArtistRole,
} from '@/lib/artists'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Save, Sparkles, X } from 'lucide-react'

const ARTIST_ROLES: ArtistRole[] = ['artist', 'albumartist', 'composer', 'performer']

const chipsFromTagDict = (tags: Record<string, unknown>) =>
    Object.fromEntries(ARTIST_ROLES.map(role => [role, chipsFromTags(tags[role], tags[SORT_FIELD[role]])])) as Record<ArtistRole, ArtistChip[]>

interface TagEditorProps {
    filePath: string
    initialTags: Record<string, unknown>
    onSave: (tags: Record<string, unknown>) => void
    onCancel: () => void
}

export default function MusicImportTagEditor({ filePath, initialTags, onSave, onCancel }: TagEditorProps) {
    const [tags, setTags] = useState<Record<string, unknown>>(initialTags || {})
    const [loading, setLoading] = useState(false)
    const [languages, setLanguages] = useState<Record<string, string>>({})
    const [availableTags, setAvailableTags] = useState<string[]>([])
    const [artistChips, setArtistChips] = useState<Record<ArtistRole, ArtistChip[]>>(() => chipsFromTagDict(initialTags || {}))
    const [artistDirectory, setArtistDirectory] = useState<ArtistDirectory | null>(null)
    const [directoryReady, setDirectoryReady] = useState(false)
    const [saving, setSaving] = useState(false)
    const [saveError, setSaveError] = useState<string | null>(null)
    const [lyricsError, setLyricsError] = useState<string | null>(null)
    // 未啟用 AI 歌詞整合或未設定金鑰時不顯示整理按鈕
    const aiLyricsAvailable = useIntegrationAvailable('ai_lyrics')
    const titleId = useId()
    // 排序標題由標題自動轉拼音，不手動編輯
    const titleSort = useAutoSort(String(tags.title || ''), String(initialTags?.title || ''), String(initialTags?.titlesort || ''))
    const albumId = useId()
    const albumSort = useAutoSort(String(tags.album || ''), String(initialTags?.album || ''), String(initialTags?.albumsort || ''))

    // 每個歌手欄位一個穩定的 setter，讓標籤元件可以用函式更新避免競態
    const artistSetters = useMemo(() => {
        const setters = {} as Record<ArtistRole, Dispatch<SetStateAction<ArtistChip[]>>>
        for (const role of ARTIST_ROLES) {
            setters[role] = update => setArtistChips(prev => ({
                ...prev,
                [role]: typeof update === 'function' ? update(prev[role]) : update,
            }))
        }
        return setters
    }, [])

    useEffect(() => {
        setTags(initialTags || {})
        setArtistChips(chipsFromTagDict(initialTags || {}))
    }, [initialTags])

    useEffect(() => {
        let cancelled = false
        fetchArtistDirectory()
            .then(directory => { if (!cancelled) setArtistDirectory(directory) })
            .catch(error => console.error('Failed to load artists:', error))
            .finally(() => { if (!cancelled) setDirectoryReady(true) })
        return () => { cancelled = true }
    }, [])

    useEffect(() => {
        // 載入語言清單和標籤清單
        const fetchLanguages = async () => {
            try {
                const response = await fetch('/api/tags/languages')
                if (response.ok) {
                    const data = await response.json()
                    setLanguages(data)
                }
            } catch (error) {
                console.error('Failed to load languages:', error)
            }
        }

        const fetchTags = async () => {
            try {
                const response = await fetch('/api/tags/tags')
                if (response.ok) {
                    const data = await response.json()
                    setAvailableTags(data)
                }
            } catch (error) {
                console.error('Failed to load tags:', error)
            }
        }

        fetchLanguages()
        fetchTags()
    }, [])

    const handleInputChange = (field: string, value: string | string[]) => {
        setTags((prev: Record<string, unknown>) => ({
            ...prev,
            [field]: value
        }))
    }

    const processLyrics = async () => {
        if (!tags.lyrics) return

        setLoading(true)
        setLyricsError(null)
        try {
            handleInputChange('lyrics', await cleanLyricsWithAI(String(tags.lyrics)))
        } catch (error) {
            setLyricsError(error instanceof Error ? error.message : 'AI 整理歌詞失敗，請重試')
        } finally {
            setLoading(false)
        }
    }

    const handleGenreToggle = (tag: string) => {
        const currentGenres = Array.isArray(tags.genre) ? tags.genre : []
        const isSelected = currentGenres.includes(tag)

        let newGenres: string[]
        if (isSelected) {
            newGenres = currentGenres.filter((genre: string) => genre !== tag)
        } else {
            newGenres = [...currentGenres, tag]
        }

        handleInputChange('genre', newGenres)
    }

    const handleSave = async () => {
        if (saving) return
        setSaving(true)
        setSaveError(null)
        try {
            // 由歌手標籤組出名字與排序欄位；尚未決定的排序名稱在這裡補齊
            const next: Record<string, unknown> = { ...tags, titlesort: await titleSort.resolve(), albumsort: await albumSort.resolve() }
            for (const role of ARTIST_ROLES) {
                const chips = await resolveChips(artistChips[role], artistDirectory)
                next[role] = joinNames(chips)
                next[SORT_FIELD[role]] = joinSorts(chips)
            }
            onSave(next)
        } catch (error) {
            setSaveError(error instanceof Error ? error.message : '儲存失敗，請重試')
        } finally {
            setSaving(false)
        }
    }

    return (
        <div className="space-y-6">
            <div className="text-sm text-gray-600">
                檔案路徑: {filePath}
            </div>

            {/* 基本資訊 */}
            <div className="space-y-4">
                <h3 className="text-lg font-semibold">基本資訊</h3>

                {/* 標題 */}
                <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor={titleId}>標題</label>
                    <Input
                        id={titleId}
                        value={String(tags.title || '')}
                        onChange={(e) => handleInputChange('title', e.target.value)}
                        placeholder="歌曲標題"
                        aria-describedby={`${titleId}-sort`}
                    />
                    <p id={`${titleId}-sort`} className="mt-1 text-xs text-gray-400" data-testid="title-sort-preview">
                        排序：{titleSort.sort ?? '…'}
                    </p>
                </div>

                <ArtistTagInput
                    label="歌手"
                    role="artist"
                    value={artistChips.artist}
                    onChange={artistSetters.artist}
                    directory={artistDirectory}
                    directoryReady={directoryReady}
                    disabled={saving}
                    labelClassName="block text-sm font-medium text-gray-700 mb-1"
                />

                {/* 專輯 */}
                <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor={albumId}>專輯</label>
                    <Input
                        id={albumId}
                        value={String(tags.album || '')}
                        onChange={(e) => handleInputChange('album', e.target.value)}
                        placeholder="專輯名稱"
                        aria-describedby={`${albumId}-sort`}
                    />
                    <p id={`${albumId}-sort`} className="mt-1 text-xs text-gray-400" data-testid="album-sort-preview">
                        排序：{albumSort.sort ?? '…'}
                    </p>
                </div>

                <ArtistTagInput
                    label="專輯歌手"
                    role="albumartist"
                    value={artistChips.albumartist}
                    onChange={artistSetters.albumartist}
                    directory={artistDirectory}
                    directoryReady={directoryReady}
                    disabled={saving}
                    labelClassName="block text-sm font-medium text-gray-700 mb-1"
                />

                <ArtistTagInput
                    label="作曲家"
                    role="composer"
                    value={artistChips.composer}
                    onChange={artistSetters.composer}
                    directory={artistDirectory}
                    directoryReady={directoryReady}
                    disabled={saving}
                    labelClassName="block text-sm font-medium text-gray-700 mb-1"
                />

                <ArtistTagInput
                    label="演奏者"
                    role="performer"
                    value={artistChips.performer}
                    onChange={artistSetters.performer}
                    directory={artistDirectory}
                    directoryReady={directoryReady}
                    disabled={saving}
                    labelClassName="block text-sm font-medium text-gray-700 mb-1"
                />

                {/* 軌道編號 */}
                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">軌道編號</label>
                        <Input
                            value={String(tags.tracknumber || '')}
                            onChange={(e) => handleInputChange('tracknumber', e.target.value)}
                            placeholder="01"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">總軌道數</label>
                        <Input
                            value={String(tags.tracktotal || '')}
                            onChange={(e) => handleInputChange('tracktotal', e.target.value)}
                            placeholder="12"
                        />
                    </div>
                </div>

                {/* 碟片編號 */}
                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">碟片編號</label>
                        <Input
                            value={String(tags.discnumber || '')}
                            onChange={(e) => handleInputChange('discnumber', e.target.value)}
                            placeholder="1"
                            type="number"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">碟片總數</label>
                        <Input
                            value={String(tags.disctotal || '')}
                            onChange={(e) => handleInputChange('disctotal', e.target.value)}
                            placeholder="2"
                            type="number"
                        />
                    </div>
                </div>
            </div>

            {/* 流派標籤 */}
            <div>
                <label className="block text-sm font-medium text-gray-700 mb-3">流派標籤</label>
                <div className="flex flex-wrap gap-2">
                    {availableTags.map((tag) => {
                        const currentGenres = Array.isArray(tags.genre) ? tags.genre : []
                        const isSelected = currentGenres.includes(tag)
                        return (
                            <button
                                key={tag}
                                type="button"
                                onClick={() => handleGenreToggle(tag)}
                                className={`px-3 py-1 rounded-full text-sm font-medium transition-colors ${isSelected
                                    ? 'bg-blue-600 text-white'
                                    : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                                    }`}
                            >
                                {tag}
                            </button>
                        )
                    })}
                </div>
            </div>

            {/* 語言 */}
            <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">語言</label>
                <Select
                    value={String(tags.language || '')}
                    onValueChange={(value) => handleInputChange('language', value)}
                >
                    <SelectTrigger className="w-full">
                        <SelectValue placeholder="請選擇語言" />
                    </SelectTrigger>
                    <SelectContent>
                        {Object.entries(languages).map(([code, name]) => (
                            <SelectItem key={code} value={code}>
                                {name}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>

            {/* 備註 */}
            <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">備註</label>
                <textarea
                    value={String(tags.comment || '')}
                    onChange={(e) => handleInputChange('comment', e.target.value)}
                    placeholder="輸入備註..."
                    rows={3}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 resize-vertical"
                />
            </div>

            {/* ReplayGain (自動生成，僅顯示) */}
            <div>
                <label className="block text-sm font-medium text-gray-700 mb-3">
                    ReplayGain <span className="text-xs text-gray-500">(已在上傳時自動生成)</span>
                </label>
                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <label className="block text-sm font-medium text-gray-500 mb-1">Track Gain</label>
                        <Input
                            value={String(tags.replaygain_track_gain || '')}
                            readOnly
                            placeholder="未設定"
                            className="bg-gray-50"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-500 mb-1">Track Peak</label>
                        <Input
                            value={String(tags.replaygain_track_peak || '')}
                            readOnly
                            placeholder="未設定"
                            className="bg-gray-50"
                        />
                    </div>
                </div>
            </div>

            {/* 歌詞 */}
            <div>
                <div className="flex items-center justify-between mb-1">
                    <label className="block text-sm font-medium text-gray-700">歌詞</label>
                    {aiLyricsAvailable && (
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={processLyrics}
                            disabled={loading || !tags.lyrics}
                            className="text-xs"
                            aria-label="AI 整理歌詞"
                        >
                            <Sparkles className='size-4' />
                            {loading ? '處理中...' : ''}
                        </Button>
                    )}
                </div>
                {lyricsError && <p role="alert" className="text-sm text-red-600">{lyricsError}</p>}
                <textarea
                    value={String(tags.lyrics || '')}
                    onChange={(e) => handleInputChange('lyrics', e.target.value)}
                    placeholder="輸入歌詞..."
                    rows={8}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 resize-vertical"
                />
            </div>

            {/* 按鈕 */}
            {saveError && <p role="alert" className="text-sm text-red-600 text-right">{saveError}</p>}
            <div className="flex space-x-4 justify-end">
                <Button onClick={handleSave} disabled={saving} className="flex items-center gap-2">
                    <Save className="h-4 w-4" />
                    {saving ? '儲存中...' : '儲存標籤'}
                </Button>
                <Button onClick={onCancel} variant="outline" className="flex items-center gap-2">
                    <X className="h-4 w-4" />
                    取消
                </Button>
            </div>
        </div>
    )
}