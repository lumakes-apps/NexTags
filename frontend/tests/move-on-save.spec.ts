import { expect, test, type Page } from '@playwright/test'

const PATH = '/Music/B 人聲/Music/周杰倫/葉惠美/03 - 晴天.flac'
const NEW_PATH = '/Music/B 人聲/Music/周杰倫/葉惠美 (Live)/03 - 晴天.flac'

async function openEditor(page: Page, options: { conflict?: boolean; pending?: object[] } = {}) {
    const song = {
        Title: '晴天', Artist: '周杰倫', SortArtist: 'zhoujielun', Album: '葉惠美', SortAlbum: 'yehuimei',
        SortTitle: 'qingtian', TrackNumber: '3', MainFolder: 'B 人聲', FilePath: PATH,
        Genre: [], Language: 'chi', Favorite: 'False', Cover: '',
    }
    const calls = { saves: [] as Record<string, unknown>[], cancels: [] as string[] }
    let pending = options.pending ?? []
    await page.route('**/api/**', async route => {
        const url = new URL(route.request().url())
        const endpoint = url.pathname.replace('/api/', '')
        let response: unknown = { success: true }
        if (endpoint === 'audios') {
            response = { audio_files: [song], allow_folders: ['B 人聲'], supported_languages: { chi: '中文' },
                pagination: { current_page: 1, total_pages: 1, total_count: 1 } }
        } else if (endpoint === 'tags/languages') {
            response = { chi: '中文' }
        } else if (endpoint === 'tags/tags' || endpoint === 'tags/artists') {
            response = []
        } else if (endpoint === 'tools/pinyin') {
            response = { result: `py-${route.request().postDataJSON().text}` }
        } else if (endpoint === 'audios/pending-moves') {
            if (route.request().method() === 'DELETE') {
                calls.cancels.push(url.searchParams.get('path') ?? '')
                pending = []
            } else {
                response = pending
            }
        } else if (endpoint === 'audios/move-preview') {
            const tags = route.request().postDataJSON().tags[0]
            response = tags.album === '葉惠美'
                ? { proposal: null }
                : { proposal: { current: PATH, proposed: NEW_PATH, changed: ['album'] }, conflict: !!options.conflict, others_in_folder: 2 }
        } else if (endpoint === 'audios/update') {
            calls.saves.push(route.request().postDataJSON())
            response = { success: true, message: '標籤已儲存' }
        }
        await route.fulfill({ json: response })
    })
    await page.goto('/')
    await page.locator('tbody tr').getByRole('button').click()
    await expect(page.getByRole('heading', { name: '編輯標籤' })).toBeVisible()
    return calls
}

const changeAlbum = async (page: Page) => {
    await page.getByPlaceholder('專輯名稱', { exact: true }).fill('葉惠美 (Live)')
    await page.getByRole('button', { name: '保存變更' }).click()
}

test('saving without path changes does not ask about moving', async ({ page }) => {
    const calls = await openEditor(page)
    await page.getByRole('button', { name: '保存變更' }).click()
    await expect.poll(() => calls.saves.length).toBe(1)
    expect(calls.saves[0]).toMatchObject({ move: false })
    await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('the dialog shows the new path and saving tags only does not move', async ({ page }) => {
    const calls = await openEditor(page)
    await changeAlbum(page)
    const dialog = page.getByRole('dialog', { name: '要移動檔案嗎？' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText(PATH)
    await expect(dialog).toContainText('/Music/B 人聲/Music/周杰倫/葉惠美 (Live)/')
    await expect(dialog).toContainText('原資料夾還有 2 首歌')
    await dialog.getByRole('button', { name: '只儲存標籤' }).click()
    await expect.poll(() => calls.saves.length).toBe(1)
    expect(calls.saves[0]).toMatchObject({ move: false, tags: [{ album: '葉惠美 (Live)' }] })
})

test('moving sends the move request with an edited filename', async ({ page }) => {
    const calls = await openEditor(page)
    await changeAlbum(page)
    const dialog = page.getByRole('dialog', { name: '要移動檔案嗎？' })
    await dialog.getByRole('textbox', { name: '新檔名' }).fill('03 - 晴天 (Live)')
    await dialog.getByRole('button', { name: '移動並儲存' }).click()
    await expect.poll(() => calls.saves.length).toBe(1)
    expect(calls.saves[0]).toMatchObject({ move: true, move_filename: '03 - 晴天 (Live)' })
})

test('escape cancels the save entirely', async ({ page }) => {
    const calls = await openEditor(page)
    await changeAlbum(page)
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    // 標籤編輯器本身也是對話框：只有移動確認關閉，編輯器維持開啟
    await expect(page.getByRole('dialog', { name: '要移動檔案嗎？' })).toHaveCount(0)
    await expect(page.getByRole('dialog', { name: '編輯標籤' })).toBeVisible()
    await expect(page.getByRole('heading', { name: '編輯標籤' })).toBeVisible()
    expect(calls.saves).toHaveLength(0)
})

test('a filename conflict blocks moving until the name changes', async ({ page }) => {
    await openEditor(page, { conflict: true })
    await changeAlbum(page)
    const dialog = page.getByRole('dialog', { name: '要移動檔案嗎？' })
    await expect(dialog.getByRole('alert')).toContainText('同名檔案')
    await expect(dialog.getByRole('button', { name: '移動並儲存' })).toBeDisabled()
    await dialog.getByRole('textbox', { name: '新檔名' }).fill('03 - 晴天 2')
    await expect(dialog.getByRole('button', { name: '移動並儲存' })).toBeEnabled()
})

test('a pending move is shown on the list and in the editor, and can be cancelled', async ({ page }) => {
    const pending = [{ source: PATH, target: NEW_PATH, created_at: '2026-11-20T00:00:00+00:00', status: 'pending', error: null }]
    const calls = await openEditor(page, { pending })
    await expect(page.getByTestId('move-badge')).toHaveText('待移動')
    const banner = page.getByTestId('pending-move')
    await expect(banner).toContainText(NEW_PATH)
    await banner.getByRole('button', { name: '取消移動' }).click()
    await expect(banner).toHaveCount(0)
    expect(calls.cancels).toEqual([PATH])
})
