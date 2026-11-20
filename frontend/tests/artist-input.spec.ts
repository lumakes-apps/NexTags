import { expect, test, type Page } from '@playwright/test'

const directory = [
    { name: '周杰倫', sort: 'zhoujielun', roles: { artist: 5, composer: 2 } },
    { name: '蔡依林', sort: 'caiyilin', roles: { albumartist: 3 } },
    { name: '周興哲', sort: 'zhouxingzhe', roles: { composer: 1 } },
]

async function openEditor(page: Page, overrides: Record<string, string> = {}) {
    const song = {
        Title: '晴天', Artist: '周杰倫', SortArtist: 'zhoujielun', Album: '葉惠美',
        MainFolder: 'B 人聲', FilePath: '/Music/B 人聲/Music/周杰倫/葉惠美/03 - 晴天.flac',
        Genre: [], Language: 'chi', Favorite: 'False', Cover: '', ...overrides,
    }
    const saves: Record<string, string>[] = []
    await page.route('**/api/**', async route => {
        const endpoint = new URL(route.request().url()).pathname.replace('/api/', '')
        let response: unknown = { success: true }
        if (endpoint === 'audios') {
            response = { audio_files: [song], allow_folders: ['B 人聲'], supported_languages: { chi: '中文' },
                pagination: { current_page: 1, total_pages: 1, total_count: 1 } }
        } else if (endpoint === 'tags/languages') {
            response = { chi: '中文' }
        } else if (endpoint === 'tags/tags') {
            response = []
        } else if (endpoint === 'tags/artists') {
            response = directory
        } else if (endpoint === 'audios/pending-moves') {
            response = []
        } else if (endpoint === 'audios/move-preview') {
            response = { proposal: null }
        } else if (endpoint === 'tools/pinyin') {
            response = { result: `py-${route.request().postDataJSON().text}` }
        } else if (endpoint === 'audios/update') {
            saves.push(route.request().postDataJSON().tags[0])
            response = { success: true, message: '標籤已儲存' }
        }
        await route.fulfill({ json: response })
    })
    await page.goto('/')
    await page.locator('tbody tr').getByRole('button').click()
    await expect(page.getByRole('heading', { name: '編輯標籤' })).toBeVisible()
    return saves
}

const field = (page: Page, label: string) => page.locator('div.relative').filter({ has: page.getByText(label, { exact: true }) })
const chips = (page: Page, label: string) => field(page, label).getByTestId('artist-chip')
const names = (page: Page, label: string) => field(page, label).getByTestId('artist-chip-name')
const input = (page: Page, label: string) => field(page, label).getByRole('combobox')
const preview = (page: Page, label: string) => field(page, label).getByTestId('artist-sort-preview')

test('existing artists are gray and keep the song sort name', async ({ page }) => {
    await openEditor(page)
    await expect(names(page, 'Artist')).toHaveText(['周杰倫'])
    await expect(chips(page, 'Artist').first()).toHaveAttribute('data-new', 'false')
    await expect(preview(page, 'Artist')).toHaveText('排序：zhoujielun')
})

test('suggestions match pinyin and pick an existing artist', async ({ page }) => {
    const saves = await openEditor(page)
    await input(page, 'Artist').fill('zhou')
    const options = field(page, 'Artist').getByRole('option')
    // 周杰倫 已選，不再列出；周興哲 以拼音吻合
    await expect(options).toHaveText(['新增「zhou」新歌手', /周興哲/])
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(names(page, 'Artist')).toHaveText(['周杰倫', '周興哲'])
    await expect(chips(page, 'Artist').nth(1)).toHaveAttribute('data-new', 'false')
    await expect(preview(page, 'Artist')).toHaveText('排序：zhoujielun; zhouxingzhe')
    await page.getByRole('button', { name: '保存變更' }).click()
    await expect.poll(() => saves.length).toBe(1)
    expect(saves[0]).toMatchObject({ artist: '周杰倫;周興哲', artistsort: 'zhoujielun;zhouxingzhe' })
})

test('a new artist is green and gets a pinyin sort name', async ({ page }) => {
    const saves = await openEditor(page)
    await input(page, 'Artist').fill('新歌手')
    await page.keyboard.press('Enter')
    await expect(chips(page, 'Artist').nth(1)).toHaveAttribute('data-new', 'true')
    await expect(preview(page, 'Artist')).toHaveText('排序：zhoujielun; py-新歌手')
    await page.getByRole('button', { name: '保存變更' }).click()
    await expect.poll(() => saves.length).toBe(1)
    expect(saves[0]).toMatchObject({ artist: '周杰倫;新歌手', artistsort: 'zhoujielun;py-新歌手' })
})

test('same-role names are suggested first when the input is empty', async ({ page }) => {
    await openEditor(page)
    await input(page, 'Composer').focus()
    await expect(field(page, 'Composer').getByRole('option')).toHaveText([/周杰倫/, /周興哲/, /蔡依林/])
})

test('semicolons split names, and chips can be removed', async ({ page }) => {
    await openEditor(page)
    await input(page, 'Performer').pressSequentially('甲;乙；')
    await expect(names(page, 'Performer')).toHaveText(['甲', '乙'])
    await page.keyboard.press('Backspace')
    await expect(names(page, 'Performer')).toHaveText(['甲'])
    await field(page, 'Performer').getByRole('button', { name: '從 Performer 移除 甲', exact: true }).click()
    await expect(chips(page, 'Performer')).toHaveCount(0)
})

test('dragging a chip changes the saved order', async ({ page }) => {
    const saves = await openEditor(page, { Artist: '周杰倫;蔡依林', SortArtist: 'zhoujielun;caiyilin' })
    const [first, second] = [chips(page, 'Artist').nth(0), chips(page, 'Artist').nth(1)]
    // 讓標籤離開底部的「保存變更」列，滑鼠才按得到
    await field(page, 'Artist').evaluate(element => element.scrollIntoView({ block: 'center' }))
    const from = await second.boundingBox()
    const to = await first.boundingBox()
    await page.mouse.move(from!.x + 10, from!.y + from!.height / 2)
    await page.mouse.down()
    await page.mouse.move(from!.x + 20, from!.y + from!.height / 2, { steps: 3 })
    await page.mouse.move(to!.x + 5, to!.y + to!.height / 2, { steps: 15 })
    await page.mouse.up()
    await expect(names(page, 'Artist')).toHaveText(['蔡依林', '周杰倫'])
    await expect(preview(page, 'Artist')).toHaveText('排序：caiyilin; zhoujielun')
    // @dnd-kit 放開後 50ms 內會吞掉點擊（避免拖曳結束誤觸），真人操作不會這麼快
    await page.waitForTimeout(100)
    await page.getByRole('button', { name: '保存變更' }).click()
    await expect.poll(() => saves.length).toBe(1)
    expect(saves[0]).toMatchObject({ artist: '蔡依林;周杰倫', artistsort: 'caiyilin;zhoujielun' })
})

test('escape discards typed text, leaving the field keeps it', async ({ page }) => {
    await openEditor(page)
    await input(page, 'Artist').fill('打錯的字')
    await page.keyboard.press('Escape')
    await input(page, 'Composer').focus()
    await expect(names(page, 'Artist')).toHaveText(['周杰倫'])
    await input(page, 'Artist').fill('沒按 Enter')
    await input(page, 'Composer').focus()
    await expect(names(page, 'Artist')).toHaveText(['周杰倫', '沒按 Enter'])
})

test('chips can be reordered with the keyboard and moves are announced in Chinese', async ({ page }) => {
    const saves = await openEditor(page, { Artist: '周杰倫;蔡依林', SortArtist: 'zhoujielun;caiyilin' })
    const handle = field(page, 'Artist').getByRole('button', { name: '拖曳排序 Artist 的 蔡依林' })
    await handle.focus()
    await page.keyboard.press('Space')
    await expect(field(page, 'Artist').getByRole('status')).toContainText('已拿起 蔡依林，目前在第 2 位')
    // dnd-kit 拿起後以 setTimeout(0) 才開始監聽方向鍵；在頁面等一次 setTimeout(0)，排在它之後
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)))
    await page.keyboard.press('ArrowLeft')
    // 等移動被播報（代表 dnd-kit 已處理這一步）再放下
    await expect(field(page, 'Artist').getByRole('status')).toContainText('蔡依林 移到第 1 位')
    await page.keyboard.press('Space')
    await expect(names(page, 'Artist')).toHaveText(['蔡依林', '周杰倫'])
    await expect(field(page, 'Artist').getByRole('status')).toContainText('已放下 蔡依林，現在在第 1 位')
    await page.getByRole('button', { name: '保存變更' }).click()
    await expect.poll(() => saves.length).toBe(1)
    expect(saves[0]).toMatchObject({ artist: '蔡依林;周杰倫', artistsort: 'caiyilin;zhoujielun' })
})

test('new artists are announced as new to screen readers', async ({ page }) => {
    await openEditor(page)
    await input(page, 'Artist').fill('新歌手')
    await page.keyboard.press('Enter')
    await expect(chips(page, 'Artist').nth(1)).toContainText('（新歌手）')
    await expect(input(page, 'Artist')).toHaveAccessibleDescription(/排序：zhoujielun; py-新歌手/)
})

test('the suggestion list closes after picking so it does not cover the next field', async ({ page }) => {
    await openEditor(page)
    const options = field(page, 'Artist').getByRole('option')
    await input(page, 'Artist').fill('新歌手')
    await page.keyboard.press('Enter')
    await expect(options).toHaveCount(0)
    await input(page, 'Artist').pressSequentially('蔡')
    await expect(options.first()).toBeVisible()
    await page.keyboard.press('Escape')
    await page.keyboard.press('ArrowDown')
    await expect(options.first()).toBeVisible()
    await page.keyboard.press('Escape')
    await input(page, 'Artist').click()
    await expect(options.first()).toBeVisible()
})

test('title and album sort names follow the text automatically', async ({ page }) => {
    const saves = await openEditor(page, { SortTitle: 'qingtian', Album: '葉惠美', SortAlbum: '' })
    const titleSort = page.getByTestId('title-sort-preview')
    const albumSort = page.getByTestId('album-sort-preview')
    // 標題沒改：沿用原本的排序標題；專輯原本沒有排序名稱：自動產生
    await expect(titleSort).toHaveText('排序：qingtian')
    await expect(albumSort).toHaveText('排序：py-葉惠美')
    await expect(page.getByPlaceholder('排序標題')).toHaveCount(0)
    await page.getByPlaceholder('歌曲標題', { exact: true }).fill('雨天')
    await expect(titleSort).toHaveText('排序：py-雨天')
    await page.getByRole('button', { name: '保存變更' }).click()
    await expect.poll(() => saves.length).toBe(1)
    expect(saves[0]).toMatchObject({ title: '雨天', titlesort: 'py-雨天', album: '葉惠美', albumsort: 'py-葉惠美' })
})
