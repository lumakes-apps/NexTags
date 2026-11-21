import { useCallback, useEffect, useRef } from 'react'

let toasterHost: HTMLElement | null = null

/** 由 Toaster 登記通知容器（popover），讓對話框開啟後可以把它重新排到最上層 */
export function registerToasterHost(element: HTMLElement | null) {
  toasterHost = element
}

/** top layer 依開啟順序疊放：開啟對話框後重新顯示通知容器，通知才會蓋在對話框上面 */
export function raiseToaster() {
  const host = toasterHost
  if (!host?.isConnected || typeof host.showPopover !== 'function') return
  try {
    if (host.matches(':popover-open')) host.hidePopover()
    host.showPopover()
  } catch {
    // 不支援 popover 的瀏覽器：通知仍以一般方式顯示
  }
}

/**
 * 依 open 以 showModal() 開啟或關閉原生 <dialog>（焦點限制、Esc、背景 inert、關閉後焦點回到原按鈕都由瀏覽器處理）。
 * 回傳的 setRef 要放在 <dialog ref={setRef}>：父元件直接把對話框從畫面移除時（例如把狀態設成 null），
 * React 會在移除前呼叫 ref 的清除函式，先 close() 才能讓焦點回到開啟它的按鈕（直接移除元素不會）。
 */
export function useModalDialog(open: boolean) {
  const ref = useRef<HTMLDialogElement | null>(null)
  const openRef = useRef(open)
  openRef.current = open
  const setRef = useCallback((element: HTMLDialogElement | null) => {
    ref.current = element
    if (!element) return
    // 重新掛上時（例如開發模式 StrictMode 會先卸下再掛上 ref）若應該開著就重新開啟
    if (openRef.current && !element.open) {
      element.showModal()
      raiseToaster()
    }
    return () => {
      if (element.open) element.close()
      ref.current = null
    }
  }, [])

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) {
      dialog.showModal()
      raiseToaster()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  return { ref, setRef }
}

/** 不支援 closedby 的瀏覽器（Safari）：自行實作點背景關閉；按下與放開都在對話框外才關，避免拖曳選字誤關 */
export const supportsClosedBy = typeof HTMLDialogElement !== 'undefined' && 'closedBy' in HTMLDialogElement.prototype

export function isOutside(event: { clientX: number; clientY: number }, element: Element) {
  const rect = element.getBoundingClientRect()
  return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom
}
