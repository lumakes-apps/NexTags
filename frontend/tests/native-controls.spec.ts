import { expect, test, type Page } from '@playwright/test'

/** 首頁＋標籤編輯器、快取頁、播放清單頁共用的 API mock */
async function mockApi(page: Page) {
    const calls: { endpoint: string; params: Record<string, string>; body?: unknown }[] = []
    const song = {
        Title: '晴天', Artist: '周杰倫', Album: '葉惠美', MainFolder: 'B 人聲',
        FilePath: '/Music/B 人聲/Music/周杰倫/葉惠美/03 - 晴天.flac',
        Genre: [], Language: 'chi', Favorite: 'False', Cover: '', TrackNumber: '3',
    }
    await page.route('**/api/**', async route => {
        const url = new URL(route.request().url())
        const endpoint = url.pathname.replace('/api/', '').replace(/\/$/, '')
        const method = route.request().method()
        const body = ['POST', 'PUT'].includes(method) ? route.request().postDataJSON?.() : undefined
        calls.push({ endpoint, params: Object.fromEntries(url.searchParams), body })
        const responses: Record<string, unknown> = {
            audios: { audio_files: [song], allow_folders: ['A 純音樂', 'B 人聲'], supported_languages: { chi: '中文', eng: '英文' },
                pagination: { current_page: 1, total_pages: 1, total_count: 1 } },
            'tags/languages': { chi: '中文', eng: '英文' },
            'tags/tags': ['流行'], 'tags/artists': [], 'audios/pending-moves': [],
            'tags/baseFolders': { success: true, base_folders: ['A 純音樂', 'B 人聲'] },
            'audios/move-preview': { proposal: null },
            'audios/replaygain': { success: false, message: '測試失敗' },
            'cache/statistics': { folders: ['B 人聲'], actual_files: { total: 1, by_folder: {} }, cached_files: { total: 1 }, cache_info: { cache_type: 'redis' } },
            'music-import/pending': { success: true, count: 1, pending_imports: [{ file_id: 'f1', original_filename: '晴天.flac', status: 'tags_edited',
                base_folder: 'B 人聲', errors: [], created_at: '2026-11-21T00:00:00', updated_at: '2026-11-21T00:00:00' }] },
            playlists: method === 'POST' ? { success: true, data: { id: 'p1' } } : { success: true, data: [] },
        }
        if (endpoint === 'tools/pinyin') {
            await route.fulfill({ json: { result: (body as { text?: string })?.text ?? '' } })
            return
        }
        await route.fulfill({ json: responses[endpoint] ?? { success: true } })
    })
    return calls
}

/** 開啟中對話框背景的透明度（瀏覽器可能以 rgba 或 oklab 回報） */
const backdropAlpha = (page: Page) => page.evaluate(() => {
    const dialog = [...document.querySelectorAll('dialog')].find(d => d.open)!
    const color = getComputedStyle(dialog, '::backdrop').backgroundColor
    const match = color.match(/[/,]\s*([\d.]+)\)$/)
    return match ? Number(match[1]) : 1
})

test('home filters are native selects with names and send the chosen values', async ({ page }) => {
    const calls = await mockApi(page)
    await page.goto('/')
    const folder = page.getByRole('combobox', { name: '資料夾篩選' })
    await expect(folder).toHaveJSProperty('tagName', 'SELECT')
    await folder.selectOption('B 人聲')
    await page.getByRole('combobox', { name: '語言篩選' }).selectOption('eng')
    await page.getByRole('searchbox', { name: '搜尋歌曲標題' }).press('Enter')  // 篩選在搜尋時套用（既有行為）
    await expect.poll(() => calls.filter(c => c.endpoint === 'audios').at(-1)?.params)
        .toMatchObject({ filterFolder: 'B 人聲', filterLanguage: 'eng' })
    await expect(page.getByRole('searchbox', { name: '搜尋歌曲標題' })).toBeVisible()
})

test('the tag editor is a modal dialog: labelled fields, keyboard cover button, Esc closes and focus returns', async ({ page }) => {
    await mockApi(page)
    await page.goto('/')
    const editButton = page.locator('tbody tr').getByRole('button')
    await editButton.click()
    const editor = page.getByRole('dialog', { name: '編輯標籤' })
    await expect(editor).toBeVisible()

    // 每個欄位都能用標籤找到
    await expect(editor.getByLabel('Track Number')).toHaveValue('3')
    for (const label of ['Track Total', 'Disc Number', 'Disc Total', '備註 (Comment)', '歌詞 (Lyrics)', 'Track Gain', 'Track Peak', 'Favorite']) {
        await expect(editor.getByLabel(label, { exact: true })).toHaveCount(1)
    }
    const language = editor.getByRole('combobox', { name: 'Language' })
    await expect(language).toHaveJSProperty('tagName', 'SELECT')
    await language.selectOption('eng')
    await expect(language).toHaveValue('eng')
    await expect(editor.getByRole('group', { name: 'Genre' }).getByRole('button', { name: '流行' })).toHaveAttribute('aria-pressed', 'false')

    // 封面可用鍵盤操作
    const cover = editor.getByRole('button', { name: '上傳封面圖片' })
    await cover.focus()
    await expect(cover).toBeFocused()

    // 背後頁面 inert、背景半透明（Tailwind 4 已移除 bg-opacity-*）
    expect(await backdropAlpha(page)).toBe(0.3)

    await page.keyboard.press('Escape')
    await expect(editor).toHaveCount(0)
    await expect(editButton).toBeFocused()
})

test('notifications stay visible above an open dialog', async ({ page }) => {
    await mockApi(page)
    await page.goto('/')
    await page.locator('tbody tr').getByRole('button').click()
    await page.getByRole('dialog', { name: '編輯標籤' }).getByRole('button', { name: /計算 ReplayGain/ }).click()
    const toast = page.getByText('ReplayGain 生成失敗：測試失敗')
    await expect(toast).toBeVisible()
    // 通知容器在 top layer（popover），且在對話框開啟後重新顯示，因此排在對話框之上
    expect(await toast.evaluate(el => el.closest('.toaster-host')!.matches(':popover-open'))).toBe(true)
})

test('shared dialog: named, semi-transparent backdrop, Esc closes and focus returns', async ({ page }) => {
    await mockApi(page)
    await page.goto('/cache')
    const trigger = page.getByRole('button', { name: '刪除 晴天.flac' })
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: '確認刪除' })
    await expect(dialog).toBeVisible()
    expect(await backdropAlpha(page)).toBe(0.5)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
    // 點背景（對話框外）也能關閉
    await trigger.click()
    await expect(dialog).toBeVisible()
    await page.mouse.click(5, 5)
    await expect(dialog).toHaveCount(0)
})

test('playlist editor uses native select and radio buttons', async ({ page }) => {
    const calls = await mockApi(page)
    await page.goto('/playlists')
    await page.getByRole('button', { name: '新增播放清單' }).click()
    const dialog = page.getByRole('dialog', { name: '新增播放清單' })
    await expect(dialog).toBeVisible()
    await dialog.getByLabel('Title', { exact: true }).fill('測試清單')
    await dialog.getByRole('combobox', { name: 'BaseFolder' }).selectOption('B 人聲')
    await dialog.getByRole('group', { name: 'Favorites' }).getByRole('radio', { name: '是' }).check()
    await dialog.getByRole('group', { name: 'Sort Method (排序方式)' }).getByRole('radio', { name: '標題 (TitleSort)' }).check()
    await expect(dialog.getByRole('switch', { name: '系統等級播放清單' })).toHaveAccessibleDescription(/存入 \/Music\/Playlist/)
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect.poll(() => calls.find(c => c.endpoint === 'playlists' && c.body)?.body)
        .toMatchObject({ name: '測試清單', base_folder: 'B 人聲', filter_favorites: true, sort_method: 'title' })
})
