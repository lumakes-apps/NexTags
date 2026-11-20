import { useEffect, useId, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  previewFavorites,
  saveIntegration,
  syncFavorites,
  testIntegration,
  type FavoritesPreview,
  type Integration,
  type IntegrationField,
  type SyncMode,
} from '@/lib/integrations';

const errorText = (error: unknown) => (error instanceof Error ? error.message : '發生錯誤，請重試');
const formatTime = (value?: string) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-TW');
};

/** 開關與下拉選單改了就立即儲存；文字類欄位由區塊的「儲存」一起送出 */
const appliesImmediately = (field: IntegrationField) => field.kind === 'bool' || field.kind === 'select';
/** 依賴另一個開關的欄位：開關關閉時停用 */
const DEPENDS_ON: Record<string, string> = { sync_interval_minutes: 'favorites_sync' };

// ---------------- 總覽 ----------------

export function IntegrationsOverview({ integrations, onOpen, onChanged }: {
  integrations: Integration[];
  onOpen: (key: string) => void;
  onChanged: () => void;
}) {
  const toggle = async (integration: Integration, enabled: boolean) => {
    try {
      await saveIntegration(integration.key, { enabled });
      toast.success(`${integration.name} 已${enabled ? '啟用' : '停用'}`);
      onChanged();
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-600">
        整合是可開關的外部連動。關閉後核心功能照常運作，只是不與該服務互動。點進去調整各自的設定。
      </p>
      <ul className="divide-y rounded-xl border bg-white">
        {integrations.map(integration => (
          <li key={integration.key} className="flex items-center gap-4 p-4">
            <button type="button" onClick={() => onOpen(integration.key)}
              className="flex flex-1 items-center gap-3 text-left min-w-0 rounded-md hover:bg-gray-50 -m-2 p-2">
              <span className="min-w-0">
                <span className="block font-medium text-gray-900">{integration.name}</span>
                <span className="block text-sm text-gray-600 truncate">{integration.description}</span>
                {integration.enabled && !integration.available && (
                  <span className="block text-xs text-amber-700 mt-1">已啟用，但設定尚未完成</span>
                )}
              </span>
              <ChevronRight className="ml-auto size-4 shrink-0 text-gray-400" aria-hidden="true" />
            </button>
            <Switch aria-label={`啟用 ${integration.name}`} checked={integration.enabled}
              onCheckedChange={checked => toggle(integration, checked)} />
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------- 欄位 ----------------

function FieldInput({ field, value, secret, disabled, onChange, trailing }: {
  field: IntegrationField;
  value: unknown;
  secret: 'database' | null | undefined;
  disabled: boolean;
  onChange: (value: unknown) => void;
  /** 放在輸入框右側的操作（例如清除已儲存的密鑰） */
  trailing?: ReactNode;
}) {
  const id = useId();
  const describedBy = field.help ? `${id}-help` : undefined;
  const help = field.help && <p id={`${id}-help`} className="text-xs text-gray-500 mt-1">{field.help}</p>;
  if (field.kind === 'bool') {
    return (
      <div className="flex items-start justify-between gap-4">
        <div>
          <label htmlFor={id} className="text-sm text-gray-800">{field.label}</label>
          {help}
        </div>
        <Switch id={id} checked={Boolean(value)} disabled={disabled} onCheckedChange={onChange} aria-describedby={describedBy} />
      </div>
    );
  }
  if (field.kind === 'select') {
    return (
      <div>
        <label htmlFor={id} className="text-sm text-gray-800 block mb-1">{field.label}</label>
        <select id={id} value={String(value ?? field.default ?? '')} disabled={disabled}
          onChange={event => onChange(event.target.value)} aria-describedby={describedBy}
          className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm disabled:opacity-60">
          {field.options.map(([optionValue, optionLabel]) => (
            <option key={optionValue} value={optionValue}>{optionLabel}</option>
          ))}
        </select>
        {help}
      </div>
    );
  }
  const secretHint = secret === 'database' ? '已設定，留空則不變' : '尚未設定';
  return (
    <div>
      <label htmlFor={id} className="text-sm text-gray-800 block mb-1">{field.label}</label>
      <div className="flex gap-2">
        <Input
          id={id}
          className="min-w-0 flex-1"
          type={field.kind === 'secret' ? 'password' : field.kind === 'number' ? 'number' : 'text'}
          autoComplete={field.kind === 'secret' ? 'new-password' : 'off'}
          value={String(value ?? '')}
          placeholder={field.kind === 'secret' ? secretHint : ''}
          disabled={disabled}
          onChange={event => onChange(field.kind === 'number' ? Number(event.target.value) : event.target.value)}
          aria-describedby={describedBy}
        />
        {trailing}
      </div>
      {help}
    </div>
  );
}

// ---------------- 最愛同步（Navidrome「最愛同步」區塊的操作） ----------------

const MODE_NOTES: Record<SyncMode, string> = {
  two_way: '在哪一邊加入或取消，都會同步到另一邊。第一次同步時，任一邊是最愛就設為最愛。',
  local: 'Navidrome 會跟著 NexTags；在 Navidrome 上的修改會在下次同步時被改回來。',
  remote: 'NexTags 會跟著 Navidrome（改寫音檔的 FAVORITE 標籤）；在 NexTags 上的修改會被改回來。',
};

function FavoritesSyncActions({ integration, connectionReady, onChanged }: {
  integration: Integration;
  connectionReady: boolean;
  onChanged: () => void;
}) {
  const mode = (integration.settings.sync_mode as SyncMode) ?? 'two_way';
  const [preview, setPreview] = useState<FavoritesPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const confirmed = integration.status.favorites?.initialized ?? false;
  const last = integration.status.favorites?.last;
  const usable = integration.enabled && connectionReady;

  // 同步方式變了，舊的預覽就不再代表這次會做的事
  useEffect(() => { setPreview(null); }, [mode]);

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
    <div className="space-y-3 rounded-lg bg-gray-50 p-3">
      <p className="text-sm text-gray-600" data-testid="favorites-mode">{MODE_NOTES[mode]}</p>
      {!connectionReady && (
        <p className="text-sm text-amber-700">請先在上方「連線」填寫網址、帳號與密碼並儲存，才能預覽或同步。</p>
      )}
      {connectionReady && !confirmed && (
        <p className="text-sm text-amber-700">
          尚未確認同步（第一次或剛切換同步方式）：請先預覽差異，確認數量後再開始。確認前不會自動同步。
        </p>
      )}
      {last && (
        <p className="text-sm text-gray-600" data-testid="favorites-last">
          上次同步：{formatTime(last.finished_at)}，{last.ok ? '成功' : `失敗：${last.error ?? last.errors?.join('、')}`}
          {last.applied && `（Navidrome 加入 ${last.applied.star}、取消 ${last.applied.unstar}；NexTags 加入 ${last.applied.favorite}、取消 ${last.applied.unfavorite}）`}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy || !usable}
          onClick={() => run(async () => setPreview(await previewFavorites()))}>
          預覽差異
        </Button>
        <Button disabled={busy || !usable || (!confirmed && !preview)}
          onClick={() => run(async () => {
            const result = await syncFavorites(!confirmed);
            toast.success(`最愛同步完成：Navidrome 加入 ${result.applied?.star ?? 0}、取消 ${result.applied?.unstar ?? 0}；NexTags 加入 ${result.applied?.favorite ?? 0}、取消 ${result.applied?.unfavorite ?? 0}`);
            setPreview(null);
            onChanged();
          })}>
          {confirmed ? '立即同步' : '確認並開始同步'}
        </Button>
      </div>
      {preview && (
        <div className="rounded-md border bg-white p-3 text-sm space-y-1" data-testid="favorites-preview">
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
    </div>
  );
}

// ---------------- 單一整合的設定頁 ----------------

function FieldGroup({ integration, title, fields, onChanged, actions, afterField, children }: {
  integration: Integration;
  title: string;
  fields: IntegrationField[];
  onChanged: () => void;
  /** 與「儲存」並排的按鈕（例如測試連線） */
  actions?: React.ReactNode;
  /** 插在某個欄位之後的內容（例如同步方式之後的預覽與同步） */
  afterField?: Record<string, React.ReactNode>;
  children?: React.ReactNode;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(integration.settings);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const headingId = useId();
  const disabled = !integration.enabled || busy;
  const textFields = fields.filter(field => !appliesImmediately(field));
  const dirty = Object.keys(secrets).length > 0 ||
    textFields.some(field => field.kind !== 'secret' && values[field.name] !== integration.settings[field.name]);

  useEffect(() => { setValues(integration.settings); }, [integration.settings]);

  const save = async (update: Parameters<typeof saveIntegration>[1], message: string) => {
    setBusy(true);
    setError('');
    try {
      await saveIntegration(integration.key, update);
      toast.success(message);
      setSecrets({});
      onChanged();
    } catch (error) {
      setError(errorText(error));
      setValues(integration.settings);
    } finally {
      setBusy(false);
    }
  };

  const saveTextFields = () => save({
    settings: Object.fromEntries(textFields.filter(field => field.kind !== 'secret').map(field => [field.name, values[field.name]])),
    secrets: Object.keys(secrets).length ? secrets : undefined,
  }, `${title}已儲存`);

  return (
    <section aria-labelledby={headingId} className="rounded-xl border bg-white p-4 space-y-4">
      <h3 id={headingId} className="font-medium text-gray-900">{title}</h3>
      {fields.map(field => (
        <div key={field.name}>
          <FieldInput
            field={field}
            value={field.kind === 'secret' ? secrets[field.name] ?? '' : values[field.name]}
            secret={integration.secrets[field.name]}
            disabled={disabled || (field.name in DEPENDS_ON && !values[DEPENDS_ON[field.name]])}
            onChange={value => {
              if (appliesImmediately(field)) {
                setValues(prev => ({ ...prev, [field.name]: value }));
                save({ settings: { [field.name]: value } }, `已更新「${field.label}」`);
              } else if (field.kind === 'secret') {
                setSecrets(prev => ({ ...prev, [field.name]: String(value) }));
              } else {
                setValues(prev => ({ ...prev, [field.name]: value }));
              }
            }}
            trailing={field.kind === 'secret' && integration.secrets[field.name] === 'database' && (
              <Button variant="outline" size="sm" className="shrink-0" disabled={disabled} aria-label={`清除${field.label}`}
                onClick={() => save({ secrets: { [field.name]: null } }, `已清除${field.label}`)}>
                清除
              </Button>
            )}
          />
          {afterField?.[field.name] && <div className="mt-3">{afterField[field.name]}</div>}
        </div>
      ))}
      {fields.some(field => field.kind === 'secret') && !integration.master_key_configured && (
        <p role="alert" className="text-sm text-amber-700">
          伺服器未設定 NEXTAGS_SECRET_KEY，無法儲存密鑰；請在 .env 設定後重新啟動。
        </p>
      )}
      {(textFields.length > 0 || actions) && (
        <div className="flex flex-wrap gap-2">
          {textFields.length > 0 && (
            <Button variant="success" disabled={disabled || !dirty} onClick={saveTextFields}>儲存{title}</Button>
          )}
          {actions}
        </div>
      )}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {children}
    </section>
  );
}

export function IntegrationDetail({ integration, onChanged }: { integration: Integration; onChanged: () => void }) {
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const groups = [...new Set(integration.fields.map(field => field.group))];
  const isNavidrome = integration.key === 'navidrome';
  const connectionReady = Boolean(integration.settings.base_url && integration.settings.username && integration.secrets.password);
  const scan = integration.status.scan;

  const toggle = async (enabled: boolean) => {
    try {
      await saveIntegration(integration.key, { enabled });
      toast.success(`${integration.name} 已${enabled ? '啟用' : '停用'}`);
      onChanged();
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    setTestResult(await testIntegration(integration.key).catch(error => ({ ok: false, message: errorText(error) })));
    setTesting(false);
  };

  const testButton = (
    <Button variant="outline" disabled={!integration.enabled || testing} onClick={runTest}>
      {testing ? '測試中…' : '測試連線'}
    </Button>
  );

  return (
    <div className="space-y-4" data-testid={`integration-${integration.key}`}>
      <div className="flex items-start justify-between gap-4 rounded-xl border bg-white p-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">{integration.name}</h2>
          <p className="text-sm text-gray-600 mt-1">{integration.description}</p>
        </div>
        <Switch aria-label={`啟用 ${integration.name}`} checked={integration.enabled} onCheckedChange={toggle} />
      </div>
      {!integration.enabled && (
        <p className="text-sm text-gray-600">此整合已停用；開啟後才能修改下列設定。</p>
      )}
      {groups.map((group, index) => (
        <FieldGroup key={group} integration={integration} title={group}
          fields={integration.fields.filter(field => field.group === group)} onChanged={onChanged}
          // 測試連線放在第一個區塊（連線／金鑰），與儲存並排
          actions={index === 0 ? testButton : undefined}
          afterField={isNavidrome && group === '最愛同步' ? {
            sync_mode: <FavoritesSyncActions integration={integration} connectionReady={connectionReady} onChanged={onChanged} />,
          } : undefined}>
          {index === 0 && testResult && (
            <p role="status" className={`text-sm ${testResult.ok ? 'text-green-700' : 'text-red-600'}`}>{testResult.message}</p>
          )}
          {isNavidrome && group === '掃描通知' && (
            <p className="text-sm text-gray-600">
              最近一次 Navidrome 掃描：{scan ? `${formatTime(scan.completed_at)}（${scan.ok ? '成功' : '失敗'}）` : '尚未收到狀態；若未安裝 refresh hook，請關閉「移動檔案前等待 Navidrome 掃描」'}
            </p>
          )}
        </FieldGroup>
      ))}
    </div>
  );
}
