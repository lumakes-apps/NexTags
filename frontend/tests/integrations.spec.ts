import { expect, test, type Page } from '@playwright/test'

const field = (name: string, label: string, kind: string, def: unknown = null, options: string[][] = [], group = '設定') => ({ name, label, kind, default: def, help: '', options, group })

function integrationsState(options: { aiAvailable?: boolean; aiEnabled?: boolean; favoritesSync?: boolean; initialized?: boolean } = {}) {
    return [
        {
            key: 'navidrome', name: 'Navidrome', description: 'Navidrome 整合', enabled: true, available: true,
            fields: [field('base_url', 'Navidrome 網址', 'url', '', [], '連線'), field('username', '帳號', 'text', '', [], '連線'),
                field('password', '密碼', 'secret', null, [], '連線'), field('refresh_hook', '通知 hook', 'bool', true, [], '掃描通知'),
                field('sync_mode', '同步方式', 'select', 'two_way', [['two_way', '雙向'], ['local', '以 NexTags 為準'], ['remote', '以 Navidrome 為準']], '最愛同步'),
                field('favorites_sync', '自動同步', 'bool', false, [], '最愛同步')],
            settings: { refresh_hook: true, base_url: 'http://navidrome:4533', username: 'me', favorites_sync: !!options.favoritesSync, sync_mode: 'two_way' },
            secrets: { password: 'database' }, master_key_configured: true,
            status: { scan: { ok: true, request_requested_at: '2026-11-20T00:00:00+00:00', completed_at: '2026-11-20T00:01:00+00:00' },
                favorites: { initialized: !!options.initialized, last: null } },
        },
        {
            key: 'ai_lyrics', name: 'AI 歌詞整理', description: 'AI', enabled: options.aiEnabled ?? true, available: !!options.aiAvailable,
            fields: [field('api_key', 'Anthropic API 金鑰', 'secret', null, [], '金鑰')], settings: {},
            secrets: { api_key: options.aiAvailable ? 'database' : null }, master_key_configured: true, status: {},
        },
    ]
}

async function mockApi(page: Page, options: Parameters<typeof integrationsState>[0] = {}) {
    const calls = { puts: [] as { url: string; body: Record<string, unknown> }[], syncs: [] as Record<string, unknown>[], previews: 0 }
    const state = integrationsState(options)
    await page.route('**/api/**', async route => {
        const url = new URL(route.request().url())
        const endpoint = url.pathname.replace('/api/', '')
        const method = route.request().method()
        let response: unknown = { success: true }
        if (endpoint === 'integrations') {
            response = state
        } else if (endpoint.startsWith('integrations/') && method === 'PUT') {
            calls.puts.push({ url: endpoint, body: route.request().postDataJSON() })
            response = state.find(item => endpoint.endsWith(item.key))
        } else if (endpoint === 'integrations/navidrome/favorites/preview') {
            calls.previews += 1
            response = { mode: 'two_way', initialized: false, matched_songs: 9, local_favorites: 1, remote_favorites: 2, only_local: [], only_remote: [],
                only_local_count: 1, only_remote_count: 2, not_in_navidrome: 0, not_in_nextags: 0, plan: { star: 1, unstar: 0, favorite: 2, unfavorite: 0 } }
        } else if (endpoint === 'integrations/navidrome/favorites/sync') {
            calls.syncs.push(route.request().postDataJSON())
            response = { ok: true, started_at: '', finished_at: '', applied: { star: 1, unstar: 0, favorite: 2, unfavorite: 0 } }
        } else if (endpoint === 'config') {
            response = { success: true, data: { allow_folders: [], supported_tags: [], supported_languages: {} } }
        } else if (endpoint === 'prompts/lyrics') {
            response = { text: 'p', default_text: 'p', revision: 1, updated_at: null }
        } else if (endpoint === 'audios') {
            response = { audio_files: [{ Title: '晴天', Artist: '周杰倫', Album: '葉惠美', MainFolder: 'B 人聲',
                FilePath: '/Music/B 人聲/Music/周杰倫/葉惠美/03 - 晴天.flac', Genre: [], Language: 'chi', Favorite: 'False', Cover: '', Lyrics: '[00:00.00]歌詞' }],
                allow_folders: ['B 人聲'], supported_languages: {}, pagination: { current_page: 1, total_pages: 1, total_count: 1 } }
        } else if (endpoint === 'tags/tags' || endpoint === 'tags/artists' || endpoint === 'audios/pending-moves') {
            response = []
        } else if (endpoint === 'tags/languages') {
            response = {}
        } else if (endpoint === 'tools/lyric') {
            await route.fulfill({ status: 400, json: { detail: '尚未設定 Anthropic API 金鑰，請到設定的「整合」填寫' } })
            return
        }
        await route.fulfill({ json: response })
    })
    return calls
}

test('secrets are only sent when typed and can be cleared', async ({ page }) => {
    const calls = await mockApi(page)
    await page.goto('/settings?tab=integrations&integration=navidrome')
    const card = page.getByTestId('integration-navidrome')
    const password = card.getByLabel('密碼', { exact: true })
    const save = card.getByRole('button', { name: '儲存連線' })
    await expect(password).toHaveAttribute('placeholder', '已設定，留空則不變')
    await expect(password).toHaveValue('')
    await expect(save).toBeDisabled() // 沒有修改時不能儲存
    await card.getByLabel('帳號').fill('someone')
    await save.click()
    await expect.poll(() => calls.puts.length).toBe(1)
    expect(calls.puts[0].body).toEqual({ settings: { base_url: 'http://navidrome:4533', username: 'someone' } })
    await password.fill('new-pass')
    await save.click()
    await expect.poll(() => calls.puts.length).toBe(2)
    expect(calls.puts[1].body.secrets).toEqual({ password: 'new-pass' })
    await card.getByRole('button', { name: '清除密碼' }).click()
    await expect.poll(() => calls.puts.length).toBe(3)
    expect(calls.puts[2].body).toEqual({ secrets: { password: null } })
})

test('favorites sync controls are visible right away and the mode applies immediately', async ({ page }) => {
    const calls = await mockApi(page)
    await page.goto('/settings?tab=integrations&integration=navidrome')
    const card = page.getByTestId('integration-navidrome')
    await expect(page.getByTestId('favorites-mode')).toContainText('都會同步到另一邊')
    await card.getByLabel('同步方式').selectOption('remote')
    await expect.poll(() => calls.puts.length).toBe(1)
    expect(calls.puts[0].body).toEqual({ settings: { sync_mode: 'remote' } })

    const start = card.getByRole('button', { name: '確認並開始同步' })
    await expect(start).toBeDisabled()
    await card.getByRole('button', { name: '預覽差異' }).click()
    await expect(card.getByTestId('favorites-preview')).toContainText('NexTags 加入 2')
    await start.click()
    await expect.poll(() => calls.syncs.length).toBe(1)
    expect(calls.syncs[0]).toEqual({ confirm: true })
})

test('the sidebar lists integrations, opens one from the overview and can collapse', async ({ page }) => {
    await mockApi(page)
    await page.goto('/settings')
    const nav = page.getByRole('tablist', { name: '設定項目' })
    await nav.getByRole('tab', { name: '整合', exact: true }).click()
    await page.getByRole('button', { name: /^Navidrome/ }).click()
    await expect(page.getByTestId('integration-navidrome')).toBeVisible()
    await expect(page).toHaveURL(/tab=integrations&integration=navidrome/)
    await expect(nav.getByRole('tab', { name: /AI 歌詞整理/ })).toBeVisible()
    await nav.getByRole('button', { name: '收合整合清單' }).click()
    await expect(nav.getByRole('tab', { name: /AI 歌詞整理/ })).toHaveCount(0)
})

test('the AI lyrics button is hidden when the integration is unavailable', async ({ page }) => {
    await mockApi(page, { aiAvailable: false })
    await page.goto('/')
    await page.locator('tbody tr').getByRole('button').click()
    await expect(page.getByRole('heading', { name: '編輯標籤' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'AI 整理歌詞' })).toHaveCount(0)
})

test('AI lyrics failures are shown instead of failing silently', async ({ page }) => {
    await mockApi(page, { aiAvailable: true })
    await page.goto('/')
    await page.locator('tbody tr').getByRole('button').click()
    await page.getByRole('button', { name: 'AI 整理歌詞' }).click()
    await expect(page.getByRole('alert').filter({ hasText: '尚未設定 Anthropic API 金鑰' })).toBeVisible()
    await expect(page.locator("textarea[placeholder='輸入歌詞...']")).toHaveValue('[00:00.00]歌詞')
})

test('the lyrics prompt lives in the AI lyrics integration and stays editable while it is disabled', async ({ page }) => {
    await mockApi(page, { aiEnabled: false, aiAvailable: true })
    await page.goto('/settings?tab=prompts')
    await expect(page).toHaveURL(/tab=integrations&integration=ai_lyrics/)
    const nav = page.getByRole('tablist', { name: '設定項目' })
    await expect(nav.getByRole('tab', { name: '提示詞管理' })).toHaveCount(0)
    await expect(nav.getByRole('tab', { name: /AI 歌詞整理/ })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('integration-ai_lyrics')).toBeVisible()

    const editor = page.getByLabel('提示詞', { exact: true })
    await expect(editor).toBeEnabled()
    await editor.fill('新的提示詞')
    await expect(page.getByRole('button', { name: '儲存提示詞' })).toBeEnabled()

    await page.getByLabel('測試歌詞（原文）').fill('[00:01.00]歌詞')
    const run = page.getByRole('button', { name: '試跑', exact: true })
    await expect(run).toBeDisabled()
    await expect(run).toHaveAccessibleDescription('啟用 AI 歌詞整理後才能試跑')
})
