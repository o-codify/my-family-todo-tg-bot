import type { BadgeDto } from '../api';
import { useT } from '../i18n';

type Props = {
  badges: BadgeDto[];
  /** Compact mode renders just the icons + count (for tight profile
   *  cards). Default shows icon + name in a tile so users see what
   *  they earned. */
  compact?: boolean;
};

/**
 * Reusable grid of earned badges. Used by MyProfile and MemberProfile —
 * same shape on both surfaces so a player's bragging board is consistent
 * across views.
 */
export function BadgeGrid({ badges, compact }: Props) {
  const t = useT();
  if (badges.length === 0) {
    return (
      <span className="wf-hint" style={{ display: 'block', padding: 6 }}>
        {t('badges.empty')}
      </span>
    );
  }
  if (compact) {
    return (
      <div className="wf-row wf-gap-6" style={{ flexWrap: 'wrap' }}>
        {badges.map((b) => (
          <span
            key={b.slug}
            title={`${b.name} — ${b.description}`}
            style={{ fontSize: 22, lineHeight: 1 }}
            aria-label={b.name}
          >
            {b.icon}
          </span>
        ))}
      </div>
    );
  }
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))',
        gap: 8,
      }}
    >
      {badges.map((b) => (
        <div
          key={b.slug}
          className="wf-card subtle"
          style={{
            padding: 8,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 4,
            textAlign: 'center',
          }}
          title={b.description}
        >
          <span style={{ fontSize: 28, lineHeight: 1 }}>{b.icon}</span>
          <span className="wf-tiny" style={{ fontWeight: 600 }}>
            {b.name}
          </span>
        </div>
      ))}
    </div>
  );
}
