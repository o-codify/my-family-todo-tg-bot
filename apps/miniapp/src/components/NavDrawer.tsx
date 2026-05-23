import { Icon, type IconName } from '../design';
import { useT } from '../i18n';
import { Drawer } from './Drawer';
import type { FamilySummary, MeResponse } from '../api';

/** Logical key for a navigation destination. Mirrors the Route kinds the
 *  parent (FamilyHome) understands; the parent translates a key into its
 *  own Route shape on tap. Keeps this component decoupled from routing. */
export type NavKey =
  | 'calendar'
  | 'queues'
  | 'shop'
  | 'shopping'
  | 'profile'
  | 'my-profile'
  | 'inbox'
  | 'search'
  | 'history'
  | 'stats'
  | 'catalog'
  | 'templates'
  | 'roles';

type Props = {
  me: MeResponse;
  family: FamilySummary;
  families: FamilySummary[];
  /** Which top-level destination is currently active. Sub-pages collapse
   *  into their parent top-level (e.g. `stats` highlights `profile`). */
  active: NavKey;
  onClose: () => void;
  onNavigate: (key: NavKey) => void;
  onSwitchFamily?: (id: string) => void;
};

type Entry = { key: NavKey; icon: IconName; labelKey: string };

const MAIN: Entry[] = [
  { key: 'calendar', icon: 'cal', labelKey: 'nav.calendar' },
  { key: 'queues', icon: 'repeat', labelKey: 'nav.queues' },
  { key: 'shopping', icon: 'pkg', labelKey: 'nav.shopping' },
  { key: 'shop', icon: 'star', labelKey: 'nav.shop' },
  { key: 'inbox', icon: 'bell', labelKey: 'nav.inbox' },
  { key: 'search', icon: 'search', labelKey: 'nav.search' },
];

const EXTRAS: Entry[] = [
  { key: 'history', icon: 'list', labelKey: 'nav.history' },
  { key: 'stats', icon: 'chart', labelKey: 'nav.stats' },
  { key: 'catalog', icon: 'pkg', labelKey: 'nav.catalog' },
  { key: 'templates', icon: 'flag', labelKey: 'nav.templates' },
  { key: 'roles', icon: 'users', labelKey: 'nav.roles' },
];

/**
 * Burger-menu drawer that replaces the old 4-tab bottom navigation. The user
 * pressed for "all destinations in one place" — bottom nav was capped at four
 * slots, and Phase B+ adds shopping list, events, meal plan, etc., which
 * don't fit. The drawer scales to N entries and groups them.
 */
export function NavDrawer({
  me,
  family,
  families,
  active,
  onClose,
  onNavigate,
  onSwitchFamily,
}: Props) {
  const t = useT();
  const isEn = t.locale === 'en';

  return (
    <Drawer onClose={onClose}>
      {({ close }) => {
        const go = (k: NavKey) => close(() => onNavigate(k));
        return (
          <>
            {/* Header: app/family identity. Tap on family name → Settings.
                If the user is in multiple families, we render a <select>
                so they can switch without leaving the drawer. */}
            <div className="wf-row wf-gap-8" style={{ padding: '4px 8px 8px' }}>
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 12,
                  background: 'var(--faint)',
                  border: '1.5px solid var(--line)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 20,
                  flex: 'none',
                }}
              >
                {family.avatarUrl ?? '🏠'}
              </div>
              <div className="wf-col" style={{ minWidth: 0, flex: 1 }}>
                {families.length > 1 && onSwitchFamily ? (
                  <select
                    value={family.id}
                    onChange={(e) => onSwitchFamily(e.target.value)}
                    className="wf-h3"
                    style={{
                      border: 'none',
                      background: 'transparent',
                      padding: 0,
                      color: 'var(--ink)',
                      fontFamily: 'inherit',
                      maxWidth: '100%',
                    }}
                  >
                    {families.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span
                    className="wf-h3"
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {family.name}
                  </span>
                )}
                <span
                  className="wf-tiny"
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {me.firstName}
                  {me.username ? ` · @${me.username}` : ''}
                </span>
              </div>
              <button
                onClick={() => close()}
                aria-label={t('common.close')}
                style={{
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 4,
                  color: 'var(--ink)',
                  flex: 'none',
                }}
              >
                <Icon name="x" />
              </button>
            </div>

            <div className="wf-drawer__section">{t('nav.section.main')}</div>
            {MAIN.map((e) => (
              <NavItem key={e.key} entry={e} active={active === e.key} onClick={go} t={t} />
            ))}

            <div className="wf-drawer__section">{t('nav.section.extras')}</div>
            {EXTRAS.map((e) => (
              <NavItem key={e.key} entry={e} active={active === e.key} onClick={go} t={t} />
            ))}

            <div style={{ flex: 1 }} />

            {/* Bottom: My profile + Settings. Stick to the footer so the
                user always knows where to find them regardless of how many
                extras we add later. */}
            <button
              type="button"
              className="wf-drawer__item"
              data-active={active === 'my-profile' ? '1' : '0'}
              onClick={() => go('my-profile')}
            >
              <Icon name="user" />
              <span style={{ flex: 1 }}>{t('nav.myProfile')}</span>
            </button>
            <button
              type="button"
              className="wf-drawer__item"
              data-active={active === 'profile' ? '1' : '0'}
              onClick={() => go('profile')}
            >
              <Icon name="sett" />
              <span style={{ flex: 1 }}>
                {isEn ? 'Settings' : 'Настройки'}
              </span>
            </button>
          </>
        );
      }}
    </Drawer>
  );
}

function NavItem({
  entry,
  active,
  onClick,
  t,
}: {
  entry: Entry;
  active: boolean;
  onClick: (k: NavKey) => void;
  t: ReturnType<typeof useT>;
}) {
  return (
    <button
      type="button"
      className="wf-drawer__item"
      data-active={active ? '1' : '0'}
      onClick={() => onClick(entry.key)}
    >
      <Icon name={entry.icon} />
      <span style={{ flex: 1 }}>{t(entry.labelKey)}</span>
    </button>
  );
}
