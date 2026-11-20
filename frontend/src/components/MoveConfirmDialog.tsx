import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { splitPath, type MoveChoice, type MovePreview } from '@/lib/songTags'

interface MoveConfirmDialogProps {
  preview: MovePreview & { proposal: NonNullable<MovePreview['proposal']> }
  /** null 代表取消儲存 */
  onChoose: (choice: MoveChoice | null) => void
}

const FIELD_NAMES = { artist: '歌手資料夾', album: '專輯資料夾', filename: '檔名' } as const

/**
 * 標籤修改會改變檔案應在的路徑時，詢問是否移動。
 * 使用原生 <dialog> 的 showModal()：焦點限制在視窗內、Esc 可取消、顯示在編輯器之上。
 */
export default function MoveConfirmDialog({ preview, onChoose }: MoveConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const { proposal, others_in_folder: others = 0, conflict } = preview
  const target = splitPath(proposal.proposed)
  const [stem, setStem] = useState(target.stem)
  const movesFolder = proposal.changed.some(field => field !== 'filename')

  // Tailwind 的 preflight 會把 margin 歸零，需以 m-auto 恢復原生 modal dialog 的置中
  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
    return () => dialog?.close()
  }, [])

  const choose = (choice: MoveChoice | null) => {
    dialogRef.current?.close()
    onChoose(choice)
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={event => { event.preventDefault(); choose(null) }}
      className="m-auto w-[min(36rem,calc(100vw-2rem))] rounded-xl p-0 shadow-xl backdrop:bg-black/40"
    >
      <div className="space-y-4 p-6">
        <h2 id={titleId} className="text-lg font-semibold text-gray-900">要移動檔案嗎？</h2>
        <p className="text-sm text-gray-600">
          這次修改改變了{proposal.changed.map(field => FIELD_NAMES[field]).join('、')}。
          標籤會先寫入，等 Navidrome 掃描過（約 1 分鐘）再移動檔案，以保留播放紀錄。
        </p>
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="text-gray-500">目前位置</dt>
            <dd className="break-all text-gray-900">{proposal.current}</dd>
          </div>
          <div>
            <dt className="text-gray-500">移動到</dt>
            <dd className="break-all text-gray-900">{target.dir}/</dd>
            <dd className="mt-1 flex items-center gap-1">
              <Input aria-label="新檔名" value={stem} onChange={event => setStem(event.target.value)} />
              <span className="shrink-0 text-gray-500">{target.ext}</span>
            </dd>
          </div>
        </dl>
        {movesFolder && others > 0 && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
            只會移動這一首，原資料夾還有 {others} 首歌會留在原位。
          </p>
        )}
        {conflict && stem === target.stem && (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            新位置已經有同名檔案，請修改檔名，或選擇只儲存標籤。
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <Button variant="outline" onClick={() => choose(null)}>取消</Button>
          <Button variant="outline" onClick={() => choose({ move: false })}>只儲存標籤</Button>
          <Button
            disabled={!stem.trim() || (conflict && stem === target.stem)}
            onClick={() => choose({ move: true, filename: stem.trim() !== target.stem ? stem.trim() : undefined })}
          >
            移動並儲存
          </Button>
        </div>
      </div>
    </dialog>
  )
}
