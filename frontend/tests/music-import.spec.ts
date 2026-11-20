import { expect, test, type Page } from '@playwright/test'

async function openImport(page: Page, needsArtistImage = false) {
    const albumPath = '/Music/B 人聲/Music/呜米/求神呐 - 翻唱'
    const requests: { endpoint: string; filename?: string }[] = []
    const control = { rejectFinalize: false }
    const session = {
        file_id: 'test-import', original_filename: 'original.flac',
        temp_path: '/Music/WaitImport/original.flac', base_folder: 'B 人聲',
        format: 'flac', needs_conversion: false, status: 'uploaded',
        extracted_tags: { title: '-', artist: '呜米', album: '求神呐 - 翻唱', tracknumber: '' },
        suggested_filename: '01 - -.flac', preview_final_path: '',
    }
    await page.route('**/api/**', async route => {
        const endpoint = new URL(route.request().url()).pathname.replace('/api/', '')
        let response: unknown = { success: true }
        if (endpoint === 'tags/baseFolders') {
            response = { success: true, base_folders: ['B 人聲'] }
        } else if (endpoint === 'tags/languages') {
            response = {}
        } else if (endpoint === 'tags/tags') {
            response = []
        } else if (endpoint === 'tags/artists') {
            response = []
        } else if (endpoint === 'tools/pinyin') {
            response = { result: route.request().postDataJSON().text }
        } else if (endpoint === 'music-import/upload') {
            response = session
        } else if (endpoint === 'music-import/extract-tags') {
            session.status = 'tags_extracted'
        } else if (endpoint === 'music-import/status') {
            response = { success: true, file_info: session }
        } else if (endpoint === 'music-import/update-tags') {
            session.extracted_tags = route.request().postDataJSON().tags
            session.suggested_filename = '03 - 求神呐.flac'
            session.status = 'tags_edited'
            response = { success: true, updated_tags: session.extracted_tags }
        } else if (endpoint === 'music-import/check-artist') {
            session.status = 'artist_ready'
            response = { success: true, artists: [{ artist_name: '呜米', needs_artist_image: needsArtistImage }] }
        } else if (endpoint === 'music-import/process-album') {
            session.status = 'album_ready'
        } else if (endpoint === 'music-import/finalize') {
            const filename = route.request().postDataJSON().final_filename
            requests.push({ endpoint, filename })
            if (control.rejectFinalize) {
                await route.fulfill({ status: 500, json: { detail: 'test finalization failure' } })
                return
            }
            session.preview_final_path = `${albumPath}/${filename}`
            session.status = 'ready_to_move'
            response = { success: true, preview_final_path: session.preview_final_path }
        } else if (endpoint === 'music-import/confirm-move') {
            requests.push({ endpoint, filename: session.preview_final_path.split('/').pop() })
            session.status = 'completed'
        }
        await route.fulfill({ json: response })
    })
    await page.goto('/new')
    await expect(page.getByRole('combobox').first()).toContainText('B 人聲')
    await page.locator('#file-upload').setInputFiles({
        name: 'original.flac', mimeType: 'audio/flac', buffer: Buffer.from('mock audio'),
    })
    await page.getByPlaceholder('歌曲標題').fill('求神呐')
    await page.getByPlaceholder('01', { exact: true }).fill('3')
    await page.getByRole('button', { name: '儲存標籤' }).click()
    if (needsArtistImage) {
        await page.getByRole('button', { name: '跳過', exact: true }).click()
    }
    await expect(page.getByRole('heading', { name: '確認資訊' })).toBeVisible()
    return { requests, control, albumPath, filenameInput: page.getByRole('textbox') }
}

for (const needsArtistImage of [false, true]) {
    test(`saved title and custom filename reach the move (artist image step: ${needsArtistImage})`, async ({ page }) => {
        const { requests, albumPath, filenameInput } = await openImport(page, needsArtistImage)
        await expect(filenameInput).toHaveValue('03 - 求神呐.flac')
        expect(requests[0].filename).toBe('03 - 求神呐.flac')
        await filenameInput.fill('03 - 自訂名稱.flac')
        await expect(page.getByText(`${albumPath}/03 - 自訂名稱.flac`, { exact: true })).toBeVisible()
        await page.getByRole('button', { name: '確認移動檔案', exact: true }).click()
        await expect(page.getByText('檔案匯入完成!')).toBeVisible()
        expect(requests.slice(-2)).toEqual([
            { endpoint: 'music-import/finalize', filename: '03 - 自訂名稱.flac' },
            { endpoint: 'music-import/confirm-move', filename: '03 - 自訂名稱.flac' },
        ])
    })
}

test('a failed filename update stops the move', async ({ page }) => {
    const { requests, control, filenameInput } = await openImport(page)
    control.rejectFinalize = true
    await filenameInput.fill('03 - 自訂名稱.flac')
    await page.getByRole('button', { name: '確認移動檔案', exact: true }).click()
    await expect(page.getByText('Request failed with status code 500')).toBeVisible()
    expect(requests.filter(request => request.endpoint === 'music-import/confirm-move')).toHaveLength(0)
    await expect(filenameInput).toBeEnabled()
})

test('an empty filename cannot be moved', async ({ page }) => {
    const { filenameInput } = await openImport(page)
    await filenameInput.fill('   ')
    await expect(page.getByRole('button', { name: '確認移動檔案', exact: true })).toBeDisabled()
})
