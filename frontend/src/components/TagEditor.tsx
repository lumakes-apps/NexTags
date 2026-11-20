import { useState, useEffect, useRef, useMemo, useId } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import ArtistTagInput from '@/components/ArtistTagInput';
import { useAutoSort } from '@/lib/useAutoSort';
import {
  chipsFromTags,
  fetchArtistDirectory,
  joinNames,
  joinSorts,
  resolveChips,
  type ArtistChip,
  type ArtistDirectory,
  type ArtistRole,
} from '@/lib/artists';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { X, Save, Upload, Image as ImageIcon, Sparkles, AudioLines } from 'lucide-react';

interface Song {
  Title: string;
  Artist: string;
  Album: string;
  AlbumArtist?: string;
  Composer?: string;
  Performer?: string;
  MainFolder: string;
  FilePath: string;
  Genre: string[];
  Language: string;
  Favorite: string;
  Cover: string;
  SortTitle?: string;
  SortArtist?: string;
  SortAlbum?: string;
  SortAlbumArtist?: string;
  SortComposer?: string;
  SortPerformer?: string;
  TrackNumber?: string;
  TrackTotal?: string;
  DiscNumber?: string;
  DiscTotal?: string;
  Lyrics?: string;
  Comment?: string;
  ReplayGainTrackGain?: string;
  ReplayGainTrackPeak?: string;
}

// 歌手標籤欄位與 Song 欄位的對應
const ARTIST_FIELDS: { role: ArtistRole; name: keyof Song; sort: keyof Song }[] = [
  { role: 'artist', name: 'Artist', sort: 'SortArtist' },
  { role: 'albumartist', name: 'AlbumArtist', sort: 'SortAlbumArtist' },
  { role: 'composer', name: 'Composer', sort: 'SortComposer' },
  { role: 'performer', name: 'Performer', sort: 'SortPerformer' },
];

const EMPTY_CHIPS: Record<ArtistRole, ArtistChip[]> = { artist: [], albumartist: [], composer: [], performer: [] };

interface TagEditorProps {
  song: Song | null;
  onClose: () => void;
  onSave: (song: Song) => Promise<void>;
}

export default function TagEditor({ song, onClose, onSave }: TagEditorProps) {
  const [editedSong, setEditedSong] = useState<Song | null>(null);
  const [loading, setLoading] = useState(false);
  const [languages, setLanguages] = useState<Record<string, string>>({});
  const [availableTags, setAvailableTags] = useState<string[]>([]);
  const [coverImage, setCoverImage] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isReadingCover, setIsReadingCover] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [generatingReplayGain, setGeneratingReplayGain] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [artistChips, setArtistChips] = useState<Record<ArtistRole, ArtistChip[]>>(EMPTY_CHIPS);
  const [artistDirectory, setArtistDirectory] = useState<ArtistDirectory | null>(null);
  const [directoryReady, setDirectoryReady] = useState(false);
  const titleId = useId();
  // 排序標題由標題自動轉拼音，不手動編輯
  const titleSort = useAutoSort(editedSong?.Title ?? '', song?.Title ?? '', song?.SortTitle ?? '');
  const albumId = useId();
  const albumSort = useAutoSort(editedSong?.Album ?? '', song?.Album ?? '', song?.SortAlbum ?? '');

  // 每個歌手欄位一個穩定的 setter，讓標籤元件可以用函式更新避免競態
  const artistSetters = useMemo(() => {
    const setters = {} as Record<ArtistRole, Dispatch<SetStateAction<ArtistChip[]>>>;
    for (const { role } of ARTIST_FIELDS) {
      setters[role] = update => setArtistChips(prev => ({
        ...prev,
        [role]: typeof update === 'function' ? update(prev[role]) : update,
      }));
    }
    return setters;
  }, []);

  useEffect(() => {
    if (song) {
      setSaveError(null);
      setEditedSong({
        ...song,
        AlbumArtist: song.AlbumArtist || '',
        Composer: song.Composer || '',
        Performer: song.Performer || '',
        SortTitle: song.SortTitle || '',
        SortArtist: song.SortArtist || '',
        SortAlbum: song.SortAlbum || '',
        SortAlbumArtist: song.SortAlbumArtist || '',
        SortComposer: song.SortComposer || '',
        SortPerformer: song.SortPerformer || '',
        TrackNumber: song.TrackNumber || '',
        TrackTotal: song.TrackTotal || '',
        DiscNumber: song.DiscNumber || '',
        DiscTotal: song.DiscTotal || '',
        Lyrics: song.Lyrics || '',
        Comment: song.Comment || '',
        ReplayGainTrackGain: song.ReplayGainTrackGain || '',
        ReplayGainTrackPeak: song.ReplayGainTrackPeak || '',
      });
      const chips = { ...EMPTY_CHIPS };
      for (const field of ARTIST_FIELDS) chips[field.role] = chipsFromTags(song[field.name], song[field.sort]);
      setArtistChips(chips);
      // 設置封面圖片 - 使用 API 端點
      if (song.Cover) {
        const imageUrl = `/api/images/cover?path=${encodeURIComponent(song.Cover)}&v=${Date.now()}`;
        setCoverImage(imageUrl);
      } else {
        setCoverImage(null);
      }
    }
  }, [song]);

  // 每次開啟編輯器時重新載入歌手清單，確保包含最新存檔的名字
  useEffect(() => {
    if (!song) return;
    let cancelled = false;
    setDirectoryReady(false);
    fetchArtistDirectory()
      .then(directory => { if (!cancelled) setArtistDirectory(directory); })
      .catch(error => {
        console.error('Failed to load artists:', error);
        if (!cancelled) setArtistDirectory(null);
      })
      .finally(() => { if (!cancelled) setDirectoryReady(true); });
    return () => { cancelled = true; };
  }, [song]);

  useEffect(() => {
    // 載入語言清單和標籤清單
    const fetchLanguages = async () => {
      try {
        const response = await fetch('/api/tags/languages');
        if (response.ok) {
          const data = await response.json();
          setLanguages(data);
        }
      } catch (error) {
        console.error('Failed to load languages:', error);
      }
    };

    const fetchTags = async () => {
      try {
        const response = await fetch('/api/tags/tags');
        if (response.ok) {
          const data = await response.json();
          setAvailableTags(data);
        }
      } catch (error) {
        console.error('Failed to load tags:', error);
      }
    };

    fetchLanguages();
    fetchTags();
  }, []);

  if (!song || !editedSong) return null;

  const handleInputChange = (field: keyof Song, value: string | string[]) => {
    setEditedSong(prev => prev ? { ...prev, [field]: value } : null);
  };

  const handleImageClick = () => {
    if (isSaving) return;
    fileInputRef.current?.click();
  };

  const selectCoverImage = (file: File) => {
    if (isSaving || isReadingCover) return;
    if (!['image/jpeg', 'image/png'].includes(file.type) || file.size > 10 * 1024 * 1024) {
      setSaveError('請選擇 10 MB 以下的 JPEG 或 PNG 封面');
      return;
    }
    setSaveError(null);
    setIsReadingCover(true);
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      setCoverImage(result);
      handleInputChange('Cover', result);
      setIsReadingCover(false);
    };
    reader.onerror = () => {
      setSaveError('無法讀取圖片，請重新選擇');
      setIsReadingCover(false);
    };
    reader.readAsDataURL(file);
  };

  const handleImageChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) selectCoverImage(file);
    event.target.value = '';
  };

  const handleDragOver = (event: React.DragEvent) => {
    event.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (event: React.DragEvent) => {
    event.preventDefault();
    setIsDragOver(false);
  };

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setIsDragOver(false);

    const files = event.dataTransfer.files;
    const file = files[0];

    if (file) selectCoverImage(file);
  };

  const removeCoverImage = () => {
    setCoverImage(song.Cover ? `/api/images/cover?path=${encodeURIComponent(song.Cover)}&v=${Date.now()}` : null);
    handleInputChange('Cover', song.Cover);
  };

  const processLyrics = async () => {
    if (!editedSong?.Lyrics) return;

    setLoading(true);
    try {
      const response = await fetch('/api/tools/lyric', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lyric: editedSong.Lyrics })
      });

      const data = await response.json();

      if (response.ok && data.result) {
        handleInputChange('Lyrics', data.result);
      }
    } catch (error) {
      console.error('Lyric processing failed:', error);
    } finally {
      setLoading(false);
    }
  };

  const generateReplayGain = async () => {
    if (!editedSong?.FilePath) return;

    setGeneratingReplayGain(true);
    try {
      const response = await fetch('/api/audios/replaygain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: editedSong.FilePath })
      });

      const data = await response.json();

      if (response.ok && data.success) {
        // 重新讀取檔案標籤以自動刷新 ReplayGain 值
        const tagsResponse = await fetch('/api/audios/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: editedSong.FilePath })
        });

        if (tagsResponse.ok) {
          const tagsData = await tagsResponse.json();
          if (tagsData.tags) {
            handleInputChange('ReplayGainTrackGain', tagsData.tags.replaygain_track_gain || '');
            handleInputChange('ReplayGainTrackPeak', tagsData.tags.replaygain_track_peak || '');
          }
        }
      } else {
        alert(`ReplayGain 生成失敗: ${data.message || '未知錯誤'}`);
      }
    } catch (error) {
      console.error('ReplayGain generation failed:', error);
      alert('生成 ReplayGain 時發生錯誤');
    } finally {
      setGeneratingReplayGain(false);
    }
  };

  const handleTagToggle = (tag: string) => {
    if (!editedSong) return;

    const currentGenres = editedSong.Genre || [];
    const isSelected = currentGenres.includes(tag);

    let newGenres: string[];
    if (isSelected) {
      // 移除標籤
      newGenres = currentGenres.filter(genre => genre !== tag);
    } else {
      // 添加標籤
      newGenres = [...currentGenres, tag];
    }

    handleInputChange('Genre', newGenres);
  };

  const handleSave = async () => {
    if (!editedSong || isSaving || isReadingCover) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      // 由歌手標籤組出名字與排序欄位；尚未決定的排序名稱在這裡補齊
      const song = { ...editedSong, SortTitle: await titleSort.resolve(), SortAlbum: await albumSort.resolve() };
      for (const field of ARTIST_FIELDS) {
        const chips = await resolveChips(artistChips[field.role], artistDirectory);
        (song[field.name] as string) = joinNames(chips);
        (song[field.sort] as string) = joinSorts(chips);
      }
      await onSave(song);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : '儲存失敗，請重試');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end backdrop-blur-md"
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.3)' }}
    >
      <div className="bg-white w-128 h-full shadow-xl flex flex-col">
        <div className="flex items-center justify-between p-4 border-b bg-white">
          <h2 className="text-lg font-semibold">編輯標籤</h2>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={isSaving} aria-label="關閉標籤編輯器">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-gray-50">
          <div className="border p-4 rounded-xl bg-white">
            <h3 className="font-medium text-gray-900 mb-3">Path</h3>
            <label className="text-sm text-gray-500 block mb-1">{editedSong.FilePath}</label>
          </div>
          <div className="border p-4 rounded-xl bg-white gap-2">
            <div
              className={`aspect-square max-w-[240px] shadow-lg mx-auto rounded-2xl cursor-pointer transition-all duration-200 ${isDragOver
                ? 'border-2 border-dashed border-blue-400 bg-blue-50'
                : 'bg-gray-500 hover:bg-gray-400'
                }`}
              onClick={handleImageClick}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              {coverImage ? (
                <div className="relative w-full h-full">
                  <img
                    src={coverImage}
                    alt="Album Cover"
                    className="w-full h-full object-cover rounded-2xl"
                  />
                  {editedSong.Cover.startsWith('data:') && <button
                    aria-label="取消更換封面"
                    disabled={isSaving || isReadingCover}
                    onClick={(e) => {
                      e.stopPropagation();
                      removeCoverImage();
                    }}
                    className="absolute top-2 right-2 bg-gray-500 hover:bg-red-600 text-white rounded-full w-6 h-6 flex items-center justify-center transition-colors"
                  >
                    <X className="h-3 w-3" />
                  </button>}
                </div>
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center text-white">
                  {isDragOver ? (
                    <>
                      <Upload className="h-12 w-12 mb-2" />
                      <span className="text-sm font-medium text-blue-600">拖放圖片到此處</span>
                    </>
                  ) : (
                    <>
                      <ImageIcon className="h-12 w-12 mb-2" />
                      <span className="text-sm font-medium">點擊上傳封面</span>
                    </>
                  )}
                </div>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png"
              disabled={isSaving || isReadingCover}
              onChange={handleImageChange}
              className="hidden"
            />
            <label className="text-xs text-center text-gray-500 block mt-2">
              {coverImage ? '點擊更換圖片或拖放新圖片' : '點擊圖片上傳或拖放圖片'}
            </label>
            {editedSong.Cover.startsWith('data:') && <p role="status" className="text-sm text-center mt-2">封面尚未儲存，請點擊「保存變更」</p>}
          </div>
          <div className="border p-4 rounded-xl bg-white grid gap-4">
            <div>
              <label className="text-gray-500 block mb-1" htmlFor={titleId}>Title</label>
              <Input
                id={titleId}
                value={editedSong.Title}
                onChange={(e) => handleInputChange('Title', e.target.value)}
                placeholder="歌曲標題"
                aria-describedby={`${titleId}-sort`}
              />
              <p id={`${titleId}-sort`} className="mt-1 text-xs text-gray-400" data-testid="title-sort-preview">
                排序：{titleSort.sort ?? '…'}
              </p>
            </div>
            <ArtistTagInput
              label="Artist"
              role="artist"
              value={artistChips.artist}
              onChange={artistSetters.artist}
              directory={artistDirectory}
              directoryReady={directoryReady}
              disabled={isSaving}
            />
            <div>
              <label className="text-gray-500 block mb-1" htmlFor={albumId}>Album</label>
              <Input
                id={albumId}
                value={editedSong.Album}
                onChange={(e) => handleInputChange('Album', e.target.value)}
                placeholder="專輯名稱"
                aria-describedby={`${albumId}-sort`}
              />
              <p id={`${albumId}-sort`} className="mt-1 text-xs text-gray-400" data-testid="album-sort-preview">
                排序：{albumSort.sort ?? '…'}
              </p>
            </div>
            <ArtistTagInput
              label="AlbumArtist"
              role="albumartist"
              value={artistChips.albumartist}
              onChange={artistSetters.albumartist}
              directory={artistDirectory}
              directoryReady={directoryReady}
              disabled={isSaving}
            />
            <ArtistTagInput
              label="Composer"
              role="composer"
              value={artistChips.composer}
              onChange={artistSetters.composer}
              directory={artistDirectory}
              directoryReady={directoryReady}
              disabled={isSaving}
            />
            <ArtistTagInput
              label="Performer"
              role="performer"
              value={artistChips.performer}
              onChange={artistSetters.performer}
              directory={artistDirectory}
              directoryReady={directoryReady}
              disabled={isSaving}
            />
            <div className="grid grid-cols-2 gap-4 bg-white rounded-lg">
              <div>
                <label className="text-gray-500 block mb-1">Track Number</label>
                <Input
                  value={editedSong.TrackNumber || ''}
                  onChange={(e) => handleInputChange('TrackNumber', e.target.value)}
                  placeholder="曲目編號"
                  type="number"
                />
              </div>
              <div>
                <label className="text-gray-500 block mb-1">Track Total</label>
                <Input
                  value={editedSong.TrackTotal || ''}
                  onChange={(e) => handleInputChange('TrackTotal', e.target.value)}
                  placeholder="曲目總數"
                  type="number"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4 bg-white rounded-lg">
              <div>
                <label className="text-gray-500 block mb-1">Disc Number</label>
                <Input
                  value={editedSong.DiscNumber || ''}
                  onChange={(e) => handleInputChange('DiscNumber', e.target.value)}
                  placeholder="碟片編號"
                  type="number"
                />
              </div>
              <div>
                <label className="text-gray-500 block mb-1">Disc Total</label>
                <Input
                  value={editedSong.DiscTotal || ''}
                  onChange={(e) => handleInputChange('DiscTotal', e.target.value)}
                  placeholder="碟片總數"
                  type="number"
                />
              </div>
            </div>
            <div>
              <label className="text-gray-500 block mb-3">Genre</label>
              <div className="flex flex-wrap gap-2">
                {availableTags.map((tag) => {
                  const isSelected = editedSong.Genre?.includes(tag) || false;
                  return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => handleTagToggle(tag)}
                      className={`px-3 py-1 rounded-full text-sm font-medium transition-colors ${isSelected
                        ? 'bg-gray-800 text-white'
                        : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                        }`}
                    >
                      {tag}
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <label className="text-gray-500 block mb-1">Language</label>
              <Select
                value={editedSong.Language}
                onValueChange={(value) => handleInputChange('Language', value)}
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
            <div>
              <label className="text-gray-500 block mb-3">Favorite</label>
              <div className="flex items-center space-x-2">
                <Switch
                  checked={editedSong.Favorite === 'True'}
                  onCheckedChange={(checked) => handleInputChange('Favorite', checked ? 'True' : 'False')}
                />
                <span className="text-sm text-gray-600">
                  {editedSong.Favorite === 'True' ? '是' : '否'}
                </span>
              </div>
            </div>
            <div>
              <label className="text-gray-500 block mb-1">備註 (Comment)</label>
              <textarea
                value={editedSong.Comment || ''}
                onChange={(e) => handleInputChange('Comment', e.target.value)}
                placeholder="輸入備註或評論..."
                rows={2}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 resize-vertical"
              />
            </div>
          </div>
          {/* ReplayGain Section */}
          <div className="bg-white rounded-lg border p-4 space-y-3">
            <div className="flex items-center justify-between mb-3">
              <label className="text-gray-700 font-medium">ReplayGain</label>
              <Button
                variant="clear"
                size="sm"
                onClick={generateReplayGain}
                disabled={generatingReplayGain}
                className="text-xs rounded-full"
              >
                <AudioLines className="h-4 w-4" />
                {generatingReplayGain ? '生成中...' : '計算 ReplayGain'}
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-gray-500 text-sm block mb-1">Track Gain</label>
                <Input
                  value={editedSong.ReplayGainTrackGain || ''}
                  readOnly
                  placeholder="未設定"
                  className="bg-gray-50"
                />
              </div>
              <div>
                <label className="text-gray-500 text-sm block mb-1">Track Peak</label>
                <Input
                  value={editedSong.ReplayGainTrackPeak || ''}
                  readOnly
                  placeholder="未設定"
                  className="bg-gray-50"
                />
              </div>
            </div>
          </div>
          {/* Other Fields */}
          <div className="bg-white rounded-lg border p-4 space-y-3">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-gray-500">歌詞 (Lyrics)</label>
                <Button
                  variant="clear"
                  size="sm"
                  onClick={processLyrics}
                  disabled={loading || !editedSong.Lyrics}
                  className="text-xs rounded-full"
                >
                  <Sparkles className='size-4' />
                  {loading ? '處理中...' : ''}
                </Button>
              </div>
              <textarea
                value={editedSong.Lyrics || ''}
                onChange={(e) => handleInputChange('Lyrics', e.target.value)}
                placeholder="輸入歌詞..."
                rows={12}
                className="w-full px-3 py-2 mt-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 resize-vertical"
              />
            </div>
          </div>
        </div>

        <div className="p-4 border-t bg-white">
          {saveError && <p role="alert" className="text-sm text-red-600 mb-2">{saveError}</p>}
          <Button onClick={handleSave} disabled={isSaving || isReadingCover} className="w-full flex items-center gap-2">
            <Save className="h-4 w-4" />
            {isSaving ? '儲存中...' : '保存變更'}
          </Button>
        </div>
      </div>
    </div>
  );
}
