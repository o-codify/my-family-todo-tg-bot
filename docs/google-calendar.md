# Google Calendar two-way sync — setup guide

The Mini App can sync each user's tasks + family events into a
dedicated "Family Todo" calendar in their personal Google account,
refreshed every 5 minutes. This document walks through the one-time
Google Cloud Console setup the operator needs to do before users can
connect.

## Architecture

```
   user taps "Подключить"
        │
        ▼
   /me/google-calendar/connect ──► builds auth URL with state token
        │
        ▼
   Telegram.WebApp.openLink(url) — opens Google in system browser
        │
        ▼
   user grants consent
        │
        ▼
   Google redirects to GOOGLE_OAUTH_REDIRECT_URI
        │   (e.g. https://api.familytodo.app/api/v1/google/oauth/callback)
        ▼
   API exchanges code → access + refresh tokens
        │
        ▼
   API creates a dedicated "Family Todo" calendar in user's account
        │
        ▼
   tokens stored AES-256-GCM encrypted; calendarId saved
        │
        ▼
   every 5 min: cron tick fans out per-user reconcile jobs
        │
        ▼
   reconcile diffs DB occurrences/events ↔ Google events
        (filtered by extendedProperties.private.familyTodo=1)
   upsert/delete as needed
```

Scope of what gets synced today (per user):

- Task occurrences with `scheduledDate`, status `pending`, assignee = the
  user, across all families they belong to. Window: −7 to +60 days.
- Family events (birthdays, anniversaries) coming up in the next 60
  days from any of the user's families.
- Shopping lists with `dueDate` are picked up automatically — they
  back-link to a one-off task with assignee = list.assigneeUserId, so
  the assignee sees the list in their calendar.

What's NOT synced (yet):

- Floating tasks (no date).
- Bought items inside shopping lists (only the wrapper task surfaces).
- Other users' events (only your own assignments).

## Google Cloud Console setup

1. **Create a project** at <https://console.cloud.google.com/projectcreate>
   — name it e.g. "Family Todo Mini App". Skip the org if it asks.

2. **Enable the Google Calendar API** — Navigation menu → APIs & Services →
   Library → search "Google Calendar API" → Enable.

3. **Configure the OAuth consent screen** — APIs & Services → OAuth consent
   screen.
   - User type: **External** (so anyone with a Google account can
     authorize — Internal is only for Workspace orgs).
   - App name: "Family Todo" (shown on the consent page).
   - User support email + Developer contact email: your address.
   - **Scopes**: add `https://www.googleapis.com/auth/calendar`. This is
     a **sensitive** scope — Google will warn that you need verification
     to ship publicly. For early use, leave the app in **Testing** mode
     and add yourself + family members as **Test users** (up to 100).
   - Save and continue.

4. **Create OAuth client credentials** — APIs & Services → Credentials →
   Create Credentials → OAuth client ID.
   - Application type: **Web application**.
   - Name: "Family Todo API".
   - Authorized redirect URIs: add **the full callback URL**, e.g.
     `https://api.familytodo.app/api/v1/google/oauth/callback`.
     - Must match `GOOGLE_OAUTH_REDIRECT_URI` env var exactly (scheme,
       host, port, path).
     - For local development: `http://localhost:3000/api/v1/google/oauth/callback`.
   - Hit Create. You'll get a **Client ID** and **Client secret** —
     copy both.

5. **Set the env vars** on the API container:
   ```bash
   GOOGLE_OAUTH_CLIENT_ID="...your-client-id.apps.googleusercontent.com"
   GOOGLE_OAUTH_CLIENT_SECRET="GOCSPX-..."
   GOOGLE_OAUTH_REDIRECT_URI="https://api.familytodo.app/api/v1/google/oauth/callback"
   GOOGLE_TOKEN_ENC_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
   ```

   The `GOOGLE_TOKEN_ENC_KEY` is a one-time-generated 64-char hex
   string used for AES-256-GCM encryption of stored tokens. **Don't
   regenerate it after rollout** — existing tokens become unreadable.
   Keep a backup somewhere safe (1Password, AWS Secrets Manager, etc).

6. **Restart the API** — boot logs should show
   `google-sync tick scheduler installed (every 5 min)`. The Mini App
   will start showing the "Подключить Google Calendar" panel in
   "Мой профиль".

## What the user sees

- **Disconnected**: small card in My Profile with "Подключить" button.
  Tap → Google consent screen opens in system browser → user grants
  access → "✓ Google Calendar подключён" page → user returns to
  Telegram. The Mini App polls every 5s while on My Profile and the
  panel flips to "Подключено".
- **Connected**: card shows "✓ Подключено" + timestamp + "Отключить"
  button. Disconnect calls Google's `revoke` endpoint and drops the
  encrypted tokens locally.

## Verifying it works

After a user connects:

1. Open <https://calendar.google.com> in their browser.
2. A new calendar **Family Todo** appears in the sidebar.
3. Within 5 minutes, their pending tasks for the next 60 days show
   up in it as all-day events.
4. Completing/rescheduling a task in the Mini App is reflected on the
   next reconcile (≤5 min).

If nothing appears:

- API logs: look for `google reconcile done` lines with the user id.
- `google-sync reconcile threw` → permissions issue (token revoked
  from Google's side) or API quota.
- Check the OAuth consent screen status — if the project went out of
  Testing without verification, scopes silently revert and refreshes
  start failing with `invalid_grant`.

## Removing access for a single user

The user disconnects from My Profile (preferred — also revokes server
-side). They can additionally revoke from
<https://myaccount.google.com/permissions> → Family Todo → Remove
Access.

## Publishing for the wider world

The Testing mode limit is 100 users. To open up to the public:

1. OAuth consent screen → "Publish App" → Google sends the app for
   **verification**. They check that the privacy policy + ToS pages
   exist and are reachable, that the listed scopes are justified, and
   (for sensitive scopes like `calendar`) may require a third-party
   security assessment if you're sending data outside the app.
2. Verification takes 4–6 weeks typically. Plan ahead.
