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
  | 'meal-plan'
  | 'events'
  | 'permReq'
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
  /** Opens the create/join-family overlay. Rendered as an explicit
   *  entry next to the family switcher so users in N≥1 families have
   *  a discoverable way to add another. Without this, the only way
   *  in was the initial-onboarding screen which is unreachable once
   *  you're a member of any family. */
  onAddFamily?: () => void;
};

type Entry = { key: NavKey; icon: IconName; labelKey: string };

// User asked to remove drawer scrolling. Shrunk MAIN to the high-traffic
// destinations and pushed search/inbox/permission-requests down into the
// "extras" group. Sections combined keep the entry count under what fits
// on a 700-px-tall viewport without scrolling.
const MAIN: Entry[] = [
  { key: 'calendar', icon: 'cal', labelKey: 'nav.calendar' },
  { key: 'queues', icon: 'repeat', labelKey: 'nav.queues' },
  { key: 'shopping', icon: 'pkg', labelKey: 'nav.shopping' },
  { key: 'meal-plan', icon: 'list', labelKey: 'nav.mealPlan' },
  { key: 'events', icon: 'gift', labelKey: 'nav.events' },
  { key: 'shop', icon: 'star', labelKey: 'nav.shop' },
];

const EXTRAS: Entry[] = [
  { key: 'permReq', icon: 'bell', labelKey: 'nav.permReq' },
  { key: 'inbox', icon: 'bell', labelKey: 'nav.inbox' },
  { key: 'search', icon: 'search', labelKey: 'nav.search' },
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
  onAddFamily,
}: Props) {
  const t = useT();
  const isEn = t.locale === 'en';

  return (
    <Drawer onClose={onClose}>
      {({ close }) => {
        const go = (k: NavKey) => close(() => onNavigate(k));
        return (
          <>
            {/* Header: family identity + family-settings entrypoint.
                The whole pill is tappable → opens family settings ('profile'
                route). The trailing gear icon is the visual cue. In a
                multi-family account, the row gets a small <select> chip
                to switch — clicks on the select don't bubble up to the
                settings handler. */}
            <div
              className="wf-row wf-gap-8"
              style={{
                padding: '6px 8px 10px',
                cursor: 'pointer',
                borderRadius: 10,
              }}
              role="button"
              tabIndex={0}
              onClick={() => go('profile')}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  go('profile');
                }
              }}
            >
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
                    // Switching family shouldn't fall through to "open
                    // family settings" — both happen on click otherwise.
                    onClick={(e) => e.stopPropagation()}
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
              {/* Visual hint: tapping the row opens family settings. */}
              <span
                aria-hidden
                style={{ color: 'var(--hint)', flex: 'none', padding: 2 }}
                title={isEn ? 'Family settings' : 'Настройки семьи'}
              >
                <Icon name="sett" />
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  close();
                }}
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

            {onAddFamily && (
              <button
                type="button"
                className="wf-drawer__item"
                onClick={() => close(onAddFamily)}
              >
                <Icon name="plus" />
                <span style={{ flex: 1, textAlign: 'left' }}>
                  {isEn ? 'Add family' : 'Добавить семью'}
                </span>
                <span className="wf-tiny" style={{ color: 'var(--hint)' }}>
                  {isEn ? 'create or join' : 'создать или войти'}
                </span>
              </button>
            )}

            <div className="wf-drawer__section">{t('nav.section.main')}</div>
            {MAIN.map((e) => (
              <NavItem key={e.key} entry={e} active={active === e.key} onClick={go} t={t} />
            ))}

            <div className="wf-drawer__section">{t('nav.section.extras')}</div>
            {EXTRAS.map((e) => (
              <NavItem key={e.key} entry={e} active={active === e.key} onClick={go} t={t} />
            ))}

            <div style={{ flex: 1 }} />

            {/* Bottom: personal "Settings" (the former "Мой профиль" —
                renamed per user feedback: this is where the *user's* own
                preferences live: language, notifications, ICS token, etc.).
                Family-level settings moved up to the header (tap on family
                name + gear icon hint), so we no longer render two
                near-identical buttons here. */}
            <button
              type="button"
              className="wf-drawer__item"
              data-active={active === 'my-profile' ? '1' : '0'}
              onClick={() => go('my-profile')}
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
