import { Disc2, ListMusic, ServerCrash, Settings2 } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';

const LINKS = [
  { to: '/', label: '歌曲管理', icon: Disc2 },
  { to: '/playlists', label: '播放清單', icon: ListMusic },
  { to: '/cache', label: '快取管理', icon: ServerCrash },
  { to: '/settings', label: '系統設定', icon: Settings2 },
];

export default function Navbar() {
  const { pathname } = useLocation();

  return (
    // 固定在頂端；z-40 低於對話框（z-50），開啟對話框時仍會被遮住
    <header className="sticky top-0 z-40 border-b bg-white/90 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-white/75">
      <div className="mx-auto flex h-16 items-center justify-between gap-2 px-4">
        <Link to="/" className="flex shrink-0 items-center gap-2 rounded-lg">
          <img src="/logo.png" alt="" width={32} height={32} className="size-8" />
          <span className="text-xl font-bold tracking-tight text-gray-900">NexTags</span>
        </Link>
        <nav aria-label="主要功能" className="flex items-center">
          {LINKS.map(({ to, label, icon: Icon }) => {
            const active = pathname === to;
            return (
              <Link
                key={to}
                to={to}
                aria-label={label}
                aria-current={active ? 'page' : undefined}
                title={label}
                className={`flex shrink-0 gap-2 whitespace-nowrap rounded-full px-3 py-2 text-sm font-medium transition-colors sm:px-4 ${active
                  ? 'bg-foreground text-background'
                  : 'text-gray-500 hover:bg-gray-100 hover:text-gray-700'
                  }`}
              >
                <Icon className="size-5" aria-hidden="true" />
                {/* 窄螢幕只顯示圖示（名稱由 aria-label 提供），避免文字被擠成直排 */}
                {active && <span className="hidden sm:inline">{label}</span>}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
