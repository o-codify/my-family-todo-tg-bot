import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type FamilySummary, type MeResponse, type OccurrenceDto, type TaskDto } from '../api';
import { Calendar } from './Calendar';
import { Catalog } from './Catalog';
import { Day } from './Day';
import { Profile } from './Profile';
import { MyProfile } from './MyProfile';
import { MemberProfile } from './MemberProfile';
import { History } from './History';
import { Inbox } from './Inbox';
import { QueueDetail } from './QueueDetail';
import { QueueList } from './QueueList';
import { Roles } from './Roles';
import { Search } from './Search';
import { Shop } from './Shop';
import { Stats } from './Stats';
import { Templates } from './Templates';
import { TaskSheet } from '../components/TaskSheet';
import { CreateTaskSheet } from '../components/CreateTaskSheet';
import { NavDrawer, type NavKey } from '../components/NavDrawer';
import { OnboardingTour } from '../components/OnboardingTour';
import { Transfer } from './Transfer';
import { useFamilyEvents } from '../hooks/useFamilyEvents';
import { usePreferences } from '../hooks/usePreferences';
import { useT } from '../i18n';

type Props = {
  me: MeResponse;
  families: FamilySummary[];
};

type Route =
  | { kind: 'calendar' }
  | { kind: 'day'; iso: string }
  | { kind: 'queues' }
  | { kind: 'queue'; taskId: string }
  | { kind: 'shop' }
  | { kind: 'profile' }
  | { kind: 'my-profile' }
  | { kind: 'member'; userId: string }
  | { kind: 'stats' }
  | { kind: 'history' }
  | { kind: 'catalog' }
  | { kind: 'templates' }
  | { kind: 'roles' }
  | { kind: 'search' }
  | { kind: 'inbox' }
  // Transfer used to be a bottom-sheet but the design always treated it as a
  // dedicated screen — too much content for a 90vh sheet. We route to it
  // with the occurrence id baked into the URL so refresh restores state.
  | { kind: 'transfer'; occurrenceId: string };

/** A drawer-nav key maps to the route a tap should navigate to. */
const NAV_ROUTE: Record<NavKey, Route> = {
  calendar: { kind: 'calendar' },
  queues: { kind: 'queues' },
  shop: { kind: 'shop' },
  profile: { kind: 'profile' },
  'my-profile': { kind: 'my-profile' },
  inbox: { kind: 'inbox' },
  search: { kind: 'search' },
  history: { kind: 'history' },
  stats: { kind: 'stats' },
  catalog: { kind: 'catalog' },
  templates: { kind: 'templates' },
  roles: { kind: 'roles' },
};

/**
 * Hash-based router so refresh / re-launch lands on the same page the user
 * was looking at. Telegram WebApp doesn't give us real History API routing,
 * but `location.hash` survives reload and doesn't fight Telegram's own deep
 * links (those come via `startapp` query / initDataUnsafe.start_param).
 *
 * URL examples:
 *   #/calendar              → root tab
 *   #/day/2026-05-21        → day detail
 *   #/queue/<taskId>        → queue detail
 *   #/profile/stats         → profile sub-page
 *
 * Unknown / missing → defaults to calendar.
 */
function serializeRoute(r: Route): string {
  switch (r.kind) {
    case 'calendar':
      return '#/calendar';
    case 'day':
      return `#/day/${r.iso}`;
    case 'queues':
      return '#/queues';
    case 'queue':
      return `#/queue/${r.taskId}`;
    case 'shop':
      return '#/shop';
    case 'profile':
      return '#/profile';
    case 'my-profile':
      return '#/profile/me';
    case 'member':
      return `#/profile/member/${r.userId}`;
    case 'stats':
      return '#/profile/stats';
    case 'history':
      return '#/profile/history';
    case 'catalog':
      return '#/profile/catalog';
    case 'templates':
      return '#/profile/templates';
    case 'roles':
      return '#/profile/roles';
    case 'search':
      return '#/profile/search';
    case 'inbox':
      return '#/profile/inbox';
    case 'transfer':
      return `#/transfer/${r.occurrenceId}`;
  }
}

function parseRoute(hash: string): Route {
  // Strip leading '#' / '#/'.
  const path = hash.replace(/^#\/?/, '');
  const [head, ...rest] = path.split('/');
  switch (head) {
    case '':
    case 'calendar':
      return { kind: 'calendar' };
    case 'day': {
      const iso = rest[0];
      if (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso)) return { kind: 'day', iso };
      return { kind: 'calendar' };
    }
    case 'queues':
      return { kind: 'queues' };
    case 'queue': {
      const taskId = rest[0];
      if (taskId) return { kind: 'queue', taskId };
      return { kind: 'queues' };
    }
    case 'shop':
      return { kind: 'shop' };
    case 'transfer': {
      const occurrenceId = rest[0];
      if (occurrenceId) return { kind: 'transfer', occurrenceId };
      return { kind: 'calendar' };
    }
    case 'profile': {
      const sub = rest[0];
      switch (sub) {
        case undefined:
        case '':
          return { kind: 'profile' };
        case 'me':
          return { kind: 'my-profile' };
        case 'member': {
          const userId = rest[1];
          if (userId) return { kind: 'member', userId };
          return { kind: 'profile' };
        }
        case 'stats':
        case 'history':
        case 'catalog':
        case 'templates':
        case 'roles':
        case 'search':
        case 'inbox':
          return { kind: sub };
        default:
          return { kind: 'profile' };
      }
    }
    default:
      return { kind: 'calendar' };
  }
}

/** Which drawer entry should appear "active" for the current route. Sub-pages
 *  collapse to their nearest top-level (day → calendar, queue → queues,
 *  member → my-profile if it's you, otherwise profile/Settings). */
function navKeyForRoute(r: Route): NavKey {
  switch (r.kind) {
    case 'day':
    case 'transfer':
    case 'calendar':
      return 'calendar';
    case 'queues':
    case 'queue':
      return 'queues';
    case 'shop':
      return 'shop';
    case 'inbox':
      return 'inbox';
    case 'search':
      return 'search';
    case 'history':
      return 'history';
    case 'stats':
      return 'stats';
    case 'catalog':
      return 'catalog';
    case 'templates':
      return 'templates';
    case 'roles':
      return 'roles';
    case 'my-profile':
      return 'my-profile';
    case 'member':
    case 'profile':
      return 'profile';
  }
}

export function FamilyHome({ me, families }: Props) {
  const queryClient = useQueryClient();
  const t = useT();
  const [activeFamilyId, setActiveFamilyId] = useState(() => families[0]?.id);
  const activeFamily = families.find((f) => f.id === activeFamilyId) ?? families[0];

  // Realtime: SSE pushes invalidation hints; the 8s polling stays as a
  // fallback in case the stream dies. Only enable once we know the family.
  useFamilyEvents(activeFamily?.id ?? null);
  // Restore route from the URL hash on first render so refresh / re-launch
  // keeps the user on whatever screen they were looking at.
  const [route, setRoute] = useState<Route>(() =>
    typeof window === 'undefined' ? { kind: 'calendar' } : parseRoute(window.location.hash),
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const activeNav: NavKey = navKeyForRoute(route);

  // Onboarding tour shown once per user. The flag lives in `preferences`
  // (PATCH /me); after dismissal it's persisted so refresh/re-launch won't
  // re-trigger. We read straight off the `me` prop so server is the source
  // of truth — local toggling doesn't drift.
  const { prefs, set: setPrefs } = usePreferences(me);
  const tourSeen = prefs.viewedTutorial === true;

  // Keep the hash in sync with the active route, and react to back/forward.
  useEffect(() => {
    const target = serializeRoute(route);
    if (window.location.hash !== target) {
      // `replaceState` instead of `pushState` so the back button steps through
      // *user-driven* navigation (we'll push there explicitly later) rather
      // than every internal route flip.
      window.history.replaceState(null, '', target);
    }
  }, [route]);

  useEffect(() => {
    const handler = () => {
      const next = parseRoute(window.location.hash);
      setRoute(next);
    };
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);
  const [openTask, setOpenTask] = useState<OccurrenceDto | null>(null);
  const [editingTask, setEditingTask] = useState<TaskDto | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createDefaultDate, setCreateDefaultDate] = useState<string>(
    new Date().toISOString().slice(0, 10),
  );
  const [createDefaultKind, setCreateDefaultKind] = useState<
    'oneoff' | 'recurring' | 'floating' | 'queued'
  >('recurring');

  const tasksQuery = useQuery({
    queryKey: ['tasks', activeFamily?.id],
    queryFn: () => api.listTasks(activeFamily!.id),
    enabled: !!activeFamily,
  });

  if (!activeFamily)
    return (
      <div className="screen-center">
        {t.locale === 'en' ? 'No families' : 'Нет семей'}
      </div>
    );

  // The drawer turns any logical destination into a route flip. Closing the
  // drawer happens inside `NavDrawer` (it runs the slide-out first).
  const openDrawer = () => setDrawerOpen(true);
  const onNavigate = (key: NavKey) => {
    setRoute(NAV_ROUTE[key]);
    setDrawerOpen(false);
  };

  return (
    <>
      {/* Active screen */}
      {route.kind === 'calendar' && (
        <Calendar
          me={me}
          family={activeFamily}
          families={families}
          onSwitchFamily={setActiveFamilyId}
          onOpenDay={(iso) => setRoute({ kind: 'day', iso })}
          onOpenTask={setOpenTask}
          onCreateTask={(iso) => {
            setCreateDefaultDate(iso);
            setCreateDefaultKind('recurring');
            setCreateOpen(true);
          }}
          onOpenInvite={() => setRoute({ kind: 'profile' })}
          onOpenDrawer={openDrawer}
        />
      )}
      {route.kind === 'day' && (
        <Day
          me={me}
          family={activeFamily}
          iso={route.iso}
          onBack={() => setRoute({ kind: 'calendar' })}
          onOpenTask={setOpenTask}
          onCreateTask={() => {
            setCreateDefaultDate(route.iso);
            setCreateDefaultKind('oneoff');
            setCreateOpen(true);
          }}
        />
      )}
      {route.kind === 'queues' && (
        <QueueList
          me={me}
          family={activeFamily}
          onOpenQueue={(taskId) => setRoute({ kind: 'queue', taskId })}
          onCreate={() => {
            setCreateDefaultDate(new Date().toISOString().slice(0, 10));
            setCreateDefaultKind('queued');
            setCreateOpen(true);
          }}
          onOpenDrawer={openDrawer}
        />
      )}
      {route.kind === 'queue' && (
        <QueueDetail
          me={me}
          family={activeFamily}
          taskId={route.taskId}
          onBack={() => setRoute({ kind: 'queues' })}
          onEditTask={(id) => {
            const t = tasksQuery.data?.tasks.find((x) => x.id === id);
            if (t) setEditingTask(t);
          }}
        />
      )}
      {route.kind === 'shop' && (
        <Shop
          me={me}
          family={activeFamily}
          onOpenDrawer={openDrawer}
        />
      )}
      {route.kind === 'profile' && (
        <Profile
          me={me}
          family={activeFamily}
          families={families}
          onSwitchFamily={setActiveFamilyId}
          onLeft={() => {
            // After leaving, App.tsx's families query will refetch and route to Onboarding
            setRoute({ kind: 'calendar' });
          }}
          onOpenMyProfile={() => setRoute({ kind: 'my-profile' })}
          onOpenMember={(userId) => setRoute({ kind: 'member', userId })}
          onOpenStats={() => setRoute({ kind: 'stats' })}
          onOpenHistory={() => setRoute({ kind: 'history' })}
          onOpenCatalog={() => setRoute({ kind: 'catalog' })}
          onOpenTemplates={() => setRoute({ kind: 'templates' })}
          onOpenRoles={() => setRoute({ kind: 'roles' })}
          onOpenSearch={() => setRoute({ kind: 'search' })}
          onOpenInbox={() => setRoute({ kind: 'inbox' })}
          onOpenDrawer={openDrawer}
        />
      )}
      {route.kind === 'my-profile' && (
        <MyProfile
          me={me}
          family={activeFamily}
          onBack={() => setRoute({ kind: 'profile' })}
        />
      )}
      {route.kind === 'member' && (
        <MemberProfile
          me={me}
          family={activeFamily}
          userId={route.userId}
          onBack={() => setRoute({ kind: 'profile' })}
        />
      )}
      {route.kind === 'stats' && (
        <Stats
          me={me}
          family={activeFamily}
          onBack={() => setRoute({ kind: 'profile' })}
        />
      )}
      {route.kind === 'history' && (
        <History
          me={me}
          family={activeFamily}
          onBack={() => setRoute({ kind: 'profile' })}
        />
      )}
      {route.kind === 'catalog' && (
        <Catalog
          me={me}
          family={activeFamily}
          onBack={() => setRoute({ kind: 'profile' })}
        />
      )}
      {route.kind === 'templates' && (
        <Templates
          me={me}
          family={activeFamily}
          onBack={() => setRoute({ kind: 'profile' })}
          onApply={async (payload) => {
            try {
              await api.createTask(activeFamily.id, payload);
            } catch {
              // ignore — user can retry from calendar
            }
            queryClient.invalidateQueries({ queryKey: ['occurrences', activeFamily.id] });
            queryClient.invalidateQueries({ queryKey: ['tasks', activeFamily.id] });
            setRoute({ kind: 'calendar' });
          }}
        />
      )}
      {route.kind === 'roles' && (
        <Roles
          me={me}
          family={activeFamily}
          onBack={() => setRoute({ kind: 'profile' })}
        />
      )}
      {route.kind === 'search' && (
        <Search
          me={me}
          family={activeFamily}
          onBack={() => setRoute({ kind: 'profile' })}
        />
      )}
      {route.kind === 'inbox' && (
        <Inbox
          me={me}
          family={activeFamily}
          onBack={() => setRoute({ kind: 'profile' })}
        />
      )}
      {route.kind === 'transfer' && (
        <Transfer
          me={me}
          family={activeFamily}
          occurrenceId={route.occurrenceId}
          // Cancel + done both fall back to the calendar — same UX shape as
          // closing the old sheet, but a real navigation now.
          onBack={() => setRoute({ kind: 'calendar' })}
          onDone={() => setRoute({ kind: 'calendar' })}
        />
      )}

      {/* Burger drawer — replaces the old 4-tab bottom-nav. Each top-level
          page exposes an `onOpenDrawer` callback wired to open this. */}
      {drawerOpen && (
        <NavDrawer
          me={me}
          family={activeFamily}
          families={families}
          active={activeNav}
          onClose={() => setDrawerOpen(false)}
          onNavigate={onNavigate}
          onSwitchFamily={setActiveFamilyId}
        />
      )}

      {/* First-run tour — single overlay that walks through 5 destinations.
          Persist the dismissal so it never reappears unless preferences are
          cleared server-side. */}
      {!tourSeen && (
        <OnboardingTour onClose={() => setPrefs({ viewedTutorial: true })} />
      )}

      {openTask && (
        <TaskSheet
          me={me}
          family={activeFamily}
          occurrence={openTask}
          onClose={() => setOpenTask(null)}
          onEdit={() => {
            const t = tasksQuery.data?.tasks.find((x) => x.id === openTask.taskId);
            if (t) {
              setEditingTask(t);
              setOpenTask(null);
            }
          }}
          onTransfer={() => {
            // Navigate to the Transfer page; the TaskSheet close-animation
            // wraps this callback via `close(onTransfer)`, so the sheet
            // slides out first, then we swap routes.
            setRoute({ kind: 'transfer', occurrenceId: openTask.id });
            setOpenTask(null);
          }}
        />
      )}
      {(createOpen || editingTask) && (
        <CreateTaskSheet
          me={me}
          family={activeFamily}
          defaultDate={createDefaultDate}
          defaultKind={createDefaultKind}
          editingTask={editingTask ?? undefined}
          onClose={() => {
            setCreateOpen(false);
            setEditingTask(null);
          }}
          onCreated={() => {
            setCreateOpen(false);
            setEditingTask(null);
          }}
        />
      )}
    </>
  );
}

