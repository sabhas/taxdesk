import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { NavLink, useLocation } from 'react-router';
import { LogOut, Menu } from 'lucide-react';
import { ROLE_DEFINITIONS } from '@taxdesk/shared';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { NAV_ROUTES, canSeeRoute } from '../routes.js';
import { useSession } from '../session/session-context.js';
import { Wordmark } from './layout/BrandMark.js';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/u);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const { state, can, signOut } = useSession();
  const session = state.status === 'authenticated' ? state.session : null;
  const items = NAV_ROUTES.filter((item) => canSeeRoute(item, can));

  return (
    <div className="flex h-full flex-col gap-6 bg-sidebar p-4 text-sidebar-foreground">
      <Wordmark inverted className="px-2 pt-1" />
      <nav aria-label="Primary" className="flex-1">
        <ul className="space-y-1">
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <li key={item.path}>
                {/* NavLink sets aria-current="page" on the active route. */}
                <NavLink
                  to={item.path}
                  end={item.end ?? true}
                  onClick={onNavigate}
                  className={({ isActive }) =>
                    cn(
                      'relative flex h-10 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors',
                      'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sidebar-ring',
                      isActive
                        ? 'bg-sidebar-accent text-sidebar-accent-foreground before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-sidebar-primary'
                        : 'text-sidebar-muted hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
                    )
                  }
                >
                  <Icon aria-hidden="true" className="size-4" />
                  {item.label}
                </NavLink>
              </li>
            );
          })}
        </ul>
      </nav>
      {session !== null && (
        <div className="space-y-3 border-t border-sidebar-border pt-4">
          <div className="flex items-center gap-3 px-2">
            <span
              aria-hidden="true"
              className="flex size-9 shrink-0 items-center justify-center rounded-full bg-sidebar-accent text-xs font-semibold"
            >
              {initials(session.user.displayName)}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{session.user.displayName}</p>
              <p className="truncate text-xs text-sidebar-muted">
                {session.roles.map((role) => ROLE_DEFINITIONS[role].name).join(', ')}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void signOut()}
            className="flex h-9 w-full items-center gap-3 rounded-lg px-3 text-sm text-sidebar-muted transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sidebar-ring"
          >
            <LogOut aria-hidden="true" className="size-4" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * After a client-side navigation, moves focus to the new page's h1 (or the
 * main region) so screen readers announce the change. The first render is
 * skipped: on initial load focus stays at the top of the document.
 */
function useFocusOnNavigation(main: RefObject<HTMLElement | null>): void {
  const { key } = useLocation();
  // Compare against the last location instead of a "first render" flag so the
  // StrictMode double-run of effects does not move focus on first load.
  const lastKey = useRef(key);

  useEffect(() => {
    if (lastKey.current === key) {
      return;
    }
    lastKey.current = key;
    const region = main.current;
    if (region === null) {
      return;
    }
    const heading = region.querySelector<HTMLElement>('h1');
    (heading ?? region).focus();
  }, [key, main]);
}

export function AppShell({ children }: { children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  useFocusOnNavigation(mainRef);

  return (
    <div className="min-h-svh lg:grid lg:grid-cols-[15rem_minmax(0,1fr)]">
      <a
        className="sr-only z-50 rounded-md bg-card px-4 py-2 text-sm font-medium focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
        href="#main-content"
      >
        Skip to main content
      </a>

      {/* Wide screens: fixed ink sidebar. */}
      <aside className="sticky top-0 hidden h-svh lg:block">
        <SidebarContent />
      </aside>

      {/* Narrow screens: top bar with a sheet. The nav mounts only while open. */}
      <div className="sticky top-0 z-30 flex h-14 items-center justify-between border-b bg-sidebar px-4 lg:hidden">
        <Wordmark inverted />
        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className="text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
              />
            }
          >
            <Menu aria-hidden="true" />
            <span className="sr-only">Open navigation</span>
          </SheetTrigger>
          <SheetContent side="left" className="w-72 border-none p-0" showCloseButton={false}>
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <SidebarContent
              onNavigate={() => {
                setMenuOpen(false);
              }}
            />
          </SheetContent>
        </Sheet>
      </div>

      <main
        ref={mainRef}
        id="main-content"
        tabIndex={-1}
        className="mx-auto w-full max-w-6xl px-4 py-8 outline-none sm:px-8 lg:py-10"
      >
        {children}
      </main>
    </div>
  );
}
