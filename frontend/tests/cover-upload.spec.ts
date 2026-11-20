import { expect, test, type Page } from '@playwright/test'

const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64')
const image = { name: 'cover.png', mimeType: 'image/png', buffer: imageBytes }

async function openEditor(page: Page, existingCover = '') {
    const song = {
        Title: '求神呐', Artist: '呜米;咩栗', Album: '求神呐 - 翻唱',
        MainFolder: 'B 人聲', FilePath: '/Music/B 人聲/Music/呜米/求神呐 - 翻唱/01 - 求神呐.flac',
        Genre: [], Language: 'chi', Favorite: 'False', Cover: existingCover,
    }
    const control: { fail: boolean; hold: boolean; httpFailure: boolean; missingCoverAck: boolean; release?: () => void } = { fail: false, hold: false, httpFailure: false, missingCoverAck: false }
    const saves: { cover_data?: string; path: string }[] = []
    await page.route('**/api/**', async route => {
        const endpoint = new URL(route.request().url()).pathname.replace('/api/', '')
        if (endpoint === 'images/cover') {
            await route.fulfill({ contentType: 'image/png', body: imageBytes })
            return
        }
        let response: unknown = { success: true }
        if (endpoint === 'audios') {
            response = { audio_files: [song], allow_folders: ['B 人聲'], supported_languages: { chi: '中文' },
                pagination: { current_page: 1, total_pages: 1, total_count: 1 } }
        } else if (endpoint === 'tags/languages') {
            response = { chi: '中文' }
        } else if (endpoint === 'tags/tags') {
            response = []
        } else if (endpoint === 'tags/artists') {
            response = []
        } else if (endpoint === 'tools/pinyin') {
            response = { result: route.request().postDataJSON().text }
        } else if (endpoint === 'audios/update') {
            const data = route.request().postDataJSON()
            saves.push(data)
            if (control.hold) await new Promise<void>(resolve => { control.release = resolve })
            if (control.httpFailure) {
                await route.fulfill({ status: 500, json: { detail: '封面資料夾無法寫入' } })
                return
            }
            if (control.fail) response = { success: false, message: '封面儲存失敗，請重試' }
            else {
                if (data.cover_data) song.Cover = '/Music/B 人聲/Music/呜米/求神呐 - 翻唱/cover.png'
                response = { success: true, message: data.cover_data ? '標籤與封面已儲存' : '標籤已儲存', cover_path: control.missingCoverAck ? undefined : song.Cover }
            }
        }
        await route.fulfill({ json: response })
    })
    await page.goto('/')
    await page.locator('tbody tr').getByRole('button').click()
    await expect(page.getByRole('heading', { name: '編輯標籤' })).toBeVisible()
    return { saves, control }
}

test('cover stays pending until the save completes and remains after reopening', async ({ page }) => {
    const { saves, control } = await openEditor(page)
    control.hold = true
    await page.locator('input[type=file]').setInputFiles(image)
    await expect(page.getByRole('status').filter({ hasText: '封面尚未儲存' })).toBeVisible()
    expect(saves).toHaveLength(0)
    await page.getByRole('button', { name: '保存變更' }).click()
    await expect(page.getByRole('button', { name: '儲存中...' })).toBeDisabled()
    await expect(page.getByText('標籤與封面已儲存', { exact: true })).toHaveCount(0)
    expect(saves[0].cover_data).toBe(`data:image/png;base64,${imageBytes.toString('base64')}`)
    control.release?.()
    await expect(page.getByText('標籤與封面已儲存', { exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: '編輯標籤' })).toHaveCount(0)
    await page.locator('tbody tr').getByRole('button').click()
    await expect(page.getByRole('img', { name: 'Album Cover' })).toHaveAttribute('src', /\/api\/images\/cover\?path=.*cover.png&v=\d+/)
})

test('failed save keeps the selected image and allows retry', async ({ page }) => {
    const { saves, control } = await openEditor(page)
    control.fail = true
    await page.locator('input[type=file]').setInputFiles(image)
    await page.getByRole('button', { name: '保存變更' }).click()
    await expect(page.getByRole('alert')).toHaveText('封面儲存失敗，請重試')
    await expect(page.getByRole('img', { name: 'Album Cover' })).toHaveAttribute('src', /^data:image\/png;base64,/)
    await expect(page.getByRole('button', { name: '保存變更' })).toBeEnabled()
    control.fail = false
    await page.getByRole('button', { name: '保存變更' }).click()
    await expect(page.getByText('標籤與封面已儲存', { exact: true })).toBeVisible()
    expect(saves).toHaveLength(2)
})

test('cancelling a replacement preserves the existing cover', async ({ page }) => {
    const { saves } = await openEditor(page, '/Music/album/cover.jpg')
    await page.locator('input[type=file]').setInputFiles(image)
    await page.getByRole('button', { name: '取消更換封面' }).click()
    await expect(page.getByRole('img', { name: 'Album Cover' })).toHaveAttribute('src', /cover.jpg&v=\d+/)
    await page.getByRole('button', { name: '保存變更' }).click()
    await expect(page.getByText('標籤已儲存', { exact: true })).toBeVisible()
    expect(saves[0].cover_data).toBeUndefined()
})

test('unsupported image formats show a visible error', async ({ page }) => {
    const { saves } = await openEditor(page)
    await page.locator('input[type=file]').setInputFiles({ name: 'cover.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') })
    await expect(page.getByRole('alert')).toHaveText('請選擇 10 MB 以下的 JPEG 或 PNG 封面')
    expect(saves).toHaveLength(0)
})

test('server error details remain visible in the editor', async ({ page }) => {
    const { control } = await openEditor(page)
    control.httpFailure = true
    await page.locator('input[type=file]').setInputFiles(image)
    await expect(page.getByRole('status').filter({ hasText: '封面尚未儲存' })).toBeVisible()
    await page.getByRole('button', { name: '保存變更' }).click()
    await expect(page.getByRole('alert')).toHaveText('封面資料夾無法寫入')
    await expect(page.getByRole('heading', { name: '編輯標籤' })).toBeVisible()
})

test('a generic success response cannot falsely confirm a cover save', async ({ page }) => {
    const { control } = await openEditor(page)
    control.missingCoverAck = true
    await page.locator('input[type=file]').setInputFiles(image)
    await expect(page.getByRole('status').filter({ hasText: '封面尚未儲存' })).toBeVisible()
    await page.getByRole('button', { name: '保存變更' }).click()
    await expect(page.getByRole('alert')).toHaveText('伺服器未確認封面已儲存，請重試')
    await expect(page.getByRole('heading', { name: '編輯標籤' })).toBeVisible()
})
