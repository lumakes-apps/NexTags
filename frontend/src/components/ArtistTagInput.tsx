import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { Dispatch, KeyboardEvent, SetStateAction } from 'react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, X } from 'lucide-react'
import {
  makeChip,
  resolveSort,
  splitNames,
  suggestArtists,
  type ArtistChip,
  type ArtistDirectory,
  type ArtistEntry,
  type ArtistRole,
} from '@/lib/artists'

interface ArtistTagInputProps {
  label: string
  role: ArtistRole
  value: ArtistChip[]
  onChange: Dispatch<SetStateAction<ArtistChip[]>>
  /** 音樂庫歌手清單；尚未載入或載入失敗時為 null */
  directory: ArtistDirectory | null
  /** 清單已載入完成（或確定失敗），可以開始決定排序名稱 */
  directoryReady: boolean
  disabled?: boolean
  placeholder?: string
  /** 讓標籤文字與所在編輯器的其他欄位一致 */
  labelClassName?: string
}

type Option = { kind: 'create'; name: string } | { kind: 'existing'; entry: ArtistEntry }

// 系統開啟「減少動態效果」時，拖曳排序不播放移動動畫
function usePrefersReducedMotion() {
  const query = '(prefers-reduced-motion: reduce)'
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)
  useEffect(() => {
    const media = window.matchMedia(query)
    const update = () => setReduced(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  return reduced
}

function Chip({ chip, fieldLabel, isNew, disabled, reducedMotion, onRemove }: {
  chip: ArtistChip
  /** 所屬欄位名稱；同一位歌手可能同時出現在多個欄位，按鈕名稱需帶欄位才能區分 */
  fieldLabel: string
  isNew: boolean | null
  disabled?: boolean
  reducedMotion: boolean
  onRemove: () => void
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: chip.id,
    disabled,
    transition: reducedMotion ? null : undefined,
  })
  const tone = isNew
    ? 'bg-green-50 text-green-800 border-green-300'
    : 'bg-gray-100 text-gray-800 border-gray-300'
  return (
    <span
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`relative inline-flex items-center rounded-full border px-0.5 text-sm ${tone} ${isDragging ? 'z-10 opacity-80 shadow-md' : ''} has-[[data-drag-handle]:focus-visible]:ring-2 has-[[data-drag-handle]:focus-visible]:ring-blue-500`}
      data-testid="artist-chip"
      data-new={isNew ? 'true' : 'false'}
    >
      {/* 拖曳把手獨立成一個按鈕，避免整個標籤可拖曳時把 × 按鈕包在另一個按鈕裡 */}
      <button
        type="button"
        ref={setActivatorNodeRef}
        data-drag-handle
        aria-label={`拖曳排序 ${fieldLabel} 的 ${chip.name}`}
        disabled={disabled}
        className={`inline-flex h-6 w-5 items-center justify-center rounded-full text-current/50 touch-none select-none outline-none hover:bg-black/10 focus-visible:bg-black/10 ${disabled ? '' : 'cursor-grab active:cursor-grabbing'}`}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <span className="px-0.5" data-testid="artist-chip-name">{chip.name}</span>
      {isNew && <span className="sr-only">（新歌手）</span>}
      <button
        type="button"
        aria-label={`從 ${fieldLabel} 移除 ${chip.name}`}
        disabled={disabled}
        onClick={onRemove}
        className="inline-flex h-6 w-6 items-center justify-center rounded-full hover:bg-black/10"
      >
        <X className="h-3 w-3" aria-hidden="true" />
      </button>
    </span>
  )
}

export default function ArtistTagInput({
  label,
  role,
  value,
  onChange,
  directory,
  directoryReady,
  disabled,
  placeholder = '輸入名字，按 Enter 新增',
  labelClassName = 'text-gray-500 block mb-1',
}: ArtistTagInputProps) {
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const inflight = useRef(new Set<string>())
  const listId = useId()

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  // 排序名稱尚未決定的標籤：清單就緒後，依音樂庫或拼音補上
  useEffect(() => {
    if (!directoryReady) return
    for (const chip of value) {
      if (chip.sort !== null || inflight.current.has(chip.id)) continue
      inflight.current.add(chip.id)
      resolveSort(chip.name, directory)
        .then(sort => onChange(prev => prev.map(c => (c.id === chip.id ? { ...c, sort } : c))))
        .catch(() => { /* 存檔前會再嘗試一次 */ })
        .finally(() => inflight.current.delete(chip.id))
    }
  }, [value, directory, directoryReady, onChange])

  const chosen = useMemo(() => new Set(value.map(chip => chip.name)), [value])

  const options: Option[] = useMemo(() => {
    const suggestions = suggestArtists(directory, text, role, chosen)
    const typed = text.trim()
    if (!typed) return suggestions.map(entry => ({ kind: 'existing', entry }))
    const lower = typed.toLowerCase()
    const exists = chosen.has(typed) || [...(directory?.keys() ?? [])].some(name => name.toLowerCase() === lower)
    const list: Option[] = suggestions.map(entry => ({ kind: 'existing', entry }))
    return exists ? list : [{ kind: 'create', name: typed }, ...list]
  }, [directory, text, role, chosen])

  useEffect(() => setHighlight(0), [text])

  const addNames = (names: string[]) => {
    const fresh: ArtistChip[] = []
    const seen = new Set(chosen)
    for (const raw of names) {
      const name = raw.trim()
      if (!name || seen.has(name)) continue
      seen.add(name)
      fresh.push(makeChip(name, directory?.get(name)?.sort || null))
    }
    if (fresh.length) onChange(prev => [...prev, ...fresh])
  }

  const pick = (option: Option | undefined) => {
    if (option) addNames([option.kind === 'create' ? option.name : option.entry.name])
    else addNames([text])
    setText('')
    // 選完就收起清單：輸入框清空後清單會列出所有歌手，若不收起會蓋住下方欄位，
    // 使用者點下一個欄位時容易誤選到清單裡的歌手。繼續打字、按 ↓ 或再點輸入框會重新打開。
    setOpen(false)
  }

  const removeChip = (id: string) => onChange(prev => prev.filter(chip => chip.id !== id))

  const handleTextChange = (next: string, composing: boolean) => {
    // 輸入法選字中不拆分；打出分號（含全形）時，分號前的名字直接成為標籤
    if (!composing && /[;；]/.test(next)) {
      const parts = next.split(/[;；]/)
      addNames(parts.slice(0, -1))
      setText(parts[parts.length - 1])
    } else {
      setText(next)
    }
    setOpen(true)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // 輸入法選字中的按鍵（Enter 確認選字、Backspace 刪注音）都交給輸入法處理
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Enter') {
      // Safari 會先送出 compositionend 再送確認選字的 Enter，此時 isComposing 已是 false，
      // 需再以 keyCode 229 判斷；只在 Enter 下檢查，因為安卓虛擬鍵盤的一般按鍵也會回報 229
      if (event.keyCode === 229) return
      event.preventDefault()
      if (text.trim() || (open && options[highlight])) pick(open ? options[highlight] : undefined)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setOpen(true)
      setHighlight(h => Math.min(h + 1, Math.max(options.length - 1, 0)))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlight(h => Math.max(h - 1, 0))
    } else if (event.key === 'Escape') {
      // Esc 代表取消：關閉清單並清掉打到一半的文字，避免離開欄位時被自動加成標籤。
      // 有東西可取消時攔下 Esc，不讓外層的原生 <dialog>（標籤編輯器）跟著關閉；沒有時才交給對話框
      if (open || text) {
        event.preventDefault()
        event.stopPropagation()
      }
      setOpen(false)
      setText('')
    } else if (event.key === 'Backspace' && !text && value.length) {
      removeChip(value[value.length - 1].id)
    }
  }

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return
    onChange(prev => {
      const from = prev.findIndex(chip => chip.id === active.id)
      const to = prev.findIndex(chip => chip.id === over.id)
      return arrayMove(prev, from, to)
    })
  }

  const isNew = (name: string) => (directory ? !directory.has(name) : null)
  const reducedMotion = usePrefersReducedMotion()

  // 拖曳的語音播報：說出歌手名字與位置，而不是內部 id
  const describe = (id: string | number, list = value) => {
    const index = list.findIndex(chip => chip.id === id)
    return { name: list[index]?.name ?? '', position: index + 1, total: list.length }
  }
  const accessibility = {
    screenReaderInstructions: {
      draggable: '按空白鍵或 Enter 拿起，用方向鍵移動，再按空白鍵或 Enter 放下，按 Esc 取消。',
    },
    announcements: {
      onDragStart: ({ active }: { active: { id: string | number } }) => {
        const { name, position, total } = describe(active.id)
        return `已拿起 ${name}，目前在第 ${position} 位，共 ${total} 位。`
      },
      onDragOver: ({ active, over }: { active: { id: string | number }; over: { id: string | number } | null }) => {
        if (!over) return `${describe(active.id).name} 不在可放置的位置。`
        // 只在位置真的改變時播報，避免蓋掉「已拿起」的提示
        if (over.id === active.id) return undefined
        return `${describe(active.id).name} 移到第 ${describe(over.id).position} 位。`
      },
      onDragEnd: ({ active, over }: { active: { id: string | number }; over: { id: string | number } | null }) => {
        const { name, position, total } = describe(active.id)
        if (!over || over.id === active.id) return `已放下 ${name}，位置不變，仍在第 ${position} 位。`
        return `已放下 ${name}，現在在第 ${describe(over.id).position} 位，共 ${total} 位。`
      },
      onDragCancel: ({ active }: { active: { id: string | number } }) =>
        `已取消拖曳，${describe(active.id).name} 回到第 ${describe(active.id).position} 位。`,
    },
  }
  const showList = open && !disabled && options.length > 0

  return (
    <div className="relative">
      <label className={labelClassName} htmlFor={`${listId}-input`}>{label}</label>
      <div
        className={`flex flex-wrap items-center gap-1.5 min-h-9 w-full rounded-md border px-2 py-1 bg-white focus-within:ring-2 focus-within:ring-blue-500 ${disabled ? 'opacity-60' : 'cursor-text'}`}
        onClick={() => inputRef.current?.focus()}
      >
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd} accessibility={accessibility}>
          <SortableContext items={value.map(chip => chip.id)} strategy={rectSortingStrategy}>
            {value.map(chip => (
              <Chip key={chip.id} chip={chip} fieldLabel={label} isNew={isNew(chip.name)} disabled={disabled} reducedMotion={reducedMotion} onRemove={() => removeChip(chip.id)} />
            ))}
          </SortableContext>
        </DndContext>
        <input
          id={`${listId}-input`}
          ref={inputRef}
          value={text}
          disabled={disabled}
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-describedby={value.length ? `${listId}-sort` : undefined}
          aria-activedescendant={showList ? `${listId}-opt-${highlight}` : undefined}
          aria-autocomplete="list"
          placeholder={value.length ? '' : placeholder}
          className="flex-1 min-w-[6rem] py-1 text-sm outline-none bg-transparent"
          onChange={event => handleTextChange(event.target.value, (event.nativeEvent as InputEvent).isComposing ?? false)}
          onPaste={event => {
            const pasted = event.clipboardData.getData('text')
            if (/[;；\n]/.test(pasted)) {
              event.preventDefault()
              addNames(splitNames(pasted.replace(/[；\n]/g, ';')))
            }
          }}
          onKeyDown={handleKeyDown}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onBlur={() => {
            setOpen(false)
            if (text.trim()) pick(undefined)
          }}
        />
      </div>

      {value.length > 0 && (
        <p id={`${listId}-sort`} className="mt-1 text-xs text-gray-400" data-testid="artist-sort-preview">
          排序：{value.map(chip => chip.sort ?? '…').join('; ')}
        </p>
      )}

      {showList && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border bg-white py-1 shadow-lg"
        >
          {options.map((option, index) => {
            const active = index === highlight
            const base = `flex items-center justify-between gap-2 px-3 py-1.5 text-sm cursor-pointer ${active ? 'bg-blue-50' : ''}`
            return (
              <li
                key={option.kind === 'create' ? '__create' : option.entry.name}
                id={`${listId}-opt-${index}`}
                role="option"
                aria-selected={active}
                className={base}
                onMouseDown={event => event.preventDefault()}
                onMouseEnter={() => setHighlight(index)}
                onClick={() => pick(option)}
              >
                {option.kind === 'create' ? (
                  <span className="text-green-700">新增「{option.name}」<span className="ml-1 text-xs text-green-600">新歌手</span></span>
                ) : (
                  <>
                    <span className="truncate">{option.entry.name}</span>
                    <span className="shrink-0 text-xs text-gray-400">
                      {option.entry.sort && option.entry.sort !== option.entry.name ? `${option.entry.sort} · ` : ''}
                      {Object.values(option.entry.roles).reduce((sum, n) => sum + (n ?? 0), 0)} 首
                    </span>
                  </>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
