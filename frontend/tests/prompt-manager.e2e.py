import functools
import re
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
DEFAULT = (ROOT / 'backend/app/prompts/lyrics_cleanup.txt').read_text()
state = {'text': DEFAULT, 'default_text': DEFAULT, 'revision': 1, 'updated_at': '2026-11-19T16:00:00.000Z'}
flags = {'save_failure': False, 'preview_failure': False}
config = {'supported_tags': ['測試'], 'supported_languages': {'zh': '中文'}, 'allow_folders': ['/Music']}
requests = []


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if urlparse(self.path).path in ('/settings', '/'):
            self.path = '/index.html'
        super().do_GET()

    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(ROOT / 'frontend/dist')))
worker = threading.Thread(target=server.serve_forever)
worker.start()


def api(route):
    request = route.request
    path = urlparse(request.url).path.rstrip('/')
    payload = request.post_data_json if request.method in ('POST', 'PUT') else None
    requests.append((request.method, path, payload))
    status = 200
    if path == '/api/prompts/lyrics' and request.method == 'GET':
        result = dict(state)
    elif path == '/api/prompts/lyrics' and request.method == 'PUT':
        if flags['save_failure']:
            status, result = 502, {'detail': '儲存失敗，草稿保留'}
        elif payload['expected_revision'] != state['revision']:
            status, result = 409, {'detail': '提示詞已被更新，請先載入最新版本再儲存；草稿仍保留'}
        else:
            state.update(text=payload['text'], revision=state['revision'] + 1)
            result = dict(state)
    elif path == '/api/prompts/lyrics/preview':
        if flags['preview_failure']:
            status, result = 502, {'detail': 'AI 試跑失敗，請稍後重試；提示詞未儲存'}
        else:
            result = {'result': '[00:01.12]測試整理結果'}
    elif path == '/api/config' and request.method == 'GET':
        result = {'success': True, 'data': config}
    elif path == '/api/integrations' and request.method == 'GET':
        # 提示詞放在「整合 › AI 歌詞整理」底下
        result = [{
            'key': 'ai_lyrics', 'name': 'AI 歌詞整理', 'description': 'AI', 'enabled': True, 'available': True,
            'fields': [{'name': 'api_key', 'label': 'Anthropic API 金鑰', 'kind': 'secret', 'default': None,
                        'help': '', 'options': [], 'group': '金鑰'}],
            'settings': {}, 'secrets': {'api_key': 'database'}, 'master_key_configured': True, 'status': {},
        }]
    else:
        raise AssertionError(f'Unexpected API request: {request.method} {path}')
    route.fulfill(status=status, content_type='application/json', body=json.dumps(result))


def import_file(page, data):
    page.locator('#import-config').set_input_files({
        'name': 'settings.json', 'mimeType': 'application/json',
        'buffer': json.dumps(data).encode(),
    })


try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width': 1280, 'height': 1000})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route('**/api/**', api)
        # 舊連結 ?tab=prompts 轉到 AI 歌詞整理
        page.goto(f'http://127.0.0.1:{server.server_port}/settings?tab=prompts')
        expect(page.get_by_test_id('integration-ai_lyrics')).to_be_visible()
        expect(page).to_have_url(re.compile(r'tab=integrations&integration=ai_lyrics'))
        expect(page.get_by_role('tab', name='提示詞管理')).to_have_count(0)
        editor = page.get_by_label('提示詞', exact=True)
        expect(editor).to_have_value(DEFAULT)
        expect(page.get_by_role('button', name='儲存提示詞', exact=True)).to_be_disabled()
        editor.fill('未儲存測試草稿\n')
        page.get_by_label('測試歌詞（原文）').fill('[00:01.123]Original')
        page.get_by_role('button', name='試跑', exact=True).click()
        expect(page.get_by_text('[00:01.12]測試整理結果', exact=True)).to_be_visible()
        assert state['revision'] == 1 and state['text'] == DEFAULT
        page.get_by_role('tab', name='支援的標籤').click()
        page.get_by_role('tab', name='AI 歌詞整理').click()
        expect(editor).to_have_value('未儲存測試草稿\n')
        state.update(text='其他頁面儲存內容', revision=2)
        page.get_by_role('button', name='儲存提示詞', exact=True).click()
        expect(page.get_by_role('alert')).to_contain_text('提示詞已被更新')
        expect(editor).to_have_value('未儲存測試草稿\n')
        page.get_by_role('button', name='載入最新版本（保留草稿）').click()
        expect(page.get_by_text('目前版本 2', exact=False)).to_be_visible()
        expect(editor).to_have_value('未儲存測試草稿\n')
        page.get_by_role('button', name='儲存提示詞', exact=True).click()
        expect(page.get_by_role('button', name='儲存提示詞', exact=True)).to_be_disabled()
        assert state['revision'] == 3 and state['text'] == '未儲存測試草稿\n'
        page.get_by_role('button', name='載入預設', exact=True).click()
        expect(editor).to_have_value(DEFAULT)
        assert state['revision'] == 3
        page.get_by_role('button', name='捨棄修改', exact=True).click()
        expect(editor).to_have_value(state['text'])
        flags['save_failure'] = True
        editor.fill('失敗時保留的草稿')
        page.get_by_role('button', name='儲存提示詞', exact=True).click()
        expect(page.get_by_role('alert')).to_have_text('儲存失敗，草稿保留')
        expect(editor).to_have_value('失敗時保留的草稿')
        assert state['revision'] == 3
        flags['save_failure'] = False
        flags['preview_failure'] = True
        page.get_by_role('button', name='試跑', exact=True).click()
        expect(page.get_by_role('alert')).to_contain_text('AI 試跑失敗')
        expect(page.get_by_label('測試歌詞（原文）')).to_have_value('[00:01.123]Original')
        expect(editor).to_have_value('失敗時保留的草稿')
        assert state['revision'] == 3
        page.once('dialog', lambda dialog: dialog.dismiss())
        page.get_by_role('link', name='音樂管理系統').click()
        expect(editor).to_have_value('失敗時保留的草稿')
        assert '/settings' in page.url
        page.get_by_role('tab', name='支援的標籤').click()
        import_file(page, {**config, 'ai_lyrics_prompt': '匯入提示詞\n'})
        expect(editor).to_have_value('匯入提示詞\n')
        expect(editor).to_be_visible()  # 匯入後切到 AI 歌詞整理
        expect(page).to_have_url(re.compile(r'integration=ai_lyrics'))
        assert state['revision'] == 3
        page.get_by_role('button', name='儲存提示詞', exact=True).click()
        expect(page.get_by_role('button', name='儲存提示詞', exact=True)).to_be_disabled()
        assert state['text'] == '匯入提示詞\n' and state['revision'] == 4
        editor.fill('保留舊檔沒有的草稿')
        import_file(page, config)
        expect(editor).to_have_value('保留舊檔沒有的草稿')
        import_file(page, {**config, 'ai_lyrics_prompt': {'text': '無效物件'}})
        expect(editor).to_have_value('保留舊檔沒有的草稿')
        page.get_by_role('button', name='配置管理').click()
        with page.expect_download() as download_info:
            page.get_by_role('menuitem', name='匯出設定').click()
        exported = json.loads(Path(download_info.value.path()).read_text())
        assert exported['version'] == '1.1'
        assert exported['ai_lyrics_prompt'] == '保留舊檔沒有的草稿'
        assert 'revision' not in exported
        editor.fill('x' * 20_001)
        expect(page.get_by_role('button', name='儲存提示詞', exact=True)).to_be_disabled()
        editor.fill(' \n')
        expect(page.get_by_role('button', name='儲存提示詞', exact=True)).to_be_disabled()
        page.get_by_role('button', name='捨棄修改', exact=True).click()
        expect(editor).to_have_value(state['text'])
        page.set_viewport_size({'width': 390, 'height': 844})
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        assert not errors, errors
        assert not any(method == 'POST' and path == '/api/config' for method, path, _ in requests)
        print('PASS: UI preview isolation, tab persistence, conflict/reload/save, defaults, failures, navigation guard, legacy/new import-export, validation, mobile layout; no page errors.')
        browser.close()
finally:
    server.shutdown()
    worker.join()
    server.server_close()
