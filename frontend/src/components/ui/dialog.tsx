import * as React from "react"
import { cn } from "@/lib/utils"
import { X } from "lucide-react"
import { isOutside, supportsClosedBy, useModalDialog } from "@/lib/dialog"

interface DialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    children: React.ReactNode
    /** 點背景可關閉（預設是）；Esc 一律可關閉 */
    dismissible?: boolean
}

const DialogTitleIdContext = React.createContext<string | undefined>(undefined)

/**
 * 原生 modal <dialog>：瀏覽器提供 dialog 語意、焦點限制、Esc 關閉、背景 inert 與關閉後焦點回到原按鈕。
 * 以 DialogTitle 自動命名；關閉時才卸載內容（與先前行為相同）。
 */
export function Dialog({ open, onOpenChange, children, dismissible = true }: DialogProps) {
    const titleId = React.useId()
    const openRef = React.useRef(open)
    openRef.current = open
    const pressedOutside = React.useRef(false)
    const { setRef } = useModalDialog(open)

    return (
        <dialog
            ref={setRef}
            aria-labelledby={titleId}
            {...({ closedby: dismissible ? "any" : "closerequest" } as object)}
            // Esc、點背景（closedby）或程式關閉後，同步回 React 狀態
            // React 的合成事件會讓內層對話框的 close 冒泡上來，只處理自己的
            onClose={event => { if (event.target === event.currentTarget && openRef.current) onOpenChange(false) }}
            onPointerDown={event => {
                pressedOutside.current = dismissible && !supportsClosedBy && isOutside(event, event.currentTarget)
            }}
            onPointerUp={event => {
                if (pressedOutside.current && isOutside(event, event.currentTarget)) event.currentTarget.close()
                pressedOutside.current = false
            }}
            className="m-auto max-h-none max-w-none overflow-visible border-0 bg-transparent p-0 backdrop:bg-black/50"
        >
            <DialogTitleIdContext.Provider value={titleId}>
                {open && children}
            </DialogTitleIdContext.Provider>
        </dialog>
    )
}

type DialogContentProps = React.ComponentProps<"div">

export function DialogContent({ className, children, ...props }: DialogContentProps) {
    return (
        <div
            className={cn(
                "w-[calc(100vw-2rem)] max-w-lg bg-white rounded-lg shadow-lg p-4 max-h-[90vh] overflow-y-auto",
                className
            )}
            {...props}
        >
            {children}
        </div>
    )
}

type DialogHeaderProps = React.ComponentProps<"div">

export function DialogHeader({ className, children, ...props }: DialogHeaderProps) {
    return (
        <div
            className={cn("flex items-center justify-between mb-4", className)}
            {...props}
        >
            {children}
        </div>
    )
}

type DialogTitleProps = React.ComponentProps<"h2">

export function DialogTitle({ className, children, ...props }: DialogTitleProps) {
    const titleId = React.useContext(DialogTitleIdContext)
    return (
        <h2
            id={titleId}
            className={cn("text-lg font-semibold text-gray-900", className)}
            {...props}
        >
            {children}
        </h2>
    )
}

type DialogDescriptionProps = React.ComponentProps<"p">

export function DialogDescription({ className, children, ...props }: DialogDescriptionProps) {
    return (
        <p
            className={cn("text-sm text-gray-600 mt-1", className)}
            {...props}
        >
            {children}
        </p>
    )
}

interface DialogCloseProps {
    onClose: () => void
}

export function DialogClose({ onClose }: DialogCloseProps) {
    return (
        <button
            type="button"
            aria-label="關閉"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
        >
            <X className="w-5 h-5" />
        </button>
    )
}

type DialogFooterProps = React.ComponentProps<"div">

export function DialogFooter({ className, children, ...props }: DialogFooterProps) {
    return (
        <div
            className={cn("flex justify-end space-x-2 pt-4", className)}
            {...props}
        >
            {children}
        </div>
    )
}