import { useCallback, useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  fetchIntegrations,
  previewFavorites,
  saveIntegration,
  syncFavorites,
  testIntegration,
  type FavoritesPreview,
  type Integration,
  type IntegrationField,
  type SyncStrategy,
} from '@/lib/integrations';

const errorText = (error: unknown) => (error instanceof Error ? error.message : '發生錯誤，請重試');
const formatTime = (value?: string) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-TW');
};

function FieldInput({ field, value, secret, onChange }: {
  field: IntegrationField;
  value: unknown;
  secret: 'env' | 'database' | null | undefined;
  onChange: (value: unknown) => void;
}) {
  const id = useId();
  const help = field.help && <p id={`${id}-help`} className="text-xs text-gray-500 mt-1">{field.help}</p>;
  if (field.kind === 'bool') {
    return (
      <div className="flex items-start justify-between gap-4">
        <div>
          <label htmlFor={id} className="text-sm text-gray-800">{field.label}</label>
          {help}
        </div>
        <Switch id={id} checked={Boolean(value)} onCheckedChange={onChange} aria-describedby={field.help ? `${id}-help` : undefined} />
      </div>
    );
  }
  const secretHint = secret === 'env' ? '由環境變數提供' : secret === 'database' ? '已設定，留空則不變' : '尚未設定';
  return (
    <div>
      <label htmlFor={id} className="text-sm text-gray-800 block mb-1">{field.label}</label>
      <Input
        id={id}
        type={field.kind === 'secret' ? 'password' : field.kind === 'number' ? 'number' : 'text'}
        autoComplete={field.kind === 'secret' ? 'new-password' : 'off'}
        value={String(value ?? '')}
        placeholder={field.kind === 'secret' ? secretHint : ''}
        disabled={field.kind === 'secret' && secret === 'env'}
        onChange={event => onChange(field.kind === 'number' ? Number(event.target.value) : event.target.value)}
        aria-describedby={field.help ? `${id}-help` : undefined}
      />
      {help}
    </div>
  );
}

function FavoritesSync({ integration, onChanged }: { integration: Integration; onChanged: () => void }) {
  const [strategy, setStrategy] = useState<SyncStrategy>('union');
  const [preview, setPreview] = useState<FavoritesPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const initialized = integration.status.favorites?.initialized ?? false;
  const last = integration.status.favorites?.last;

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="border-t pt-4 space-y-3" aria-label="最愛同步">
      <h4 className="font-medium text-gray-900">最愛同步</h4>
      <p className="text-sm text-gray-600">
        NexTags 的 FAVORITE 標籤 ↔ Navidrome 的喜愛。之後的同步只把「上次同步後有改動的那一邊」帶到另一邊。
      </p>
      {last && (
        <p className="text-sm text-gray-600" data-testid="favorites-last">
          上次同步：{formatTime(last.finished_at)}，{last.ok ? '成功' : `失敗：${last.error ?? last.errors?.join('、')}`}
          {last.applied && `（Navidrome 加入 ${last.applied.star}、取消 ${last.applied.unstar}；NexTags 加入 ${last.applied.favorite}、取消 ${last.applied.unfavorite}）`}
        </p>
      )}
      {!initialized && (
        <fieldset className="space-y-2">
          <legend className="text-sm text-gray-800">初次同步方式</legend>
          {([
            ['union', '合併：任一邊是最愛就設為最愛（建議）'],
            ['local', '以 NexTags 為準：Navidrome 改成跟 NexTags 一樣'],
            ['remote', '以 Navidrome 為準：NexTags 改成跟 Navidrome 一樣（會改寫音檔標籤）'],
          ] as const).map(([value, label]) => (
            <label key={value} className="flex items-center gap-2 text-sm">
              <input type="radio" name="favorites-strategy" value={value} checked={strategy === value}
                onChange={() => { setStrategy(value); setPreview(null); }} />
              {label}
            </label>
          ))}
        </fieldset>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy || !integration.available}
          onClick={() => run(async () => setPreview(await previewFavorites(strategy)))}>
          預覽差異
        </Button>
        <Button disabled={busy || !integration.available || (!initialized && !preview)}
          onClick={() => run(async () => {
            const result = await syncFavorites(initialized ? undefined : strategy);
            toast.success(`最愛同步完成：Navidrome 加入 ${result.applied?.star ?? 0}、取消 ${result.applied?.unstar ?? 0}；NexTags 加入 ${result.applied?.favorite ?? 0}、取消 ${result.applied?.unfavorite ?? 0}`);
            setPreview(null);
            onChanged();
          })}>
          {initialized ? '立即同步' : '開始初次同步'}
        </Button>
      </div>
      {!initialized && !preview && <p className="text-xs text-gray-500">初次同步前請先預覽差異，確認要修改的數量。</p>}
      {preview && (
        <div className="rounded-md bg-gray-50 p-3 text-sm space-y-1" data-testid="favorites-preview">
          <p>兩邊都有的歌曲 {preview.matched_songs} 首；NexTags 最愛 {preview.local_favorites} 首、Navidrome 喜愛 {preview.remote_favorites} 首。</p>
          <p>只在 NexTags 是最愛：{preview.only_local_count} 首；只在 Navidrome 是喜愛：{preview.only_remote_count} 首。</p>
          <p className="font-medium">
            同步後：Navidrome 加入 {preview.plan.star}、取消 {preview.plan.unstar}；NexTags 加入 {preview.plan.favorite}、取消 {preview.plan.unfavorite}（會改寫這些音檔的 FAVORITE 標籤）。
          </p>
          {(preview.not_in_navidrome > 0 || preview.not_in_nextags > 0) && (
            <p className="text-gray-500">
              對不上的歌曲不會同步：Navidrome 沒有 {preview.not_in_navidrome} 首、NexTags 沒有 {preview.not_in_nextags} 首（常見原因是尚未掃描或音樂庫名稱與資料夾不同）。
            </p>
          )}
        </div>
      )}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </section>
  );
}

function IntegrationCard({ integration, onChanged }: { integration: Integration; onChanged: () => void }) {
  const [values, setValues] = useState<Record<string, unknown>>(integration.settings);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const titleId = useId();

  useEffect(() => { setValues(integration.settings); }, [integration.settings]);

  const save = async (enabled?: boolean) => {
    setBusy(true);
    setError('');
    try {
      await saveIntegration(integration.key, { enabled, settings: values, secrets: Object.keys(secrets).length ? secrets : undefined });
      setSecrets({});
      toast.success(`${integration.name} 設定已儲存`);
      onChanged();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const clearSecret = async (name: string) => {
    setBusy(true);
    setError('');
    try {
      await saveIntegration(integration.key, { secrets: { [name]: null } });
      onChanged();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const scan = integration.status.scan;
  return (
    <section className="border rounded-xl p-4 space-y-4 bg-white" aria-labelledby={titleId} data-testid={`integration-${integration.key}`}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 id={titleId} className="font-semibold text-gray-900">{integration.name}</h3>
          <p className="text-sm text-gray-600 mt-1">{integration.description}</p>
        </div>
        <Switch aria-label={`啟用 ${integration.name}`} checked={integration.enabled} disabled={busy}
          onCheckedChange={checked => save(checked)} />
      </div>
      {integration.enabled && (
        <>
          <div className="space-y-3">
            {integration.fields.map(field => (
              <div key={field.name}>
                <FieldInput
                  field={field}
                  value={field.kind === 'secret' ? secrets[field.name] ?? '' : values[field.name]}
                  secret={integration.secrets[field.name]}
                  onChange={value => field.kind === 'secret'
                    ? setSecrets(prev => ({ ...prev, [field.name]: String(value) }))
                    : setValues(prev => ({ ...prev, [field.name]: value }))}
                />
                {field.kind === 'secret' && integration.secrets[field.name] === 'database' && (
                  <Button variant="outline" size="sm" className="mt-1" disabled={busy} onClick={() => clearSecret(field.name)}>
                    清除{field.label}
                  </Button>
                )}
              </div>
            ))}
            {integration.fields.some(field => field.kind === 'secret') && !integration.master_key_configured && (
              <p role="alert" className="text-sm text-amber-700">
                伺服器未設定 NEXTAGS_SECRET_KEY，無法儲存密鑰；請在 .env 設定後重新啟動，或改用環境變數提供。
              </p>
            )}
          </div>
          {scan !== undefined && (
            <p className="text-sm text-gray-600">
              最近一次 Navidrome 掃描：{scan ? `${formatTime(scan.completed_at)}（${scan.ok ? '成功' : '失敗'}）` : '尚未收到狀態，若未安裝 refresh hook 請關閉「移動檔案前等待 Navidrome 掃描」'}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="success" disabled={busy} onClick={() => save()}>儲存設定</Button>
            <Button variant="outline" disabled={busy}
              onClick={async () => { setTestResult(null); setTestResult(await testIntegration(integration.key).catch(error => ({ ok: false, message: errorText(error) }))); }}>
              測試連線
            </Button>
          </div>
          {testResult && (
            <p role="status" className={`text-sm ${testResult.ok ? 'text-green-700' : 'text-red-600'}`}>{testResult.message}</p>
          )}
          {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
          {integration.key === 'navidrome' && Boolean(integration.settings.favorites_sync) && (
            <FavoritesSync integration={integration} onChanged={onChanged} />
          )}
        </>
      )}
    </section>
  );
}

export default function IntegrationsPanel() {
  const [integrations, setIntegrations] = useState<Integration[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    fetchIntegrations()
      .then(list => { setIntegrations(list); setError(''); })
      .catch(error => setError(errorText(error)));
  }, []);

  useEffect(load, [load]);

  if (error) return <p role="alert" className="text-sm text-red-600">{error}</p>;
  if (!integrations) return <p className="text-sm text-gray-500">載入中…</p>;
  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">
        整合是可開關的外部連動。關閉後核心功能照常運作，只是不與該服務互動。密鑰加密儲存，只能寫入、不會回傳。
      </p>
      {integrations.map(integration => (
        <IntegrationCard key={integration.key} integration={integration} onChanged={load} />
      ))}
    </div>
  );
}
