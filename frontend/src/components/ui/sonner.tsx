"use client"

import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { useEffect, useRef } from "react"
import { Toaster as Sonner, ToasterProps } from "sonner"

import { registerToasterHost } from "@/lib/dialog"

const Toaster = ({ ...props }: ToasterProps) => {
  // 對話框改用原生 <dialog>（top layer）後，一般的 z-index 會被蓋住；把通知放進 popover 才能顯示在對話框之上
  const hostRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const host = hostRef.current
    registerToasterHost(host)
    try {
      host?.showPopover?.()
    } catch {
      // 不支援 popover：維持一般顯示
    }
    return () => registerToasterHost(null)
  }, [])

  return (
    <div ref={hostRef} popover="manual" className="toaster-host">
    <Sonner
      className="toaster group"
      position="top-center"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      toastOptions={{
        classNames: {
          success: "!border-green-300 !bg-green-50 dark:!bg-green-950 !text-green-900 dark:!text-green-50",
          info: "!border-blue-300 !bg-blue-50 dark:!bg-blue-950 !text-blue-900 dark:!text-blue-50",
          warning: "!border-yellow-300 !bg-yellow-50 dark:!bg-yellow-950 !text-yellow-900 dark:!text-yellow-50",
          error: "!border-red-300 !bg-red-50 dark:!bg-red-950 !text-red-900 dark:!text-red-50",
        },
      }}
      {...props}
    />
    </div>
  )
}

export { Toaster }
