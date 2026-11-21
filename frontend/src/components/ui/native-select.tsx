import * as React from "react"

import { cn } from "@/lib/utils"

/** 原生 <select>，外觀與 Input 一致；手機上使用系統選擇器，標籤與表單語意由瀏覽器處理 */
function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        "border-input flex h-9 w-full min-w-0 rounded-md border bg-white px-3 py-1 text-base shadow-xs outline-none transition-[color,box-shadow] md:text-sm",
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { NativeSelect }
