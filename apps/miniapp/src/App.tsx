import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api';
import { getStartParam, initTelegram } from './telegram';
import { Onboarding } from './pages/Onboarding';
import { FamilyHome } from './pages/FamilyHome';
import { LocaleProvider, makeT } from './i18n';

export function App() {
  useEffect(() => initTelegram(), []);
  const startInviteCode = useMemo(() => getStartParam() ?? undefined, []);
  const queryClient = useQueryClient();

  const meQuery = useQuery({ queryKey: ['me'], queryFn: api.me });
  const familiesQuery = useQuery({
    queryKey: ['families'],
    queryFn: api.listFamilies,
    enabled: !!meQuery.data,
  });

  const [shareOverride, setShareOverride] = useState(false);
  // When true, render the Onboarding flow on top of FamilyHome so an
  // existing user can create another family or join one by code. The
  // user reported: "А если я в семье, то как создать новую или как
  // ввести код, если есть только код. Вернуть к главной странице же
  // никак" — there was no entrypoint after the initial onboarding.
  const [addingFamily, setAddingFamily] = useState(false);
  const createFamily = useMutation({
    mutationFn: async ({
      name,
      color,
      avatarEmoji,
    }: {
      name: string;
      color: string;
      avatarEmoji: string | null;
    }) => {
      // Persist color first so the owner appears with the chosen color when the
      // family is created (and the owner's avatar in member-stack uses it).
      await api.updateMe({ color });
      return api.createFamily({ name, avatarUrl: avatarEmoji });
    },
    onSuccess: () => {
      // Block the auto-navigation into FamilyHome — we want to show the
      // "Поделиться кодом" step inside Onboarding first.
      setShareOverride(true);
      queryClient.invalidateQueries({ queryKey: ['families'] });
      queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });

  const joinFamily = useMutation({
    mutationFn: (code: string) => api.joinFamily(code),
    onSuccess: () => {
      // Join is single-step (no ShareStep follow-up), so close the
      // add-family overlay as soon as the new membership lands.
      setAddingFamily(false);
      queryClient.invalidateQueries({ queryKey: ['families'] });
    },
  });

  // We don't know the user's locale until /me resolves — so the loading
  // screen uses the browser language as the best guess and falls back to RU.
  const bootT = makeT(typeof navigator !== 'undefined' ? navigator.language : null);

  if (meQuery.isLoading) return <div className="screen-center">{bootT('common.loading')}</div>;

  if (meQuery.isError) {
    const err = meQuery.error as ApiError;
    return (
      <div className="screen-center">
        <div className="error-box">
          <p>{bootT.locale === 'en' ? 'Failed to sign in.' : 'Не удалось войти.'}</p>
          <small>{err.message}</small>
        </div>
      </div>
    );
  }

  const me = meQuery.data!;
  const families = familiesQuery.data?.families ?? [];

  if (families.length === 0 || shareOverride || addingFamily) {
    return (
      <LocaleProvider locale={me.locale}>
        <Onboarding
          me={me}
          initialInviteCode={startInviteCode}
          onCreate={(input) => createFamily.mutateAsync(input)}
          onJoin={(code) => joinFamily.mutateAsync(code)}
          onComplete={() => {
            // ShareStep "Done" → close both overlays. If we got here via
            // the add-family flow, the user already had at least one
            // family; clear that flag too.
            setShareOverride(false);
            setAddingFamily(false);
          }}
          // Only expose the cancel/back affordance when the user has
          // somewhere to go back to — the initial onboarding doesn't.
          onCancel={addingFamily ? () => setAddingFamily(false) : undefined}
          createError={createFamily.error as ApiError | null}
          joinError={joinFamily.error as ApiError | null}
        />
      </LocaleProvider>
    );
  }

  return (
    <LocaleProvider locale={me.locale}>
      <FamilyHome
        me={me}
        families={families}
        onAddFamily={() => setAddingFamily(true)}
      />
    </LocaleProvider>
  );
}
