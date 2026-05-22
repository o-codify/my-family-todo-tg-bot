# Family Todo — технический план

Технический спутник [дизайн-брифа](design-brief.md). Описывает реальную структуру кода, стек, схему БД и API в их текущем состоянии.

> Документ актуален на момент: монорепа собрана, API + бот + Mini App работают, фото живут в Telegram. Оставшиеся задачи отмечены **TODO** в конце разделов и в разделе 12.

---

## 1. Стек (фактический)

| Слой | Технология | Что выбрали и почему |
|---|---|---|
| Язык | TypeScript everywhere | Единый язык, общие типы между бэком и фронтом |
| Монорепа | **pnpm workspaces + Turborepo** | Параллельный запуск, кэш билдов |
| Runtime | **Node 22 LTS** | Стабильно для grammY/BullMQ/Drizzle |
| API | **Hono** | Лёгкий, отличная типизация, multipart-парсер из коробки |
| ORM | **Drizzle** + drizzle-kit | TS-first, миграции из схемы |
| БД | **PostgreSQL 16** | JSONB для гибких полей (расписание, права, notification_settings) |
| Кэш / очереди | **Redis** (docker-compose) | Будет нужен для BullMQ — пока не подключён |
| Бот | **grammY** | TS-first; long-polling в dev, webhook позже |
| Mini App | **React 18 + Vite + TS** | Стандарт |
| TG SDK | `window.Telegram.WebApp` напрямую | SDK-обёртка не понадобилась; initData валидируется через `@telegram-apps/init-data-node` на бэке |
| Сетевой слой | **TanStack Query** | Polling 8s + refetchOnFocus вместо real-time |
| Валидация | **Zod** | Общие схемы в `packages/shared` |
| UI-стили | Plain CSS + CSS-переменные | Без CSS Modules — токены из `wireframe.css`, компоненты в `src/design/` |
| Иконки | Самописные SVG в `Icon.tsx` | Один файл с `IconName` union, без зависимости |
| Хранилище фото | **Telegram-native** (см. §9) | S3 не используется |
| i18n | Самописный словарь + Context | `src/i18n.ts`, RU/EN |
| Тесты | **Vitest** (unit + integration с truncate-харнессом) | Playwright **TODO** |
| Линт / формат | ESLint + Prettier | — |
| Локалка | Docker Compose: postgres, redis, adminer | См. `infra/docker-compose.yml` |
| Деплой | **TODO** — Coolify / Hetzner | — |

**Чего из плана НЕ оказалось:**
- `zustand` — обошлись `useState` + TanStack Query;
- `@telegram-apps/sdk-react` — хватило `window.Telegram.WebApp` (мы используем только `ready/expand/disableVerticalSwipes` и `themeParams`);
- `react-router-dom` — самописный hash-router внутри `FamilyHome.tsx`;
- `react-hook-form` — формы маленькие, хватает контролируемых инпутов;
- `date-fns` — операций над датами немного, плотный Date API справляется;
- Lucide / Phosphor — самописные SVG-иконки экономят 200+ КБ бандла;
- CSS Modules — пишем по wireframe-классам (`wf-card`, `wf-row`, …);
- i18next — самописный словарь весит < 1 КБ.

---

## 2. Структура монорепы (фактическая)

```
family-todo-tg-bot/
├── apps/
│   ├── api/                          # Hono + Drizzle
│   │   ├── src/
│   │   │   ├── db/
│   │   │   │   ├── client.ts
│   │   │   │   ├── schema/
│   │   │   │   │   ├── catalog.ts
│   │   │   │   │   ├── families.ts
│   │   │   │   │   ├── family-members.ts
│   │   │   │   │   ├── index.ts
│   │   │   │   │   ├── photos.ts          # task_photos (Telegram-native)
│   │   │   │   │   ├── rewards.ts         # rewards + redemptions + points_ledger
│   │   │   │   │   ├── roles.ts
│   │   │   │   │   ├── tasks.ts           # tasks + task_occurrences
│   │   │   │   │   ├── templates.ts
│   │   │   │   │   ├── transfers.ts
│   │   │   │   │   └── users.ts
│   │   │   │   └── migrations/
│   │   │   ├── middleware/
│   │   │   │   ├── auth.ts                # tma-auth (initData HMAC)
│   │   │   │   ├── family.ts              # requireFamily + requirePermission
│   │   │   │   └── service.ts             # x-service-token для бота
│   │   │   ├── routes/
│   │   │   │   ├── catalog.ts
│   │   │   │   ├── families.ts
│   │   │   │   ├── internal.ts            # bot ↔ api (invites, photo delete)
│   │   │   │   ├── me.ts
│   │   │   │   ├── occurrences.ts
│   │   │   │   ├── photos.ts              # upload + getUrl + delete
│   │   │   │   ├── rewards.ts
│   │   │   │   ├── roles.ts
│   │   │   │   ├── tasks.ts
│   │   │   │   ├── templates.ts
│   │   │   │   └── transfers.ts
│   │   │   ├── services/
│   │   │   │   ├── cooldown.ts
│   │   │   │   ├── families.ts
│   │   │   │   ├── occurrence-actions.ts  # complete / uncomplete / floating
│   │   │   │   ├── occurrences.ts         # planOccurrencesForWindow + sync
│   │   │   │   ├── photos.ts              # Telegram Bot API client
│   │   │   │   ├── queue-tasks.ts
│   │   │   │   ├── queue.ts                # pickNextAssignee
│   │   │   │   ├── rewards.ts
│   │   │   │   ├── tasks.ts
│   │   │   │   ├── transfers.ts
│   │   │   │   └── users.ts
│   │   │   ├── env.ts
│   │   │   ├── index.ts                   # Hono app + onError + CORS
│   │   │   └── logger.ts                  # Pino
│   │   ├── tests/
│   │   │   ├── db-helpers.ts              # makeUser / makeFamily / resetTables
│   │   │   └── services/
│   │   │       ├── cooldown.integration.test.ts
│   │   │       ├── queue.integration.test.ts
│   │   │       └── tasks.integration.test.ts
│   │   └── drizzle.config.ts
│   │
│   ├── bot/                          # grammY
│   │   ├── src/
│   │   │   ├── api-client.ts              # ходит в /internal/v1 с x-service-token
│   │   │   ├── env.ts
│   │   │   ├── index.ts                   # /start, /today, /help + callback delphoto
│   │   │   └── logger.ts
│   │   └── …
│   │
│   └── miniapp/                      # React 18 + Vite + TS
│       ├── src/
│       │   ├── api.ts                     # fetch-клиент + типы DTO
│       │   ├── App.tsx
│       │   ├── components/
│       │   │   ├── BottomSheet.tsx        # анимированный wrapper
│       │   │   ├── CreateTaskSheet.tsx
│       │   │   ├── TaskSheet.tsx
│       │   │   └── TransferSheet.tsx
│       │   ├── design/                    # wireframe primitives
│       │   │   ├── Av.tsx
│       │   │   ├── AvStack.tsx
│       │   │   ├── Bar.tsx
│       │   │   ├── Dot.tsx
│       │   │   ├── Icon.tsx
│       │   │   ├── Seg.tsx
│       │   │   ├── Tag.tsx
│       │   │   ├── types.ts
│       │   │   └── WfBody.tsx
│       │   ├── i18n.ts                    # словарь + LocaleProvider + useT
│       │   ├── pages/                     # Calendar, Day, Onboarding, Profile,
│       │   │                              # Shop, Queue{List,Detail}, Catalog,
│       │   │                              # Templates, Roles, History, Stats,
│       │   │                              # Search, Inbox, FamilyHome
│       │   ├── styles/
│       │   │   ├── global.css
│       │   │   └── wireframe.css
│       │   ├── telegram.ts                # initData accessor + initTelegram()
│       │   └── main.tsx
│       └── …
│
├── packages/
│   ├── shared/                       # zod-схемы + типы (CreateTaskInput, NotificationSettings, Permission, …)
│   ├── tg-auth/                      # верификация Telegram initData (HMAC)
│   └── config/                       # tsconfig.base, eslint-config
│
├── infra/
│   └── docker-compose.yml            # postgres + redis + adminer
│
├── docs/
│   ├── design-brief.md
│   ├── tech-plan.md                  # этот файл
│   └── design/family-todo/           # wireframe-исходники
│
├── turbo.json
├── pnpm-workspace.yaml
└── .env.example
```

**Чего не появилось** из исходного плана:
- `packages/api-client` — Mini App ходит напрямую через `fetch` из `apps/miniapp/src/api.ts`;
- `packages/ui` — wireframe-примитивы живут в `apps/miniapp/src/design/`;
- BullMQ-джоб ещё нет (см. §6).

---

## 3. Доменная модель

### 3.1. Сущности (всё в Drizzle, `apps/api/src/db/schema/`)

#### `users`
- `id` uuid pk
- `telegram_id` bigint unique not null
- `username`, `first_name`, `last_name`, `avatar_url`
- `locale` text default `'ru'`
- `timezone` text default `'Europe/Moscow'` (IANA)
- `color` text (hex)
- `notification_settings` jsonb — `{ quietHoursStart, quietHoursEnd, digestEnabled, digestTime, defaultReminderBeforeMinutes }`
- `away_until` timestamptz nullable
- `created_at`, `updated_at`

#### `families`
- `id` uuid pk
- `name`, `avatar_url`
- `owner_id` → users.id
- `invite_code` text unique (8 символов alphanumeric, генератор: `customAlphabet`)
- `created_at`

#### `family_members`
- (`family_id`, `user_id`) PK
- `role_id` → roles.id
- `joined_at`

#### `roles`
- `id` uuid pk
- `family_id` → families.id (system roles: Owner, Adult, Child создаются при первом `createFamily`)
- `name` text, `is_system` bool, `permissions` jsonb (array of permission keys)
- При создании семьи seedим три системных роли с дефолтными правами.

**Permission keys** (из `packages/shared`):
```
task.create | task.edit.own | task.edit.any | task.delete.own | task.delete.any
task.complete.any | catalog.manage | template.manage
reward.manage | reward.grant | reward.claim
stats.view.others | member.invite | member.kick | role.manage
```

#### `tasks`
Колонки матчат `CreateTaskInput` из `packages/shared/src/schemas/task.ts`:
- `id`, `family_id`, `title`, `description`
- `type` enum `oneoff | recurring | floating | queued`
- `schedule` jsonb (discriminated union по `kind`)
- `assignee_id`, `queue_user_ids` uuid[]
- `deadline_at` timestamptz
- `points` int, `photo_required` bool
- `single_shot` bool, `cooldown_days` int
- `subtasks_template` jsonb — `[{ id, title, position }]`
- `created_by`, `archived_at`

**Что НЕ сделано из плана:**
- `catalog_item_id` и `template_id` FK — пока не привязали (каталог пополняется по галке при создании, но без жёсткой связи).

#### `task_occurrences`
- `id`, `task_id` (cascade)
- `scheduled_date` date nullable
- `scheduled_time` time nullable
- `assignee_id` nullable
- `status` enum `pending | done | skipped | expired`
- `subtasks` jsonb (state)
- `available_at` timestamptz (для кулдауна)
- `completed_at`, `completed_by`
- `photo_ids` uuid[] — **deprecated**, не используется (фото теперь в `task_photos`)
- `points_awarded` int
- unique index: (`task_id`, `scheduled_date`)
  - **Важно:** PostgreSQL считает NULL distinct, поэтому несколько (task_id, NULL) сосуществуют. Для floating-завершений мы намеренно НЕ ставим `scheduled_date = today`, чтобы избежать конфликта при повторных выполнениях за день — см. `services/occurrence-actions.ts`.

#### `task_photos` (новая, см. §9)
- `id`, `task_id` (cascade), `occurrence_id` (set null), `user_id` (cascade)
- `telegram_file_id` text — канонический референс на фото в Telegram
- `telegram_message_id` bigint, `telegram_chat_id` bigint — bot-message в чате юзера
- `created_at`
- Никаких бинарных файлов, никаких URL.

#### `catalog_items`
- стандартно: `family_id`, `name`, `emoji`, `category`, `last_price_cents`, `last_currency`, `usage_count`, `last_used_at`, `created_by`
- unique по `(family_id, lower(name))`

#### `templates`
- `family_id` nullable (null = системный — сейчас seedим несколько при первом запуске)
- `name`, `emoji`, `payload` jsonb (снимок CreateTaskInput), `is_system`, `created_by`

#### `rewards`
- `family_id`, `name`, `emoji`, `description`, `cost_points`, `available_for_user_ids` uuid[]
- `archived_at`, `created_by`

#### `reward_redemptions`
- `reward_id` (set null), `user_id`, `family_id`, `cost_points` (snapshot)
- `status` enum `pending | granted | rejected`
- `requested_at`, `granted_at`, `granted_by`

#### `points_ledger`
- Append-only журнал начислений/списаний
- `family_id`, `user_id`, `delta` int (может быть отрицательным)
- `reason` enum `task_completed | reward_redeemed | manual_adjustment | streak_bonus`
- `ref_id` uuid (completion_id / redemption_id)
- Баланс = `SUM(delta)`, кэш — TODO.

#### `transfer_requests`
- `family_id`, `occurrence_id`, `from_user_id`, `to_user_id`
- `mode` enum `plain | swap | reward`
- `message`, `swap_occurrence_ids` uuid[], `rewards` jsonb
- `status` enum `pending | accepted | rejected | expired | cancelled`
- `expires_at` (now + 3h), `resolved_at`, `created_at`

#### **Не сделано:**
- `task_completions` — отдельный журнал не вводили; вся история живёт в `task_occurrences` (`status='done'`) и `points_ledger`. Если понадобятся стрики/лидерборд из истории — пересчитываем на лету в Mini App, см. `Shop.tsx`. Кэш-таблица **TODO**.
- `streaks` — не вводили, считаем на клиенте.
- `invitations` — обходимся одним `invite_code` на семью.

### 3.2. Очередь — алгоритм балансировки

`apps/api/src/services/queue.ts` — `pickNextAssignee`:
1. Берём `queue_user_ids` или всех членов семьи.
2. Исключаем тех, у кого `away_until > now()`.
3. Считаем `count(task_occurrences WHERE task_id = ? AND completed_by = u.id AND status='done')`.
4. Минимальное число — следующий. При равенстве — `joined_at` участника.
5. Если все в away — возвращаем `null`, фронт показывает «некому делать».

`ensureQueuedOccurrence` после completion создаёт следующий pending с новым assignee.

### 3.3. Кулдаун (floating и queued)

- При выполнении floating-задачи с `cooldown_days > 0` создаётся новый pending occurrence с `available_at = now + N days`.
- `isFloatingAvailable({ availableAt, now })` — pure-функция, используется и в `completeFloatingTask` (запретить раннее), и на фронте (скрыть из «Когда-нибудь» rollup до момента).
- Watcher-джоба пока **не нужна** — фронт + API проверяют `available_at` каждый раз.

---

## 4. API

### 4.1. Авторизация

- Mini App шлёт `Authorization: tma <initData>`.
- `tgAuth` middleware (`apps/api/src/middleware/auth.ts`): верифицирует HMAC по `TELEGRAM_BOT_TOKEN` через `@telegram-apps/init-data-node`, делает upsert `users`, кладёт `user` в Hono context.
- Бот → API ходит по `INTERNAL_SERVICE_TOKEN` через middleware `serviceAuth` на префиксе `/internal/v1`.

### 4.2. Эндпойнты (актуальные)

Все маршруты — под `/api/v1`. Семейный контекст в пути.

```
# Auth / профиль
GET    /me
PATCH  /me                                    # color, locale, timezone, notificationSettings, awayUntil

# Families
GET    /families                              # все мои
POST   /families                              # body: { name, avatarUrl? }
POST   /families/join                         # body: { code }
GET    /families/peek/:code                   # превью семьи без вступления
POST   /families/:familyId/leave              # выйти (не для owner)
GET    /families/:familyId/members

# Tasks
GET    /families/:familyId/tasks
POST   /families/:familyId/tasks
PATCH  /families/:familyId/tasks/:taskId
DELETE /families/:familyId/tasks/:taskId      # архивация
POST   /families/:familyId/tasks/:taskId/complete-floating

# Occurrences
GET    /families/:familyId/occurrences?from=&to=
POST   /families/:familyId/occurrences/:occId/complete
POST   /families/:familyId/occurrences/:occId/uncomplete

# Catalog
GET    /families/:familyId/catalog?q=
POST   /families/:familyId/catalog
PATCH  /families/:familyId/catalog/:itemId
DELETE /families/:familyId/catalog/:itemId

# Templates
GET    /families/:familyId/templates
POST   /families/:familyId/templates
DELETE /families/:familyId/templates/:templateId

# Rewards
GET    /families/:familyId/rewards
POST   /families/:familyId/rewards
DELETE /families/:familyId/rewards/:rewardId
POST   /families/:familyId/rewards/:rewardId/redeem
GET    /families/:familyId/rewards/redemptions?status=pending|granted|rejected
POST   /families/:familyId/rewards/redemptions/:redId/grant
POST   /families/:familyId/rewards/redemptions/:redId/reject
GET    /families/:familyId/rewards/balance/me

# Transfers
GET    /families/:familyId/transfers/incoming
POST   /families/:familyId/transfers           # body: { occurrenceId, toUserId, mode, message? }
POST   /families/:familyId/transfers/:transferId/accept
POST   /families/:familyId/transfers/:transferId/reject

# Roles
GET    /families/:familyId/roles
PATCH  /families/:familyId/roles/:roleId       # обновить permissions
POST   /families/:familyId/roles/assign        # body: { userId, roleId }

# Photos (Telegram-native, см. §9)
POST   /families/:familyId/occurrences/:occId/photos     # multipart, поле "file"
GET    /families/:familyId/tasks/:taskId/photos
GET    /families/:familyId/occurrences/:occId/photos
GET    /families/:familyId/photos/:photoId/url
DELETE /families/:familyId/photos/:photoId

# Internal (только бот, x-service-token)
GET    /internal/v1/invites/:code
POST   /internal/v1/photos/:photoId/delete     # body: { telegramId }
```

**Чего пока нет (TODO):**
- `PATCH /families/:familyId` (переименовать)
- `DELETE /families/:familyId` (owner-only удаление)
- `POST /families/:familyId/invite/rotate`
- `DELETE/PATCH /families/:familyId/members/:userId` (kick / смена роли через путь)
- `POST /occurrences/:id/snooze`
- `GET /stats`, `GET /leaderboard` — пока считаются на клиенте

### 4.3. Live-обновления

Поллинг через TanStack Query: `refetchInterval: 8000` + `refetchOnWindowFocus: true`. При мутации — `queryClient.invalidateQueries`. Реальный realtime (SSE/Centrifugo) — **TODO**.

### 4.4. Глобальный error handler

`app.onError` в `apps/api/src/index.ts` логирует стек и возвращает JSON `{ error: 'internal_server_error', message: <реальная в dev> }`. В проде сообщение скрыто.

---

## 5. Бот (grammY)

### 5.1. Команды

- `/start` — приветствие + кнопка `webApp` на Mini App.
- `/start <code>` — превью семьи через `/internal/v1/invites/:code`, кнопка `Войти`.
- `/today` — заглушка (TODO).
- `/help` — список команд.

### 5.2. Callback handlers

- `callbackQuery(/^delphoto:(.+)$/, …)` — кнопка `🗑 Удалить фото` под фото-сообщением:
  - Извлекает `photoId` и telegram_id юзера;
  - POST в `/internal/v1/photos/:id/delete` с `{ telegramId }`;
  - API сам убирает row из `task_photos` и пытается `deleteMessage` (или fallback на edit caption);
  - Бот отвечает callback-toast `🗑 Удалено`.

### 5.3. Уведомления (BullMQ-джобы) — **TODO**

| Тип | Триггер | Получатель |
|---|---|---|
| Утренний дайджест | по `digestTime` в timezone | сам пользователь |
| Напоминание о задаче | за `defaultReminderBeforeMinutes` до `scheduled_time` | assignee |
| Просрочка | через 1 час после scheduled_time | assignee |
| Очередь дошла | при completion предыдущим | новый assignee |
| Запрос на передачу | при создании transfer_requests | toUserId |
| Просьба приза | при redeem | пользователи с `reward.grant` |

Все — с учётом `quietHoursStart..End`. Сейчас в Mini App пользователь МОЖЕТ сохранить preferences (`profile.notifications.*`), но фактически уведомления не отправляются.

---

## 6. Фоновые джобы — **TODO**

Все пока **не реализованы**. План:

| Джоба | Расписание | Что делает |
|---|---|---|
| `generate-occurrences` | каждые 6ч | разворачивает recurring на 30 дней вперёд |
| `mark-expired` | каждый час | pending с прошедшим `scheduled_date` → `expired` |
| `cooldown-watcher` | каждый час | re-checks `available_at` (вообще можно опустить — клиент сам фильтрует) |
| `morning-digest` | каждую минуту | дайджест каждому по его `digestTime` в TZ |
| `reminder-scheduler` | при изменении occurrence | планирует одиночный job |
| `transfer-expiry` | каждые 5 мин | помечает истёкшие transfer_requests |
| `streak-recalc` | ночью | пересчёт стриков |
| `points-cache-refresh` | при изменении ledger | Redis-кэш баланса |

Сейчас `recurring-задачи` пересоздают occurrences через `syncOccurrencesForTask` в момент creation/update — длинных серий нет, и для MVP достаточно.

---

## 7. Авторизация и права

Middleware-цепочка для семейных маршрутов:

1. `tgAuth` — initData HMAC → user.
2. `requireFamily` — проверяет membership, грузит `role.permissions` в context.
3. `requirePermission(key)` — проверка конкретного права.

Пример:
```ts
tasksRouter.delete('/:taskId', async (c) => {
  const user = c.get('user');
  const familyId = c.get('familyId');
  const task = await getTaskInFamily(c.req.param('taskId'), familyId);
  if (!task) return c.json({ error: 'task_not_found' }, 404);
  const isOwn = task.createdBy === user.id;
  const needed: Permission = isOwn ? 'task.delete.own' : 'task.delete.any';
  if (!c.get('permissions').includes(needed)) {
    return c.json({ error: 'forbidden', permission: needed }, 403);
  }
  await archiveTask(task.id);
  return c.body(null, 204);
});
```

---

## 8. Фронт (Mini App)

### 8.1. Архитектура

- **Pages** в `src/pages/`: `Onboarding`, `Calendar`, `Day`, `Profile`, `Shop`, `QueueList`, `QueueDetail`, `Catalog`, `Templates`, `Roles`, `History`, `Stats`, `Search`, `Inbox`, `FamilyHome` (router-hub).
- **Components** в `src/components/`: `BottomSheet` (анимированный), `TaskSheet`, `CreateTaskSheet`, `TransferSheet`.
- **Design system** в `src/design/`: `Av`, `AvStack`, `Bar`, `Dot`, `Icon`, `Seg`, `Tag`, `WfBody`. Все классы — wireframe-tokens (`wf-card`, `wf-row`, `wf-h2`, …).
- Навигация — **самописный hash-router в `FamilyHome.tsx`**:
  - `serializeRoute(route) → '#/calendar' | '#/day/:iso' | '#/profile/stats' …`
  - `parseRoute(hash)` на mount;
  - `replaceState` на смену route, listener на `hashchange` для back/forward;
  - `tab` derived из route (Calendar/Queues/Shop/Profile).

### 8.2. State

- Серверный — TanStack Query с агрессивным поллингом (8s) и refetchOnFocus.
- Локальный — `useState/useReducer`. Глобального стора нет — мульти-семьи и фильтры держим в `FamilyHome`-state.

### 8.3. Тема

- iOS rubber-band залочен в `global.css` (`html, body { position: fixed; overflow: hidden; overscroll-behavior: none }`).
- Tap-highlight убран глобально (`-webkit-tap-highlight-color: transparent`).
- User-select запрещён глобально, разрешён на `input`, `textarea`, `.wf-mono`, `.is-selectable`.
- Wireframe-токены в `wireframe.css` — пока без отдельной dark-темы.

### 8.4. Bottom-sheets

`components/BottomSheet.tsx` — единая обёртка с анимациями (slide-up enter / slide-down exit, 240 мс). Render-prop отдаёт `close(after?)` хелпер: child зовёт его вместо `onClose`, sheet проигрывает exit-анимацию, затем вызывает `onClose` или `after`.

Используется в TaskSheet, CreateTaskSheet, TransferSheet, FloatingPicker (Day), TimezonePicker (Profile), DigestPicker/ReminderPicker/QuietHoursPicker/LanguagePicker (Profile).

### 8.5. i18n

`src/i18n.ts`:
- Словарь `key → { ru, en }` (~250 ключей).
- `<LocaleProvider locale={me.locale}>` оборачивает App; локаль меняется через `api.updateMe({ locale })` + TanStack `invalidateQueries(['me'])` — UI пересобирается мгновенно.
- `useT()` хук + `interpolate('{name}', { name })`.
- `pluralize(locale, n, [ru.one,few,many], [en.one,many])`.

### 8.6. FAB

`.wf-fab` — pill-button `+ <название>` (Calendar/Day → «Add task»; QueueList → «Add queue») в центре над bottom-nav, `position: fixed` + safe-area. `:has(.wf-fab)` селектор поднимает padding-bottom у `.wf-body` только на страницах с FAB.

---

## 9. Хранилище фото — **Telegram-native (без S3)**

S3/MinIO **исключены**. Фото живут в Telegram, у нас — только метаданные.

### 9.1. Поток upload

1. Клиент: `POST /api/v1/families/:fid/occurrences/:oid/photos` (multipart, поле `file`).
2. API проверяет авторизацию, MIME, размер ≤ `PHOTO_MAX_SIZE_BYTES`, лимит на occurrence (`PHOTO_MAX_COUNT_PER_OCCURRENCE`).
3. `services/photos.ts → sendTaskPhoto`:
   - Берёт `users.telegram_id` (= `chat_id` приватного чата с ботом);
   - `POST https://api.telegram.org/bot<TOKEN>/sendPhoto` multipart с caption `📸 Фото добавлено к задаче: «<title>»`;
   - Парсит `file_id` (берёт самый большой размер) и `message_id`;
   - INSERT row в `task_photos`;
   - Async (best-effort): `editMessageReplyMarkup` с клавиатурой `[🗒 Открыть задачу][🗑 Удалить фото]`.
4. API отдаёт `{ photo: { id, taskId, occurrenceId, userId, createdAt } }`.

### 9.2. Поток отображения

- Mini App запрашивает список: `GET /tasks/:tid/photos` или `/occurrences/:oid/photos`.
- На каждое превью — `GET /photos/:photoId/url`, бэк зовёт `getFile`, возвращает `https://api.telegram.org/file/bot<TOKEN>/<path>`. URL живёт ≈ 1ч; клиент кэширует на 45 мин (TanStack Query `staleTime`).
- `<img src={url}>` грузит напрямую с Telegram CDN — API байты НЕ проксирует.

### 9.3. Поток удаления

1. **Из Mini App** — `DELETE /photos/:photoId`. Owner всегда может, иначе нужно `task.delete.any`.
2. **Из чата бота** — тап `🗑 Удалить фото` → `callback_query` `delphoto:<photoId>` → бот POST в `/internal/v1/photos/:id/delete` с `{ telegramId }`. API проверяет совпадение `telegramId == photo.telegram_chat_id`.
3. Backend: DELETE row → `deleteMessage` (best-effort, ≤48ч). Если не получилось — `editMessageCaption` "🗑 Фото удалено" + пустая клавиатура.

### 9.4. Что мы НЕ храним

- Бинарных файлов.
- URL фото (URL короткоживущий, генерится на лету).
- `s3_key` или похожих идентификаторов вне Telegram.

### 9.5. Лимиты (env)

- `PHOTO_MAX_SIZE_BYTES` (default 10MB — лимит `sendPhoto`).
- `PHOTO_MAX_COUNT_PER_OCCURRENCE` (default 3).
- `PHOTO_ALLOWED_MIME` (default `image/jpeg,image/png,image/webp`).

### 9.6. Известные ограничения

- Юзер ДОЛЖЕН хотя бы раз сделать `/start` в чате с ботом — иначе `sendPhoto` падает с `chat_id not found`. Mini App открывает бот через WebApp button, а WebApp button требует прохода через бот — на практике первая встреча неизбежна, но edge-case учитываем.
- Удалить bot-сообщение старше 48ч Telegram не разрешает (Bot API restriction) — fallback на edit caption.

---

## 10. Текущее состояние / MVP-граф

### MVP-0 (скелет) — ✅ done
- Монорепа, docker-compose, миграции.
- TG-auth, регистрация, создание/вход в семью.
- Tasks: все 4 типа (oneoff, recurring, floating, queued).
- Календарь (месяц).
- Бот: `/start`, deep-link с invite_code.

### MVP-1 (основа продукта) — ✅ done
- Floating + queued с балансировкой.
- Cooldown для floating и queued.
- Подзадачи.
- Calendar (месяц + day-детали), фильтры по участникам.
- TaskSheet с edit + transfer.
- Transfer с тремя модами (plain, swap, reward).
- Profile с away-mode, timezone-picker, color-picker.
- **Notification settings UI** (Profile) — preferences сохраняются, доставка TODO.

### MVP-2 (геймификация) — ✅ done
- Очки (`points_ledger`), баланс.
- Стрики (вычисляются на клиенте по `task_occurrences`).
- Призы (`rewards`, `reward_redemptions`).
- Shop tab (Очки / Стрики / Магазин) — podium, 21-day calendar, trophy grid.
- **Фото-пруф через Telegram-native storage** — see §9.

### MVP-3 (масштабирование) — ✅ в основном
- Шаблоны (системные + пользовательские).
- Каталог с автодополнением.
- Роли с настраиваемыми правами (RolV1 + RolV2 UI).
- Локализация RU/EN.
- History, Stats, Search, Inbox экраны.

### Post-MVP — статус
Реализовано в текущей итерации:
- **BullMQ-уведомления** ✅ — daily digest + per-occurrence reminders.
  Per-user repeatable cron job в их `digestTime`+`timezone`, idempotency
  через `notifications_log`, quiet-hours фильтр при отправке. См.
  `apps/api/src/queue/`.
- **Webhook режим бота** ✅ — `apps/bot/src/index.ts`: при
  `TELEGRAM_WEBHOOK_URL` биндит http на `BOT_PORT`, регистрирует webhook,
  валидирует secret-token. Без переменной — long-polling.
- **Realtime SSE** ✅ — `apps/api/src/realtime/pubsub.ts` (Redis pub/sub) +
  `routes/events.ts` (SSE с auth по query). Frontend `useFamilyEvents`
  invalidates TanStack Query keys по событиям. Поллинг 8s оставлен как
  fallback.
- **Доп. эндпойнты семьи** ✅ — `PATCH /:familyId` (rename),
  `DELETE /:familyId`, `POST /invite/rotate`, `DELETE /members/:userId`
  (kick). UI: Profile.tsx — Danger zone + MemberActionsSheet.
- **Reschedule + Stop-repeat** ✅ —
  `POST /occurrences/:id/reschedule`, ReschedulePicker в TaskSheet;
  «Прекратить повторы» переиспользует `archiveTask`.
- **Stats API** ✅ — `GET /api/v1/families/:id/stats?period=…` отдает
  byMember + topTasks + streaks + unfairness. `Stats.tsx` больше не
  тянет все occurrences.
- **Deploy** ✅ — `Dockerfile` × 3, `nginx.conf` SPA fallback,
  `infra/docker-compose.prod.yml`, `docs/deploy.md`. Migrate path resolver
  работает в dev (tsx) и prod (compiled).
- **Photo upload UX** ✅ — оптимистичный thumbnail с blob URL,
  spinner overlay, dismiss-кнопка при ошибке.
- **Bundle split** ✅ — Vite `manualChunks` → vendor-react /
  vendor-query / vendor-tg отдельно для долгоживущего кэша.
- **`/today` команда бота** ✅ — `GET /internal/v1/today/:tgId` →
  список pending-задач на сегодня по всем семьям.
- **Subtasks toggle** ✅ — `PATCH /occurrences/:id/subtasks`.

Остаётся:
- **Streak-cache table** — теперь когда stats считаются на сервере,
  ценность сомнительна. Откладываем до момента, когда профайлинг покажет.
- **Playwright e2e** — критичные флоу (онбординг, completion, transfer,
  reward redeem). Требует CI-инфраструктуры + фикстур.
- **OpenTelemetry** — Pino-логов хватает для текущего стейджа, OTel
  добавит ~3 MB зависимостей; включим когда нужен будет distributed
  tracing.

---

## 11. Финальные технические решения

1. **Runtime:** Node 22 LTS.
2. **Разделение:** `apps/api` и `apps/bot` — отдельные процессы. Бот ходит в API через `INTERNAL_SERVICE_TOKEN` (`/internal/v1/*`).
3. **Хранилище фото:** Telegram-native (§9). S3 убран.
4. **Аутентификация:** initData HMAC через `@telegram-apps/init-data-node`. Сессии не вводили — initData дешёво верифицировать на каждом запросе.
5. **Метрики / логи:** Pino (`apps/api/src/logger.ts`). OpenTelemetry — TODO (no immediate need).
6. **Тестирование:** Vitest unit + integration с truncate-харнессом между тестами (`tests/db-helpers.ts`). 64/64 теста зелёные. Playwright — TODO.
7. **Realtime:** SSE через Redis pub/sub (см. `apps/api/src/realtime/`). Поллинг 8s остается как fallback.
8. **Очередь джоб:** BullMQ + ioredis. Воркер в-процессе с API (см. `apps/api/src/queue/worker.ts`). При горизонтальном скейле — вынести в отдельный процесс.

---

## 12. Что делаем дальше

В порядке приоритета:

1. **Playwright e2e** на критичные флоу: онбординг, completion, transfer,
   reward redeem. Требует CI-конфиг + browser fixture.
2. **Streak-cache table** — если профайлинг stats-эндпоинта покажет, что
   `to_char(... AT TIME ZONE 'UTC', ...)` группировка дороже комфортного.
3. **OpenTelemetry** — distributed tracing при горизонтальном скейле или
   когда нужно профилировать прод-инциденты.
4. **Photo upload progress** — XHR progress events вместо просто spinner
   (сейчас только статус "идёт"/"ошибка").

---

## Приложения

- `apps/api/src/db/migrations/` — все накатанные миграции (последняя `0006_blushing_ultimates.sql` — `notifications_log`).
- `apps/api/tests/services/*` — pattern для писания backend-тестов.
- `apps/miniapp/src/api.ts` — единый источник правды по DTO для фронта.
- `packages/shared/src/schemas/*.ts` — Zod-схемы, разделяемые между бэком и фронтом.
