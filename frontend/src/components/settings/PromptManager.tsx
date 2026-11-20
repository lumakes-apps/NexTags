import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { MAX_LYRIC_LENGTH, MAX_PROMPT_LENGTH, promptErrorMessage, type LyricsPrompt } from '@/lib/prompts';

interface Props {
  prompt: LyricsPrompt | null;
  draft: string;
  loading: boolean;
  loadError: string;
  onDraftChange: (text: string) => void;
  onSaved: (prompt: LyricsPrompt, submittedText: string) => void;
  onReload: () => void;
  /** 不能試跑的原因（整合停用或沒有金鑰）；空字串代表可以試跑。提示詞本身一律可編輯。 */
  previewBlockedReason?: string;
}

export default function PromptManager({ prompt, draft, loading, loadError, onDraftChange, onSaved, onReload, previewBlockedReason = '' }: Props) {
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [testLyric, setTestLyric] = useState('');
  const [preview, setPreview] = useState<{ text: string; lyric: string; result: string } | null>(null);
  const [error, setError] = useState('');
  const dirty = prompt !== null && draft !== prompt.text;
  const valid = !!draft.trim() && draft.length <= MAX_PROMPT_LENGTH;

  const save = async () => {
    if (!prompt || !valid || saving) return;
    const submittedText = draft;
    setSaving(true);
    setError('');
    try {
      const saved: LyricsPrompt = await api.put('prompts/lyrics', {
        text: submittedText,
        expected_revision: prompt.revision,
      });
      onSaved(saved, submittedText);
      toast.success('提示詞已儲存，下一次整理歌詞即生效');
    } catch (error) {
      setError(promptErrorMessage(error, '儲存提示詞失敗，草稿已保留，請重試'));
    } finally {
      setSaving(false);
    }
  };

  const runPreview = async () => {
    if (!valid || !testLyric.trim() || previewing || previewBlockedReason) return;
    const text = draft;
    const lyric = testLyric;
    setPreviewing(true);
    setError('');
    setPreview(null);
    try {
      const response = await api.post('prompts/lyrics/preview', { text, lyric });
      setPreview({ text, lyric, result: response.result });
    } catch (error) {
      setError(promptErrorMessage(error, '試跑失敗，提示詞與測試歌詞已保留，請重試'));
    } finally {
      setPreviewing(false);
    }
  };

  return (
    <section className="rounded-xl border bg-white p-4 space-y-5">
      <div>
        <h3 className="font-medium text-gray-900">提示詞</h3>
        <p className="text-sm text-gray-600 mt-1">歌曲標籤編輯與音樂匯入的 AI 歌詞整理都使用這份提示詞。停用整合時仍可先編輯、儲存。</p>
      </div>
      {loadError && <p role="alert" className="text-sm text-red-600">{loadError}</p>}
      <div className="flex flex-wrap items-center gap-3 text-sm text-gray-500">
        {prompt && <span>目前版本 {prompt.revision} · 更新於 {new Date(prompt.updated_at).toLocaleString('zh-TW')}</span>}
        <Button variant="outline" size="sm" onClick={onReload} disabled={loading || saving}>
          {loading ? '載入中...' : '載入最新版本（保留草稿）'}
        </Button>
      </div>
      <div className="space-y-2">
        <label htmlFor="lyrics-prompt" className="block text-sm font-medium">提示詞</label>
        <Textarea
          id="lyrics-prompt"
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          disabled={!prompt || loading || saving}
          rows={18}
          className="font-mono leading-relaxed"
          aria-describedby="lyrics-prompt-status"
        />
        <p id="lyrics-prompt-status" className={`text-sm ${valid || !prompt ? 'text-gray-500' : 'text-red-600'}`}>
          {draft.length.toLocaleString()} / {MAX_PROMPT_LENGTH.toLocaleString()} 字元
          {prompt && (dirty ? ' · 尚未儲存' : ' · 已儲存')}
          {prompt && !valid && ' · 提示詞不可空白或超過長度上限'}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="success" onClick={save} disabled={!prompt || !dirty || !valid || loading || saving}>
          {saving ? '儲存中...' : '儲存提示詞'}
        </Button>
        <Button variant="outline" onClick={() => { if (prompt) onDraftChange(prompt.text); }} disabled={!dirty || saving || loading}>
          捨棄修改
        </Button>
        <Button variant="outline" onClick={() => { if (prompt) onDraftChange(prompt.default_text); }} disabled={!prompt || saving || loading}>
          載入預設
        </Button>
      </div>
      <p className="text-sm text-gray-500">載入預設只會更新草稿；按「儲存提示詞」後才會套用。</p>
      {error && <p role="alert" className="text-sm text-red-600 whitespace-pre-wrap">{error}</p>}
      <div className="border-t pt-5 space-y-3">
        <h4 className="font-medium">試跑目前草稿</h4>
        <p className="text-sm text-gray-600">試跑會呼叫 AI 並產生費用。結果僅供預覽，提示詞與音樂檔都不會儲存。</p>
        <label htmlFor="test-lyric" className="block text-sm font-medium">測試歌詞（原文）</label>
        <Textarea id="test-lyric" value={testLyric} onChange={(event) => setTestLyric(event.target.value)} rows={6} placeholder="貼上少量歌詞來確認整理效果" />
        <Button variant="outline" onClick={runPreview} disabled={!prompt || loading || !valid || !testLyric.trim() || testLyric.length > MAX_LYRIC_LENGTH || previewing || !!previewBlockedReason}
          aria-describedby={previewBlockedReason ? 'preview-blocked' : undefined}>
          {previewing ? '試跑中...' : '試跑'}
        </Button>
        {previewBlockedReason && <p id="preview-blocked" className="text-sm text-gray-600">{previewBlockedReason}</p>}
        {testLyric.length > MAX_LYRIC_LENGTH && <p role="alert" className="text-sm text-red-600">測試歌詞最多 {MAX_LYRIC_LENGTH.toLocaleString()} 字元。</p>}
        {preview && (
          <div className="space-y-2">
            {(preview.text !== draft || preview.lyric !== testLyric) && <p className="text-sm text-amber-700">內容已變更，下方是先前試跑結果，請重新試跑。</p>}
            <div className="grid gap-4 md:grid-cols-2">
              <div><h5 className="text-sm font-medium mb-2">試跑原文</h5><pre className="rounded bg-gray-50 p-3 text-sm whitespace-pre-wrap break-words">{preview.lyric}</pre></div>
              <div><h5 className="text-sm font-medium mb-2">試跑結果</h5><pre className="rounded bg-gray-50 p-3 text-sm whitespace-pre-wrap break-words">{preview.result}</pre></div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
