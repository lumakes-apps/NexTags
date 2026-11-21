'use client';

import { useState, useEffect, useId } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose, DialogFooter } from '@/components/ui/dialog';
import { NativeSelect } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { Save } from 'lucide-react';

/** 2～3 個互斥選項：直接列出的單選按鈕，比收在下拉選單裡好選 */
function RadioChoices<T extends string>({ legend, name, value, options, onChange }: {
    legend: string;
    name: string;
    value: T;
    options: [T, string][];
    onChange: (value: T) => void;
}) {
    return (
        <fieldset>
            <legend className="text-sm font-medium text-gray-700 mb-2">{legend}</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
                {options.map(([optionValue, label]) => (
                    <label key={optionValue} className="flex items-center gap-2 text-sm text-gray-800">
                        <input type="radio" name={name} value={optionValue} checked={value === optionValue}
                            onChange={() => onChange(optionValue)} className="size-4 accent-gray-900" />
                        {label}
                    </label>
                ))}
            </div>
        </fieldset>
    );
}

interface SmartPlaylist {
    name: string;
    base_folder: string;
    filter_tags: string[];
    exclude_tags: string[];
    filter_language: string[];
    exclude_language: string[];
    filter_favorites: boolean | null;
    sort_method: string;
    is_system_level: boolean;
    filter_tags_display: string[];
    exclude_tags_display: string[];
    filter_language_display: string[];
    exclude_language_display: string[];
    filter_favorites_display: string;
    sort_method_display: string;
}

interface PlaylistEditDialogProps {
    playlist: SmartPlaylist | null;
    playlistId: number | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSave: (id: number | null, updatedPlaylist: Partial<SmartPlaylist>) => void;
    isCreate?: boolean;
}

export default function PlaylistEditDialog({
    playlist,
    playlistId,
    open,
    onOpenChange,
    onSave,
    isCreate = false
}: PlaylistEditDialogProps) {
    // 欄位 id 前綴（標籤以 htmlFor 對應欄位）
    const fid = useId();
    const [editedPlaylist, setEditedPlaylist] = useState<Partial<SmartPlaylist>>({});
    const [loading, setLoading] = useState(false);
    const [languages, setLanguages] = useState<Record<string, string>>({});
    const [availableTags, setAvailableTags] = useState<string[]>([]);
    const [baseFolders, setBaseFolders] = useState<string[]>([]);

    useEffect(() => {
        if (open) {
            if (playlist) {
                // 編輯模式
                setEditedPlaylist({
                    name: playlist.name,
                    base_folder: playlist.base_folder,
                    filter_tags: [...(playlist.filter_tags || [])],
                    exclude_tags: [...(playlist.exclude_tags || [])],
                    filter_language: [...(playlist.filter_language || [])],
                    exclude_language: [...(playlist.exclude_language || [])],
                    filter_favorites: playlist.filter_favorites,
                    sort_method: playlist.sort_method || 'creation_time',
                    is_system_level: playlist.is_system_level ?? false
                });
            } else {
                // 新增模式
                setEditedPlaylist({
                    name: '',
                    base_folder: '',
                    filter_tags: [],
                    exclude_tags: [],
                    filter_language: [],
                    exclude_language: [],
                    filter_favorites: null,
                    sort_method: 'creation_time',
                    is_system_level: false
                });
            }
        }
    }, [playlist, open, isCreate]);

    useEffect(() => {
        if (open) {
            // 載入語言清單和標籤清單
            const fetchData = async () => {
                try {
                    // 載入語言清單
                    const languagesResponse = await fetch('/api/tags/languages');
                    if (languagesResponse.ok) {
                        const languagesData = await languagesResponse.json();
                        setLanguages(languagesData);
                    }

                    // 載入標籤清單
                    const tagsResponse = await fetch('/api/tags/tags');
                    if (tagsResponse.ok) {
                        const tagsData = await tagsResponse.json();
                        setAvailableTags(tagsData);
                    }

                    // 載入基礎資料夾清單
                    const baseFoldersResponse = await fetch('/api/tags/baseFolders');
                    if (baseFoldersResponse.ok) {
                        const baseFoldersData = await baseFoldersResponse.json();
                        setBaseFolders(baseFoldersData.base_folders || []);
                    }

                } catch (error) {
                    console.error('Failed to load data:', error);
                }
            };

            fetchData();
        }
    }, [open]);

    const handleInputChange = (field: keyof SmartPlaylist, value: string | string[] | boolean | null) => {
        setEditedPlaylist(prev => ({ ...prev, [field]: value }));
    };

    const handleTagToggle = (tag: string) => {
        const currentTags = editedPlaylist.filter_tags || [];
        const isSelected = currentTags.includes(tag);

        let newTags: string[];
        if (isSelected) {
            newTags = currentTags.filter(t => t !== tag);
        } else {
            newTags = [...currentTags, tag];
        }

        handleInputChange('filter_tags', newTags);
    };

    const handleLanguageToggle = (code: string) => {
        const current = editedPlaylist.filter_language || [];
        const isSelected = current.includes(code);
        const updated = isSelected ? current.filter(c => c !== code) : [...current, code];
        handleInputChange('filter_language', updated);
    };

    const handleExcludeLanguageToggle = (code: string) => {
        const current = editedPlaylist.exclude_language || [];
        const isSelected = current.includes(code);
        const updated = isSelected ? current.filter(c => c !== code) : [...current, code];
        handleInputChange('exclude_language', updated);
    };

    const handleExcludeTagToggle = (tag: string) => {
        const currentTags = editedPlaylist.exclude_tags || [];
        const isSelected = currentTags.includes(tag);

        let newTags: string[];
        if (isSelected) {
            newTags = currentTags.filter(t => t !== tag);
        } else {
            newTags = [...currentTags, tag];
        }

        handleInputChange('exclude_tags', newTags);
    };

    const handleSave = async () => {
        // 驗證必填欄位
        if (!editedPlaylist.name || !editedPlaylist.base_folder) {
            return;
        }

        setLoading(true);
        try {
            onSave(playlistId, editedPlaylist);
            onOpenChange(false);
        } catch (error) {
            console.error('Failed to save playlist:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleClose = () => {
        onOpenChange(false);
        setEditedPlaylist({});
    };

    // 移除這個限制，因為新增模式時 playlist 是 null

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl">
                <DialogHeader className='p-2 pb-0'>
                    <DialogTitle>{isCreate ? '新增播放清單' : '播放清單編輯'}</DialogTitle>
                    <DialogClose onClose={handleClose} />
                </DialogHeader>

                <div className="space-y-4 max-h-[60vh] overflow-y-auto px-2">
                    {/* 播放清單名稱 */}
                    <div>
                        <label className="text-sm font-medium text-gray-700 block mb-2" htmlFor={`${fid}-name`}>Title</label>
                        <Input
                            id={`${fid}-name`}
                            value={editedPlaylist.name || ''}
                            onChange={(e) => handleInputChange('name', e.target.value)}
                            placeholder="播放清單名稱"
                        />
                    </div>


                    {/* BaseFolder */}
                    <div>
                        <label className="text-sm font-medium text-gray-700 block mb-2" htmlFor={`${fid}-base-folder`}>BaseFolder</label>
                        <NativeSelect
                            id={`${fid}-base-folder`}
                            value={editedPlaylist.base_folder || ''}
                            onChange={(e) => handleInputChange('base_folder', e.target.value)}
                        >
                            {!editedPlaylist.base_folder && <option value="" disabled>選擇基礎資料夾</option>}
                            {baseFolders.map((folder) => (
                                <option key={folder} value={folder}>{folder}</option>
                            ))}
                        </NativeSelect>
                    </div>

                    {/* Tags / Genre (標籤) */}
                    <div>
                        <p id={`${fid}-tags`} className="text-sm font-medium text-gray-700 mb-3">Tags / Genre (標籤)</p>
                        <div role="group" aria-labelledby={`${fid}-tags`} className="flex flex-wrap gap-2">
                            {availableTags
                                .filter(tag => !editedPlaylist.exclude_tags?.includes(tag))
                                .map((tag) => {
                                    const isSelected = editedPlaylist.filter_tags?.includes(tag) || false;
                                    return (
                                        <button
                                            key={tag}
                                            type="button"
                                            onClick={() => handleTagToggle(tag)}
                                            aria-pressed={isSelected}
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
                        {availableTags.filter(tag => !editedPlaylist.exclude_tags?.includes(tag)).length === 0 && (
                            <p className="text-sm text-gray-500 mt-2">所有標籤都已在「Exclude Tags」中被選擇</p>
                        )}
                    </div>

                    {/* Exclude Tags (排除標籤) */}
                    <div>
                        <p id={`${fid}-exclude-tags`} className="text-sm font-medium text-gray-700 mb-3">Exclude Tags (排除標籤)</p>
                        <div role="group" aria-labelledby={`${fid}-exclude-tags`} className="flex flex-wrap gap-2">
                            {availableTags
                                .filter(tag => !editedPlaylist.filter_tags?.includes(tag))
                                .map((tag) => {
                                    const isSelected = editedPlaylist.exclude_tags?.includes(tag) || false;
                                    return (
                                        <button
                                            key={tag}
                                            type="button"
                                            onClick={() => handleExcludeTagToggle(tag)}
                                            aria-pressed={isSelected}
                                            className={`px-3 py-1 rounded-full text-sm font-medium transition-colors ${isSelected
                                                ? 'bg-red-600 text-white'
                                                : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                                                }`}
                                        >
                                            {tag}
                                        </button>
                                    );
                                })}
                        </div>
                        {availableTags.filter(tag => !editedPlaylist.filter_tags?.includes(tag)).length === 0 && (
                            <p className="text-sm text-gray-500 mt-2">所有標籤都已在「Tags / Genre」中被選擇</p>
                        )}
                    </div>

                    {/* Language (語言) */}
                    <div>
                        <p id={`${fid}-language`} className="text-sm font-medium text-gray-700 mb-3">Language (語言)</p>
                        <div role="group" aria-labelledby={`${fid}-language`} className="flex flex-wrap gap-2">
                            {Object.entries(languages)
                                .filter(([code]) => !editedPlaylist.exclude_language?.includes(code))
                                .map(([code, name]) => {
                                    const isSelected = editedPlaylist.filter_language?.includes(code) || false;
                                    return (
                                        <button
                                            key={code}
                                            type="button"
                                            onClick={() => handleLanguageToggle(code)}
                                            aria-pressed={isSelected}
                                            className={`px-3 py-1 rounded-full text-sm font-medium transition-colors ${isSelected
                                                ? 'bg-green-700 text-white'
                                                : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                                                }`}
                                        >
                                            {name}
                                        </button>
                                    );
                                })}
                        </div>
                        {Object.keys(languages).filter(code => !editedPlaylist.exclude_language?.includes(code)).length === 0 && (
                            <p className="text-sm text-gray-500 mt-2">所有語言都已在「Exclude Language」中被選擇</p>
                        )}
                    </div>

                    {/* Exclude Language (排除語言) */}
                    <div>
                        <p id={`${fid}-exclude-language`} className="text-sm font-medium text-gray-700 mb-3">Exclude Language (排除語言)</p>
                        <div role="group" aria-labelledby={`${fid}-exclude-language`} className="flex flex-wrap gap-2">
                            {Object.entries(languages)
                                .filter(([code]) => !editedPlaylist.filter_language?.includes(code))
                                .map(([code, name]) => {
                                    const isSelected = editedPlaylist.exclude_language?.includes(code) || false;
                                    return (
                                        <button
                                            key={code}
                                            type="button"
                                            onClick={() => handleExcludeLanguageToggle(code)}
                                            aria-pressed={isSelected}
                                            className={`px-3 py-1 rounded-full text-sm font-medium transition-colors ${isSelected
                                                ? 'bg-red-600 text-white'
                                                : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                                                }`}
                                        >
                                            {name}
                                        </button>
                                    );
                                })}
                        </div>
                        {Object.keys(languages).filter(code => !editedPlaylist.filter_language?.includes(code)).length === 0 && (
                            <p className="text-sm text-gray-500 mt-2">所有語言都已在「Language」中被選擇</p>
                        )}
                    </div>

                    {/* Favorites */}
                    <RadioChoices
                        legend="Favorites"
                        name={`${fid}-favorites`}
                        value={editedPlaylist.filter_favorites === null || editedPlaylist.filter_favorites === undefined ? 'NONE' : String(editedPlaylist.filter_favorites) as 'true' | 'false'}
                        options={[['NONE', '不設定'], ['true', '是'], ['false', '否']]}
                        onChange={(value) => handleInputChange('filter_favorites', value === 'NONE' ? null : value === 'true')}
                    />

                    {/* Sort Method */}
                    <RadioChoices
                        legend="Sort Method (排序方式)"
                        name={`${fid}-sort`}
                        value={editedPlaylist.sort_method || 'creation_time'}
                        options={[['creation_time', '加入時間 (Date Added)'], ['title', '標題 (TitleSort)']]}
                        onChange={(value) => handleInputChange('sort_method', value)}
                    />

                    {/* System Level Playlist */}
                    <div className="flex flex-col gap-2 pb-4">
                        <label className="text-sm font-medium text-gray-700" htmlFor={`${fid}-system`}>系統等級播放清單</label>
                        {/* 說明直接顯示（原本的 Tooltip 會被原生 dialog 擋住，觸控裝置也無法 hover） */}
                        <p id={`${fid}-system-help`} className="text-xs text-gray-500">
                            開啟：存入 /Music/Playlist；關閉：存入 /Music/{editedPlaylist.base_folder || '音樂資料夾'}/Playlist
                        </p>
                        <Switch
                            id={`${fid}-system`}
                            aria-describedby={`${fid}-system-help`}
                            checked={editedPlaylist.is_system_level ?? false}
                            onCheckedChange={(checked) => handleInputChange('is_system_level', checked)}
                        />
                    </div>
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={handleClose} disabled={loading} className='flex-1'>
                        取消
                    </Button>
                    <Button onClick={handleSave} disabled={loading} className="flex-1 flex items-center gap-2">
                        <Save className="w-4 h-4" />
                        {loading ? '儲存中...' : 'Save'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}