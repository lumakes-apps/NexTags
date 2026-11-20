import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
    await page.route('**/api/**', async route => {
        const endpoint = new URL(route.request().url()).pathname.replace('/api/', '').replace(/\/$/, '')
        const responses: Record<string, unknown> = {
            config: { success: true, data: { supported_tags: [], supported_languages: {}, allow_folders: [] } },
            'prompts/lyrics': { text: 'p\n'.repeat(80), default_text: 'p', revision: 1, updated_at: '2026-11-21T00:00:00Z' },
            integrations: [],
        }
        await route.fulfill({ json: responses[endpoint] ?? { success: true } })
    })
})

test('the header shows the NexTags brand and stays at the top while scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 600 })
    await page.goto('/settings?tab=integrations&integration=ai_lyrics')
    await expect(page).toHaveTitle('NexTags')
    const header = page.getByRole('banner')
    const brand = header.getByRole('link', { name: 'NexTags' })
    await expect(brand).toBeVisible()

    await page.mouse.wheel(0, 2000)
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(200)
    expect((await header.boundingBox())!.y).toBe(0)
    await expect(brand).toBeInViewport()

    // 只顯示圖示的連結也要有名稱；目前頁面標示 aria-current
    const nav = header.getByRole('navigation', { name: '主要功能' })
    await expect(nav.getByRole('link', { name: '系統設定' })).toHaveAttribute('aria-current', 'page')
    await expect(nav.getByRole('link', { name: '播放清單' })).not.toHaveAttribute('aria-current', 'page')

    await brand.click()
    await expect(page).toHaveURL(/\/$/)
})
