import { expect, test, type Page } from '@playwright/test'

type Session = Record<string, unknown> & { file_id: string; status: string }

const baseSession = (status: string, extra: Record<string, unknown> = {}): Session => ({
    file_id: 'f1', original_filename: '晴天.flac', temp_path: '/Music/WaitImport/f1_晴天.flac',
    base_folder: 'B 人聲', format: 'flac', needs_conversion: false, status,
    extracted_tags: { title: '晴天', artist: '周杰倫', album: '葉惠美', tracknumber: '3' },
    suggested_filename: '03 - 晴天.flac', errors: [], ...extra,
})

/** 模擬匯入 API：記錄呼叫順序，並依呼叫推進狀態 */
async function mockImport(page: Page, sessions: Session[], pendingExtra: Record<string, unknown>[] = []) {
    const calls: { endpoint: string; body?: Record<string, unknown> }[] = []
    const store = new Map(sessions.map(session => [session.file_id, session]))
    const pending = () => [
        ...[...store.values()].filter(s => s.status !== 'completed').map(s => ({
            file_id: s.file_id, original_filename: s.original_filename, status: s.status,
            base_folder: s.base_folder, errors: [], created_at: '2026-11-21T00:00:00', updated_at: '2026-11-21T00:00:00',
            needs_base_folder: !s.base_folder,
        })),
        ...pendingExtra.filter(item => !store.has(String(item.file_id))),
    ]
    await page.route('**/api/**', async route => {
        const request = route.request()
        const endpoint = new URL(request.url()).pathname.replace('/api/', '').replace(/\/$/, '')
        const body = ['POST', 'DELETE'].includes(request.method()) ? request.postDataJSON?.() ?? undefined : undefined
        if (endpoint.startsWith('music-import/')) calls.push({ endpoint: endpoint.replace('music-import/', ''), body })
        const id = String(body?.file_id ?? new URL(request.url()).searchParams.get('file_id') ?? 'f1')
        const session = store.get(id)
        let response: unknown = { success: true }
        switch (endpoint) {
            case 'tags/baseFolders': response = { success: true, base_folders: ['B 人聲', 'A 純音樂'] }; break
            case 'tags/languages': response = {}; break
            case 'tags/tags': case 'tags/artists': response = []; break
            case 'tools/pinyin': response = { result: body?.text }; break
            case 'cache/statistics': response = { folders: [], actual_files: { total: 0, by_folder: {} }, cached_files: { total: 0 }, cache_info: { cache_type: 'redis' } }; break
            case 'music-import/pending': response = { success: true, pending_imports: pending(), count: pending().length }; break
            case 'music-import/resume': {
                let target = session
                if (!target) {
                    // 進度遺失：從檔案重新建立
                    target = baseSession('uploaded', { file_id: id, base_folder: body?.base_folder, recovered: true })
                    store.set(id, target)
                }
                response = { success: true, file_id: id, status: target.status, file_info: target, recovered: !session }
                break
            }
            case 'music-import/status': response = { success: true, file_info: session }; break
            case 'music-import/convert': session!.status = 'converted'; break
            case 'music-import/extract-tags': session!.status = 'tags_extracted'; break
            case 'music-import/update-tags': session!.status = 'tags_edited'; session!.extracted_tags = body?.tags; break
            case 'music-import/check-artist':
                session!.status = 'artist_ready'
                response = { success: true, artists: [{ artist_name: '周杰倫', needs_artist_image: false }] }
                break
            case 'music-import/process-album': session!.status = 'album_ready'; session!.album_name = body?.album_name; break
            case 'music-import/finalize':
                session!.status = 'ready_to_move'
                session!.final_filename = body?.final_filename
                session!.preview_final_path = `/Music/B 人聲/Music/周杰倫/葉惠美/${body?.final_filename}`
                response = { success: true, preview_final_path: session!.preview_final_path }
                break
            case 'music-import/confirm-move': session!.status = 'completed'; break
            case 'music-import/delete': store.delete(id); break
        }
        await route.fulfill({ json: response })
    })
    return { calls, store }
}

const firstStepCall = (calls: { endpoint: string }[]) =>
    calls.map(call => call.endpoint).filter(name => !['pending', 'resume', 'status'].includes(name))[0]

const cases: { status: string; extra?: Record<string, unknown>; first?: string; editor?: boolean; confirm?: boolean }[] = [
    { status: 'uploaded', first: 'extract-tags' },
    { status: 'uploaded', extra: { needs_conversion: true, format: 'm4a' }, first: 'convert' },
    { status: 'converted', first: 'extract-tags' },
    { status: 'tags_extracted', editor: true },
    { status: 'tags_edited', first: 'check-artist' },
    { status: 'artist_ready', extra: { needs_artist_image: true, artist_name: '周杰倫' }, first: 'check-artist' },
    { status: 'artist_ready', extra: { needs_artist_image: false, artist_name: '周杰倫' }, first: 'process-album' },
    { status: 'album_ready', extra: { album_name: '葉惠美' }, first: 'finalize' },
    { status: 'ready_to_move', extra: { final_filename: '03 - 晴天 (Live).flac', preview_final_path: '/Music/B 人聲/Music/周杰倫/葉惠美/03 - 晴天 (Live).flac' }, confirm: true },
]

for (const item of cases) {
    const name = `${item.status}${item.extra?.needs_conversion ? ' (m4a)' : ''}${'needs_artist_image' in (item.extra ?? {}) ? ` (needs image: ${item.extra!.needs_artist_image})` : ''}`
    test(`resuming at ${name} continues from that step`, async ({ page }) => {
        const { calls } = await mockImport(page, [baseSession(item.status, item.extra)])
        await page.goto('/new')
        const list = page.getByTestId('pending-imports')
        await expect(list).toContainText('未完成的匯入（1）')
        await list.getByRole('button', { name: '繼續匯入 晴天.flac' }).click()
        if (item.editor) {
            // 共用的 Dialog 元件沒有 dialog role（既有問題），改用標籤編輯器的欄位判斷
            await expect(page.getByText('編輯音樂標籤', { exact: true })).toBeVisible()
            await expect(page.getByPlaceholder('歌曲標題')).toHaveValue('晴天')
        }
        if (item.confirm) {
            await expect(page.getByRole('heading', { name: '確認資訊' })).toBeVisible()
            await expect(page.getByRole('textbox')).toHaveValue('03 - 晴天 (Live).flac')
        }
        if (item.first) await expect.poll(() => firstStepCall(calls)).toBe(item.first)
        else expect(firstStepCall(calls)).toBeUndefined()
        // 不需要重新上傳
        expect(calls.some(call => call.endpoint.startsWith('upload'))).toBe(false)
    })
}

test('a resumed import can be finished end to end', async ({ page }) => {
    const { calls, store } = await mockImport(page, [baseSession('tags_extracted')])
    await page.goto('/new')
    await page.getByRole('button', { name: '繼續匯入 晴天.flac' }).click()
    await page.getByRole('button', { name: '儲存標籤' }).click()
    await expect(page.getByRole('heading', { name: '確認資訊' })).toBeVisible()
    await page.getByRole('button', { name: '確認移動檔案' }).click()
    await expect(page.getByText('檔案匯入完成!')).toBeVisible()
    expect(store.get('f1')!.status).toBe('completed')
    expect(calls.map(call => call.endpoint)).toEqual(expect.arrayContaining(['update-tags', 'check-artist', 'process-album', 'finalize', 'confirm-move']))
})

test('a lost session restarts from the file in the chosen folder', async ({ page }) => {
    const lost = { file_id: 'lost-1', original_filename: '遺失.flac', status: 'orphaned', base_folder: '', errors: [],
        created_at: '2026-11-21T00:00:00', updated_at: '2026-11-21T00:00:00', needs_base_folder: true }
    const { calls } = await mockImport(page, [], [lost])
    await page.goto('/new')
    const list = page.getByTestId('pending-imports')
    await expect(list).toContainText('進度遺失，可從檔案重新開始')
    await list.getByLabel('目標資料夾').selectOption('A 純音樂')
    await list.getByRole('button', { name: '繼續匯入 遺失.flac' }).click()
    await expect(page.getByPlaceholder('歌曲標題')).toBeVisible()
    expect(calls.find(call => call.endpoint === 'resume')?.body).toEqual({ file_id: 'lost-1', base_folder: 'A 純音樂' })
    expect(firstStepCall(calls)).toBe('extract-tags')
})

test('the cache page continue button opens the import at its step', async ({ page }) => {
    const { calls } = await mockImport(page, [baseSession('ready_to_move', { final_filename: '03 - 晴天.flac', preview_final_path: '/x/03 - 晴天.flac' })])
    await page.goto('/cache')
    await expect(page.getByText('待確認移動')).toBeVisible()
    await page.getByRole('link', { name: '繼續匯入 晴天.flac' }).click()
    await expect(page.getByRole('heading', { name: '確認資訊' })).toBeVisible()
    await expect(page).toHaveURL(/\/new$/)  // 參數用完即清掉
    expect(calls.filter(call => call.endpoint === 'resume')).toHaveLength(1)
})

test('closing the tag editor leaves continue, pause and delete actions; pausing keeps it in the list', async ({ page }) => {
    const { calls } = await mockImport(page, [baseSession('tags_extracted')])
    await page.goto('/new')
    await page.getByRole('button', { name: '繼續匯入 晴天.flac' }).click()
    await page.getByRole('button', { name: '取消', exact: true }).click()  // 關掉標籤編輯器
    const actions = page.getByTestId('import-actions')
    await expect(actions.getByRole('button', { name: '繼續匯入' })).toBeVisible()
    await actions.getByRole('button', { name: '稍後再處理' }).click()
    await expect(page.getByTestId('pending-imports')).toContainText('待編輯標籤')
    expect(calls.some(call => call.endpoint === 'delete')).toBe(false)
})

test('deleting from the list needs a second confirmation', async ({ page }) => {
    const { calls } = await mockImport(page, [baseSession('tags_edited')])
    await page.goto('/new')
    const list = page.getByTestId('pending-imports')
    await list.getByRole('button', { name: '刪除 晴天.flac' }).click()
    expect(calls.some(call => call.endpoint === 'delete')).toBe(false)
    await list.getByRole('button', { name: '確定刪除' }).click()
    await expect(list).toHaveCount(0)
    expect(calls.find(call => call.endpoint === 'delete')?.body).toEqual({ file_id: 'f1' })
})

test('leaving while the tag editor is open asks first', async ({ page }) => {
    await mockImport(page, [baseSession('tags_extracted')])
    await page.goto('/new')
    await page.getByRole('button', { name: '繼續匯入 晴天.flac' }).click()
    await expect(page.getByPlaceholder('歌曲標題')).toBeVisible()
    const message = new Promise<string>(resolve => page.once('dialog', dialog => { resolve(dialog.message()); dialog.dismiss() }))
    // 對話框的遮罩蓋住了導覽列，直接對連結送出 click 事件觸發站內導覽
    await page.getByRole('banner').getByRole('link', { name: '歌曲管理' }).dispatchEvent('click')
    expect(await message).toContain('標籤尚未儲存')
    await expect(page.getByPlaceholder('歌曲標題')).toBeVisible()
})
