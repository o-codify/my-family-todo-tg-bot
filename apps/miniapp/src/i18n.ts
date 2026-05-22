import { createContext, createElement, useContext, type ReactNode } from 'react';

/**
 * App-wide i18n.
 *
 * `me.locale` (from the backend) drives the active locale. Components read it
 * via `useT()` and call `t('key')`. Missing translations fall back to RU
 * (the UI's original tongue), then to the raw key as a last resort so it's
 * obvious in dev what's missing.
 */

export type Locale = 'ru' | 'en';

const SUPPORTED: Locale[] = ['ru', 'en'];

export function normalizeLocale(input: string | undefined | null): Locale {
  if (!input) return 'ru';
  const head = input.toLowerCase().slice(0, 2);
  return (SUPPORTED.includes(head as Locale) ? head : 'ru') as Locale;
}

// ─── Dictionary ────────────────────────────────────────────────────────────
//
// Organised by feature area. Keys are stable; values pair RU and EN strings.
// When adding new UI text:
//   1. Pick a key under the matching area.
//   2. Provide both RU + EN. If you don't know EN, leave a TODO so the next
//      pass can fill it in — the runtime will fall back to RU and not crash.

const DICT: Record<string, Record<Locale, string>> = {
  // ─── common ────────────────────────────────────────────────────────
  'common.back': { ru: 'Назад', en: 'Back' },
  'common.close': { ru: 'Закрыть', en: 'Close' },
  'common.cancel': { ru: 'Отмена', en: 'Cancel' },
  'common.save': { ru: 'Сохранить', en: 'Save' },
  'common.create': { ru: 'Создать', en: 'Create' },
  'common.creating': { ru: 'Создаём…', en: 'Creating…' },
  'common.saving': { ru: 'Сохраняем…', en: 'Saving…' },
  'common.sending': { ru: 'Отправляем…', en: 'Sending…' },
  'common.loading': { ru: 'Загрузка…', en: 'Loading…' },
  'common.delete': { ru: 'Удалить', en: 'Delete' },
  'common.edit': { ru: 'Изменить', en: 'Edit' },
  'common.add': { ru: 'Добавить', en: 'Add' },
  'common.search': { ru: 'Поиск', en: 'Search' },
  'common.search.placeholder': { ru: 'Поиск…', en: 'Search…' },
  'common.notFound': { ru: 'Ничего не найдено', en: 'Nothing found' },
  'common.retry': { ru: 'Повторить', en: 'Retry' },
  'common.soon': { ru: 'скоро', en: 'soon' },
  'common.optional': { ru: 'опц.', en: 'opt.' },
  'common.everyone': { ru: 'Все', en: 'Everyone' },
  'common.mine': { ru: 'Мои', en: 'Mine' },
  'calendar.filter.pending': { ru: 'Не сделанные', en: 'Pending' },
  'calendar.filter.withPhoto': { ru: 'С фото', en: 'With photo' },
  'calendar.view.month': { ru: 'Месяц', en: 'Month' },
  'calendar.view.week': { ru: 'Неделя', en: 'Week' },
  'calendar.view.agenda': { ru: 'Лента', en: 'Agenda' },
  'calendar.agenda.empty': {
    ru: 'Ничего не запланировано на ближайшие 30 дней',
    en: 'Nothing scheduled in the next 30 days',
  },
  'history.type.all': { ru: 'Все', en: 'All' },
  'history.type.tasks': { ru: 'Задачи', en: 'Tasks' },
  'history.type.rewards': { ru: 'Призы', en: 'Rewards' },
  'history.type.photos': { ru: 'С фото', en: 'With photo' },
  'history.reward.granted': { ru: 'получил приз', en: 'received reward' },
  'history.reward.requested': { ru: 'запросил приз', en: 'requested reward' },
  'tour.skip': { ru: 'Пропустить', en: 'Skip' },
  'tour.back': { ru: 'Назад', en: 'Back' },
  'tour.next': { ru: 'Дальше', en: 'Next' },
  'tour.done': { ru: 'Готово', en: 'Done' },
  'tour.step.create.title': { ru: 'Добавь задачу', en: 'Add a task' },
  'tour.step.create.body': {
    ru: 'Кнопка «+» внизу — отсюда создаются новые задачи. Дата, повтор, ответственный — всё на одном экране.',
    en: 'Tap the “+” at the bottom to add tasks. Date, repeat, assignee — all on one screen.',
  },
  'tour.step.invite.title': { ru: 'Позови близких', en: 'Invite your family' },
  'tour.step.invite.body': {
    ru: 'Открой меню сверху-слева → Настройки. Там кнопка «Пригласить» с ссылкой для отправки.',
    en: 'Open the menu (top-left) → Settings. There’s an “Invite” button with a shareable link.',
  },
  'tour.step.queues.title': { ru: 'Очереди', en: 'Queues' },
  'tour.step.queues.body': {
    ru: 'Задачи, которые делает то один, то другой по кругу: посуда, мусор и так далее. Меню → Очереди.',
    en: 'Tasks people take turns on — dishes, trash, etc. Menu → Queues.',
  },
  'tour.step.shop.title': { ru: 'Призы', en: 'Rewards' },
  'tour.step.shop.body': {
    ru: 'Очки за задачи можно тратить на семейные призы. Меню → Призы.',
    en: 'Spend earned points on family rewards. Menu → Rewards.',
  },
  'tour.step.settings.title': { ru: 'Настройки', en: 'Settings' },
  'tour.step.settings.body': {
    ru: 'Цвет, часовой пояс, уведомления, язык — всё в Настройках. Меню → Настройки.',
    en: 'Color, timezone, notifications, language — all under Settings. Menu → Settings.',
  },
  'common.ok': { ru: 'ОК', en: 'OK' },
  'common.undo': { ru: 'Отменить', en: 'Undo' },
  'common.deleted': { ru: 'Удалено', en: 'Deleted' },
  'common.restoreFailed': { ru: 'Не удалось восстановить', en: 'Could not restore' },
  'task.action.snooze': { ru: 'Отложить', en: 'Snooze' },
  'task.snooze.tomorrow': { ru: 'Завтра', en: 'Tomorrow' },
  'task.snooze.dayAfter': { ru: 'Послезавтра', en: 'Day after' },
  'task.snooze.weekend': { ru: 'До выходных', en: 'This weekend' },
  'task.snooze.3days': { ru: 'Через 3 дня', en: 'In 3 days' },
  'task.snooze.week': { ru: 'Через неделю', en: 'In a week' },

  // ─── nav / drawer ──────────────────────────────────────────────────
  'nav.calendar': { ru: 'Календарь', en: 'Calendar' },
  'nav.queues': { ru: 'Очереди', en: 'Queues' },
  'nav.shop': { ru: 'Призы', en: 'Rewards' },
  'nav.profile': { ru: 'Настройки', en: 'Settings' },
  'nav.menu': { ru: 'Меню', en: 'Menu' },
  'nav.section.main': { ru: 'Основное', en: 'Main' },
  'nav.section.extras': { ru: 'Дополнительно', en: 'More' },
  'nav.history': { ru: 'История', en: 'History' },
  'nav.stats': { ru: 'Статистика', en: 'Stats' },
  'nav.catalog': { ru: 'Каталог', en: 'Catalog' },
  'nav.templates': { ru: 'Шаблоны', en: 'Templates' },
  'nav.roles': { ru: 'Роли', en: 'Roles' },
  'nav.search': { ru: 'Поиск', en: 'Search' },
  'nav.inbox': { ru: 'Входящие', en: 'Inbox' },
  'nav.myProfile': { ru: 'Мой профиль', en: 'My profile' },

  // ─── calendar ──────────────────────────────────────────────────────
  'calendar.someday': { ru: 'Когда-нибудь', en: 'Someday' },
  'calendar.empty.title': { ru: 'Пока ни одной задачи', en: 'No tasks yet' },
  'calendar.empty.hint': {
    ru: 'Создай первую — кнопка «+» внизу',
    en: 'Create your first one with the “+” at the bottom',
  },
  'calendar.empty.cta': { ru: '+ Создать задачу', en: '+ Create task' },
  'calendar.day.empty': { ru: 'Нет задач на этот день', en: 'No tasks for this day' },
  'calendar.invite.title': { ru: 'Пригласить близких', en: 'Invite your family' },
  'calendar.invite.hint': { ru: 'пока ты тут один', en: 'you’re here alone for now' },
  'calendar.today': { ru: 'сегодня', en: 'today' },
  'calendar.repeat': { ru: 'Повтор', en: 'Repeats' },
  'calendar.overdue': { ru: 'просрочено', en: 'overdue' },
  'calendar.done.collapsed': { ru: 'Выполнено', en: 'Completed' },
  'calendar.fab': { ru: 'Добавить задачу', en: 'Add task' },

  // ─── day ──────────────────────────────────────────────────────────
  'day.overdue.title': { ru: 'Просрочено', en: 'Overdue' },
  'day.today.section': { ru: 'На сегодня', en: 'For today' },
  'day.thisday.section': { ru: 'На этот день', en: 'For this day' },
  'day.free.title': { ru: 'Свободный день', en: 'Free day' },
  'day.free.hint': {
    ru: 'На этот день ничего не запланировано — можно отдохнуть или взять задачу из «Когда-нибудь»',
    en: 'Nothing planned — relax or pick a task from "Someday"',
  },
  'day.free.add': { ru: '+ Добавить на день', en: '+ Add to this day' },
  'day.free.takeSomeday': { ru: 'Взять из «Когда-нибудь»', en: 'Take from "Someday"' },
  'day.someday.title': { ru: '«Когда-нибудь»', en: '"Someday"' },
  'day.someday.empty': { ru: 'Свободных задач сейчас нет', en: 'No free tasks right now' },
  'day.someday.hint': {
    ru: 'Выбери задачу — откроется карточка с «Выполнил»',
    en: 'Pick a task — its sheet opens with "Done"',
  },
  'day.fab': { ru: 'Добавить задачу', en: 'Add task' },
  'day.unassigned': { ru: 'свободная', en: 'unassigned' },

  // ─── task sheet ────────────────────────────────────────────────────
  'task.tag.recurring': { ru: 'Повтор', en: 'Recurring' },
  'task.tag.queued': { ru: 'По очереди', en: 'Queued' },
  'task.tag.floating': { ru: 'Без даты', en: 'No date' },
  'task.tag.deadline': { ru: '⏰ до', en: '⏰ by' },
  'task.tag.points': { ru: 'очков', en: 'pts' },
  'task.tag.photo': { ru: 'Фото', en: 'Photo' },
  'task.subtasks.title': { ru: 'Подзадачи', en: 'Subtasks' },
  'task.photo.title': { ru: 'Фото', en: 'Photo' },
  'task.photo.placeholder': {
    ru: 'Описание фото (опц.) — скоро',
    en: 'Photo description (opt.) — soon',
  },
  'task.action.transfer': { ru: 'Передать', en: 'Pass on' },
  'task.action.reschedule': { ru: 'Перенести', en: 'Reschedule' },
  'task.action.complete': { ru: 'Выполнил', en: 'Done' },
  'task.action.completing': { ru: 'Выполняем…', en: 'Completing…' },
  'task.action.uncomplete': { ru: 'Отменить выполнение', en: 'Undo completion' },
  'task.photo.required': {
    ru: '«Выполнил» включится после фото',
    en: '"Done" will enable after a photo is added',
  },
  'task.history.done': { ru: 'Выполнено', en: 'Completed' },
  'task.err.photo': {
    ru: 'Прикрепите фото перед выполнением',
    en: 'Attach a photo before completing',
  },
  'task.err.forbidden': {
    ru: 'Нет прав на выполнение этой задачи',
    en: 'No permission to complete this task',
  },

  // ─── create task ───────────────────────────────────────────────────
  'create.title.new': { ru: 'Новая задача', en: 'New task' },
  'create.title.edit': { ru: 'Изменить задачу', en: 'Edit task' },
  'create.field.title': { ru: 'Что сделать', en: 'What to do' },
  'create.field.title.placeholder': { ru: 'Полить цветы', en: 'Water the plants' },
  'create.addToCatalog': { ru: 'Добавить в каталог', en: 'Add to catalog' },
  'create.field.type': { ru: 'Тип', en: 'Type' },
  'create.kind.oneoff': { ru: 'Разовая', en: 'One-off' },
  'create.kind.recurring': { ru: 'Повтор', en: 'Recurring' },
  'create.kind.floating': { ru: 'Без даты', en: 'No date' },
  'create.kind.queued': { ru: 'По очереди', en: 'Queued' },
  'create.field.date': { ru: 'Дата', en: 'Date' },
  'create.noDate': { ru: 'Без даты', en: 'No date' },
  'create.noDate.hint': {
    ru: 'Задача появится в «Когда-нибудь» — выполнить можно когда угодно',
    en: 'The task lives in "Someday" — complete it whenever',
  },
  'create.field.daysOfWeek': { ru: 'По дням недели', en: 'On weekdays' },
  'create.field.singleShot': {
    ru: 'Однократно (исчезнет после выполнения)',
    en: 'One-shot (disappears after completion)',
  },
  'create.field.cooldown': { ru: 'Кулдаун', en: 'Cooldown' },
  'create.cooldown.off': { ru: 'Выкл', en: 'Off' },
  'create.cooldown.day': { ru: '1 день', en: '1 day' },
  'create.cooldown.3days': { ru: '3 дня', en: '3 days' },
  'create.cooldown.week': { ru: 'неделя', en: '1 week' },
  'create.cooldown.2weeks': { ru: '2 недели', en: '2 weeks' },
  'create.cooldown.month': { ru: 'месяц', en: '1 month' },
  'create.field.assignee': { ru: 'Ответственный', en: 'Assignee' },
  'create.assignee.unassigned': { ru: 'Свободная', en: 'Unassigned' },
  'create.field.deadline': { ru: 'Дедлайн', en: 'Deadline' },
  'create.deadline.empty': { ru: '— нет —', en: '— none —' },
  'create.field.reward': { ru: 'Награда', en: 'Reward' },
  'create.field.reward.points': { ru: 'очков', en: 'pts' },
  'create.field.photo': { ru: 'Фото', en: 'Photo' },
  'create.photo.required': { ru: 'Обязательно', en: 'Required' },
  'create.photo.optional': { ru: 'Не требуется', en: 'Optional' },
  'create.template': { ru: 'Шаблон', en: 'Template' },
  'create.template.on': { ru: '✓ Шаблон', en: '✓ Template' },
  'create.subtasks.title': { ru: 'Подзадачи', en: 'Subtasks' },
  'create.subtasks.placeholder': { ru: 'Что нужно сделать', en: 'What to do' },
  'create.subtasks.add': { ru: 'Добавить подзадачу', en: 'Add subtask' },
  'create.confirm.delete': {
    ru: 'Удалить задачу? История выполнений сохранится.',
    en: 'Delete this task? Completion history is preserved.',
  },
  'create.err.forbidden': { ru: 'Нет прав на создание задач', en: 'No permission to create tasks' },

  // ─── transfer ──────────────────────────────────────────────────────
  'transfer.mode.plain': { ru: 'Просто', en: 'Plain' },
  'transfer.mode.swap': { ru: 'Обмен', en: 'Swap' },
  'transfer.mode.reward': { ru: 'Награда', en: 'Reward' },
  'transfer.title.plain': { ru: 'Передать задачу', en: 'Pass on a task' },
  'transfer.title.swap': { ru: 'Обмен задачами', en: 'Swap tasks' },
  'transfer.title.reward': { ru: 'С вознаграждением', en: 'With a reward' },
  'transfer.giving': { ru: 'Ты отдаёшь', en: 'You give' },
  'transfer.to.plain': { ru: 'Кому передаёшь?', en: 'Who to pass it to?' },
  'transfer.to.recipient': { ru: 'Кому', en: 'Recipient' },
  'transfer.alone': { ru: 'В семье больше никого нет', en: 'No one else in the family' },
  'transfer.online': { ru: 'в сети · обычно отвечает быстро', en: 'online · usually responds fast' },
  'transfer.online.brief': { ru: 'в сети', en: 'online' },
  'transfer.away': { ru: '🌴 в отъезде до', en: '🌴 away until' },
  'transfer.away.brief': { ru: '🌴 в отъезде', en: '🌴 away' },
  'transfer.message': { ru: 'Сообщение (опц.)', en: 'Message (opt.)' },
  'transfer.message.placeholder': {
    ru: 'Заскочи в магазин — там сразу контейнер',
    en: 'Drop by the store — the container is right there',
  },
  'transfer.message.swap.placeholder': { ru: 'Поменяемся?', en: 'Wanna swap?' },
  'transfer.ttl.title': { ru: 'Запрос живёт 3 часа', en: 'Request lives for 3 hours' },
  'transfer.ttl.hint': {
    ru: 'если не примут — задача останется у тебя',
    en: 'if it’s not accepted, the task stays with you',
  },
  'transfer.swap.partner': { ru: 'С кем меняешься', en: 'Swap partner' },
  'transfer.swap.pick': { ru: 'Берёшь у {name} (выбери 1–2)', en: 'Take from {name} (pick 1-2)' },
  'transfer.swap.empty': {
    ru: 'У {name} нет задач на ближайшие 2 недели',
    en: '{name} has no tasks in the next 2 weeks',
  },
  'transfer.swap.noDate': { ru: 'без даты', en: 'no date' },
  'transfer.swap.balance': { ru: 'Баланс обмена', en: 'Swap balance' },
  'transfer.swap.favorMe': { ru: 'в твою пользу', en: 'in your favor' },
  'transfer.swap.againstMe': { ru: 'не в твою пользу', en: 'against you' },
  'transfer.reward.what': { ru: 'Что предлагаешь взамен', en: 'What do you offer in return' },
  'transfer.reward.money': { ru: 'Деньги', en: 'Money' },
  'transfer.reward.treat': { ru: 'Угощение', en: 'Treat' },
  'transfer.reward.screen': { ru: 'Экранное время', en: 'Screen time' },
  'transfer.reward.favor': { ru: 'Услугу', en: 'A favor' },
  'transfer.reward.other': { ru: 'Другое', en: 'Other' },
  'transfer.reward.name.placeholder': { ru: 'Название награды', en: 'Reward name' },
  'transfer.reward.desc.placeholder': { ru: 'Описание (опц.)', en: 'Description (opt.)' },
  'transfer.reward.timer': {
    ru: '{name} получит запрос — 3 часа на ответ',
    en: '{name} will get the request — 3 hours to respond',
  },
  'transfer.reward.timer.fallback': {
    ru: 'У получателя 3 часа на ответ',
    en: 'The recipient has 3 hours to respond',
  },
  'transfer.submit.plain': { ru: 'Отправить запрос', en: 'Send request' },
  'transfer.submit.swap': { ru: 'Предложить обмен', en: 'Propose swap' },
  'transfer.submit.reward': { ru: 'Предложить', en: 'Propose' },
  'transfer.err': { ru: 'Не получилось отправить', en: 'Failed to send' },

  // ─── profile ───────────────────────────────────────────────────────
  'profile.notifications.title': { ru: 'Уведомления', en: 'Notifications' },
  'profile.notifications.digest': { ru: 'Утренний дайджест', en: 'Morning digest' },
  'profile.notifications.reminder': { ru: 'Напоминания за', en: 'Reminders' },
  'profile.notifications.reminder.value': { ru: 'мин', en: 'min' },
  'profile.notifications.quietHours': { ru: 'Тихие часы', en: 'Quiet hours' },
  'profile.notifications.quietHours.off': { ru: 'Выключены', en: 'Off' },
  'profile.language.title': { ru: 'Язык', en: 'Language' },
  'profile.language.row': { ru: 'Язык интерфейса', en: 'Interface language' },
  'profile.family.title': { ru: 'Семья', en: 'Family' },
  'profile.section.search': { ru: 'Поиск', en: 'Search' },
  'profile.section.inbox': { ru: 'Входящие', en: 'Inbox' },
  'profile.section.stats': { ru: 'Статистика', en: 'Stats' },
  'profile.section.history': { ru: 'История выполнений', en: 'History' },
  'profile.section.catalog': { ru: 'Каталог', en: 'Catalog' },
  'profile.section.templates': { ru: 'Шаблоны задач', en: 'Templates' },
  'profile.section.roles': { ru: 'Роли и права', en: 'Roles & permissions' },
  'profile.timezone': { ru: 'Часовой пояс', en: 'Timezone' },
  'profile.color': { ru: 'Мой цвет', en: 'My color' },
  'profile.away.title': { ru: 'В отъезде', en: 'Away' },
  'profile.away.until': { ru: 'до {date} · очереди пропускают', en: 'until {date} · queues skip me' },
  'profile.away.hint': {
    ru: 'очереди будут пропускать меня',
    en: 'queues will skip me',
  },
  'profile.family.invite': { ru: 'Код приглашения', en: 'Invite code' },
  'profile.family.copy': { ru: 'Скопировать', en: 'Copy' },
  'profile.family.copied': { ru: 'Скопировано', en: 'Copied' },
  'profile.family.share': { ru: 'Поделиться', en: 'Share' },
  'profile.leave': { ru: 'Покинуть семью', en: 'Leave family' },
  'profile.leave.confirm': {
    ru: 'Точно покинуть семью? История останется.',
    en: 'Leave the family? Your history will be preserved.',
  },
  'profile.member.confirmKick': {
    ru: 'Удалить {name} из семьи?',
    en: 'Remove {name} from the family?',
  },

  // ─── language picker ───────────────────────────────────────────────
  'language.picker.title': { ru: 'Язык интерфейса', en: 'Interface language' },
  'language.ru': { ru: 'Русский', en: 'Russian' },
  'language.en': { ru: 'Английский', en: 'English' },

  // ─── notification pickers ──────────────────────────────────────────
  'notif.digest.title': { ru: 'Утренний дайджест', en: 'Morning digest' },
  'notif.digest.hint': {
    ru: 'Время отправки утренней сводки',
    en: 'When to send the morning summary',
  },
  'notif.digest.disabled': { ru: 'Выключен', en: 'Disabled' },
  'notif.reminder.title': { ru: 'Напоминание перед задачей', en: 'Reminder before task' },
  'notif.reminder.hint': {
    ru: 'За сколько минут до дедлайна напомнить',
    en: 'How many minutes before the deadline to remind',
  },
  'notif.quietHours.title': { ru: 'Тихие часы', en: 'Quiet hours' },
  'notif.quietHours.hint': {
    ru: 'В это время уведомления приглушены',
    en: 'Notifications are muted during this window',
  },
  'notif.quietHours.start': { ru: 'Начало', en: 'Start' },
  'notif.quietHours.end': { ru: 'Конец', en: 'End' },
  'notif.quietHours.enable': { ru: 'Включить тихие часы', en: 'Enable quiet hours' },

  // ─── shop (Очки/Стрики/Магазин) ────────────────────────────────────
  'shop.title': { ru: 'Очки и призы', en: 'Points & rewards' },
  'shop.tab.points': { ru: 'Очки', en: 'Points' },
  'shop.tab.streaks': { ru: 'Стрики', en: 'Streaks' },
  'shop.tab.shop': { ru: 'Магазин', en: 'Shop' },
  'shop.period.week': { ru: 'Нед', en: 'Wk' },
  'shop.period.month': { ru: 'Мес', en: 'Mo' },
  'shop.period.year': { ru: 'Год', en: 'Yr' },
  'shop.period.thisWeek': { ru: 'Эта неделя', en: 'This week' },
  'shop.period.thisMonth': { ru: 'Этот месяц', en: 'This month' },
  'shop.period.thisYear': { ru: 'Этот год', en: 'This year' },
  'shop.trophies.title': { ru: 'Трофеи семьи', en: 'Family trophies' },
  'shop.unfair.title': { ru: 'Несправедливость', en: 'Imbalance' },
  'shop.unfair.gap': { ru: 'Разрыв {gap}', en: 'Gap {gap}' },
  'shop.unfair.ratio': {
    ru: '{leader} делает x{ratio} от {laggard}',
    en: '{leader} does x{ratio} of {laggard}',
  },
  'shop.empty.period': { ru: 'В этом периоде ничего не выполнено', en: 'Nothing done in this period' },
  'shop.streak.current': { ru: 'Текущий стрик', en: 'Current streak' },
  'shop.streak.days.suffix': { ru: 'дней', en: 'days' },
  'shop.streak.personal': { ru: 'личный рекорд', en: 'personal best' },
  'shop.streak.family': { ru: 'в семье', en: 'in family' },
  'shop.streak.familyTitle': { ru: 'Стрики семьи', en: 'Family streaks' },
  'shop.streak.record': { ru: 'Рекорд', en: 'Record' },
  'shop.streak.bonus.title': {
    ru: 'За каждые 7 дней — бонус +20',
    en: 'Every 7 days — +20 bonus',
  },
  'shop.streak.bonus.start': {
    ru: 'начни сегодня, чтобы получить бонус',
    en: 'start today to earn the bonus',
  },
  'shop.streak.bonus.left': {
    ru: 'до бонуса осталось {n} {units}',
    en: '{n} {units} until bonus',
  },
  'shop.rewards.empty.title': { ru: 'Призы пока не назначены', en: 'No rewards yet' },
  'shop.rewards.empty.hint': {
    ru: 'Взрослые могут добавить призы из вкладки управления',
    en: 'Grown-ups can add rewards from the management tab',
  },
  'shop.rewards.dream': { ru: 'мечта', en: 'dream' },
  'shop.rewards.remaining': { ru: 'осталось {n}', en: '{n} to go' },
  'shop.rewards.all': { ru: 'Все призы', en: 'All rewards' },
  'shop.rewards.add': { ru: 'Добавить приз', en: 'Add reward' },
  'shop.rewards.take': { ru: 'Забрать', en: 'Claim' },
  'shop.rewards.points.short': { ru: 'очков', en: 'pts' },
  'shop.rewards.notEnough': { ru: 'Не хватает очков', en: 'Not enough points' },

  // ─── queues ────────────────────────────────────────────────────────
  'queues.title': { ru: 'Очереди', en: 'Queues' },
  'queues.sub': { ru: 'автобалансировка', en: 'auto-balanced' },
  'queues.empty.title': { ru: 'Пока ни одной очереди', en: 'No queues yet' },
  'queues.empty.hint': {
    ru: 'Создай задачу «по очереди» — справедливо распределим',
    en: 'Create a "queued" task — we’ll share it fairly',
  },
  'queues.fab': { ru: 'Добавить очередь', en: 'Add queue' },
  'queues.now': { ru: 'Сейчас', en: 'Now' },
  'queues.next': { ru: 'Дальше', en: 'Next' },
  'queues.nobody': { ru: 'Никто', en: 'Nobody' },
  'queues.balance': { ru: 'Баланс выполнений', en: 'Completion balance' },
  'queues.total': { ru: 'всего', en: 'total' },
  'queues.detail.next': { ru: 'Далее', en: 'Up next' },
  'queues.detail.iDid': { ru: 'Я выполнил', en: 'I did it' },
  'queues.detail.transfer': { ru: 'Передать', en: 'Pass on' },
  'queues.detail.everyTime': { ru: 'каждый раз', en: 'every time' },
  'queues.detail.everyN': { ru: 'раз в {n} дн', en: 'every {n} days' },
  'queues.detail.times': { ru: 'раз', en: 'times' },
  'queues.detail.who': { ru: 'Кто сколько раз делал', en: 'Who did how often' },
  'queues.detail.allTime': { ru: 'За всё время', en: 'All time' },
  'queues.detail.even': { ru: '↑ ровно', en: '↑ even' },
  'queues.detail.diff': { ru: '· разница {n}', en: '· diff {n}' },

  // ─── catalog ───────────────────────────────────────────────────────
  'catalog.title': { ru: 'Каталог', en: 'Catalog' },
  'catalog.search.placeholder': { ru: 'Поиск…', en: 'Search…' },
  'catalog.chip.all': { ru: 'Все', en: 'All' },
  'catalog.empty.title': { ru: 'Каталог пуст', en: 'Catalog is empty' },
  'catalog.empty.hint': {
    ru: 'Создавая задачу, ставь галку «Добавить в каталог» — он наполнится сам',
    en: 'Tick "Add to catalog" when creating tasks — it fills itself',
  },
  'catalog.empty.cta': { ru: '+ Добавить вручную', en: '+ Add manually' },
  'catalog.grow.hint': {
    ru: 'Каталог растёт сам — при создании задачи отметь «Добавить в каталог»',
    en: 'The catalog grows itself — tick "Add to catalog" when creating tasks',
  },
  'catalog.new': { ru: 'Новый товар', en: 'New item' },
  'catalog.new.placeholder': { ru: 'Хлеб', en: 'Bread' },
  'catalog.frequency.new': { ru: 'новый', en: 'new' },
  'catalog.frequency.weekly': { ru: 'каждую неделю', en: 'every week' },
  'catalog.frequency.often': { ru: 'часто', en: 'often' },
  'catalog.frequency.sometimes': { ru: 'иногда', en: 'sometimes' },
  'catalog.inCategory': { ru: '{n} в категории «{cat}»', en: '{n} in "{cat}"' },
  'catalog.confirm.delete': { ru: 'Удалить «{name}»?', en: 'Delete "{name}"?' },

  // ─── roles ─────────────────────────────────────────────────────────
  'roles.title': { ru: 'Роли и права', en: 'Roles & permissions' },
  'roles.hint': { ru: 'Владелец семьи может менять права', en: 'The family owner can change permissions' },
  'roles.role.label': { ru: 'Роль', en: 'Role' },
  'roles.allPerms': { ru: 'все права', en: 'all permissions' },
  'roles.perms.fraction': { ru: '{n} / {total} прав', en: '{n} / {total} perms' },
  'roles.readOnly': { ru: 'Права владельца нельзя менять', en: 'Owner permissions are read-only' },
  'roles.realtime': { ru: 'Обновляется в реальном времени', en: 'Updates in real time' },
  'roles.members.none': { ru: 'нет участников', en: 'no members' },
  'roles.member.one': { ru: 'участник', en: 'member' },
  'roles.member.few': { ru: 'участника', en: 'members' },
  'roles.member.many': { ru: 'участников', en: 'members' },
  'roles.tag.readonly': { ru: 'Read-only', en: 'Read-only' },
  'roles.perm.task.create': { ru: 'Создавать задачи', en: 'Create tasks' },
  'roles.perm.task.edit.own': { ru: 'Менять свои задачи', en: 'Edit own tasks' },
  'roles.perm.task.edit.any': { ru: 'Менять чужие задачи', en: 'Edit any task' },
  'roles.perm.task.delete.own': { ru: 'Удалять свои задачи', en: 'Delete own tasks' },
  'roles.perm.task.delete.any': { ru: 'Удалять чужие задачи', en: 'Delete any task' },
  'roles.perm.task.complete.any': {
    ru: 'Отмечать чужие выполненными',
    en: 'Complete tasks of others',
  },
  'roles.perm.catalog.manage': { ru: 'Управлять каталогом', en: 'Manage the catalog' },
  'roles.perm.template.manage': { ru: 'Управлять шаблонами', en: 'Manage templates' },
  'roles.perm.reward.manage': { ru: 'Создавать призы', en: 'Manage rewards' },
  'roles.perm.reward.grant': { ru: 'Выдавать призы', en: 'Grant rewards' },
  'roles.perm.reward.claim': { ru: 'Забирать призы', en: 'Claim rewards' },
  'roles.perm.stats.view.others': { ru: 'Видеть чужую статистику', en: 'See other people’s stats' },
  'roles.perm.member.invite': { ru: 'Приглашать новых', en: 'Invite new members' },
  'roles.perm.member.kick': { ru: 'Удалять участников', en: 'Remove members' },
  'roles.perm.role.manage': { ru: 'Управлять ролями', en: 'Manage roles' },
  'roles.save.error': { ru: 'Не удалось сохранить', en: 'Failed to save' },

  // ─── history ───────────────────────────────────────────────────────
  'history.title': { ru: 'История', en: 'History' },
  'history.filter.withPhoto': { ru: 'С фото', en: 'With photo' },
  'history.empty': { ru: 'Пока ничего не выполнено', en: 'Nothing completed yet' },
  'history.today': { ru: 'Сегодня', en: 'Today' },
  'history.yesterday': { ru: 'Вчера', en: 'Yesterday' },

  // ─── stats ─────────────────────────────────────────────────────────
  'stats.title': { ru: 'Статистика', en: 'Stats' },
  'stats.period.week': { ru: 'Нед', en: 'Wk' },
  'stats.period.month': { ru: 'Мес', en: 'Mo' },
  'stats.period.all': { ru: 'Всё', en: 'All' },
  'stats.byMember': { ru: 'Кто сколько сделал', en: 'Who did how much' },
  'stats.tasks.count': { ru: 'задач', en: 'tasks' },
  'stats.streak.mine': { ru: 'Твой стрик', en: 'Your streak' },
  'stats.streak.record': { ru: 'рекорд', en: 'best' },
  'stats.streak.family': { ru: 'Рекорд семьи', en: 'Family record' },
  'stats.topTasks': { ru: 'Топ задач', en: 'Top tasks' },
  'stats.unfair.title': { ru: 'Несправедливость', en: 'Imbalance' },
  'stats.unfair.desc': {
    ru: '{top} делает в {ratio} раза больше, чем {bottom}',
    en: '{top} does {ratio}x more than {bottom}',
  },
  'stats.empty': { ru: 'В этом периоде ничего не выполнено', en: 'Nothing completed in this period' },

  // ─── search ────────────────────────────────────────────────────────
  'search.title': { ru: 'Поиск', en: 'Search' },
  'search.filter.all': { ru: 'Всё', en: 'All' },
  'search.filter.tasks': { ru: 'Задачи', en: 'Tasks' },
  'search.filter.catalog': { ru: 'Каталог', en: 'Catalog' },
  'search.filter.templates': { ru: 'Шаблоны', en: 'Templates' },
  'search.placeholder': { ru: 'Поиск по семье', en: 'Search the family' },
  'search.start': { ru: 'Начни вводить, чтобы что-то найти', en: 'Type to search' },
  'search.tasks.heading': { ru: 'Задачи', en: 'Tasks' },
  'search.catalog.heading': { ru: 'Каталог', en: 'Catalog' },
  'search.templates.heading': { ru: 'Шаблоны', en: 'Templates' },
  'search.empty': { ru: 'Ничего не найдено по запросу «{q}»', en: 'No results for "{q}"' },
  'search.catalog.bought': { ru: '× куплено', en: '× bought' },
  'search.template.sub': { ru: 'шаблон', en: 'template' },
  'search.template.system': { ru: 'Системный', en: 'System' },
  'search.type.oneoff': { ru: 'разовая', en: 'one-off' },
  'search.type.recurring': { ru: 'повтор', en: 'recurring' },
  'search.type.floating': { ru: 'без даты', en: 'no date' },
  'search.type.queued': { ru: 'по очереди', en: 'queued' },

  // ─── inbox ─────────────────────────────────────────────────────────
  'inbox.title': { ru: 'Входящие', en: 'Inbox' },
  'inbox.transfers': { ru: 'Передачи мне', en: 'Transfers to me' },
  'inbox.rewards': { ru: 'Запросы призов', en: 'Reward requests' },
  'inbox.reward.wants': { ru: 'хочет приз', en: 'wants a reward' },
  'inbox.reward.reject': { ru: 'Отказать', en: 'Reject' },
  'inbox.reward.grant': { ru: 'Выдать', en: 'Grant' },
  'inbox.empty.title': { ru: 'Пусто', en: 'Nothing here' },
  'inbox.empty.hint': {
    ru: 'Здесь будут запросы на передачу задач и призы',
    en: 'Task transfers and reward requests will land here',
  },
  'inbox.transfer.task': { ru: 'Задача', en: 'Task' },
  'inbox.transfer.from': { ru: 'от', en: 'from' },
  'inbox.transfer.timer': { ru: 'мин', en: 'min' },
  'inbox.transfer.decline': { ru: 'Отказаться', en: 'Decline' },
  'inbox.transfer.accept': { ru: 'Принять задачу', en: 'Accept' },

  // ─── catalog (extras) ──────────────────────────────────────────────
  'catalog.category.other': { ru: 'Прочее', en: 'Other' },
  'catalog.search.label': { ru: 'Поиск товара', en: 'Find item' },
  'catalog.confirm.delete.item': { ru: 'Удалить «{name}»?', en: 'Delete "{name}"?' },

  // ─── templates ─────────────────────────────────────────────────────
  'templates.title': { ru: 'Шаблоны задач', en: 'Task templates' },
  'templates.section.own': { ru: 'Свои шаблоны', en: 'Your templates' },
  'templates.section.system': { ru: 'Системные', en: 'System' },
  'templates.empty.title': { ru: 'Пока ни одного шаблона', en: 'No templates yet' },
  'templates.empty.hint': {
    ru: 'При создании задачи можно сохранить её как шаблон',
    en: 'Save a task as a template when you create one',
  },
  'templates.system.tag': { ru: 'Системный', en: 'System' },
  'templates.use': { ru: 'Использовать', en: 'Use' },
  'templates.confirm.delete': { ru: 'Удалить «{name}»?', en: 'Delete "{name}"?' },
  'templates.type.oneoff': { ru: 'разовая', en: 'one-off' },
  'templates.type.recurring': { ru: 'повтор', en: 'recurring' },
  'templates.type.floating': { ru: 'без даты', en: 'no date' },
  'templates.type.queued': { ru: 'по очереди', en: 'queued' },

  // ─── onboarding ────────────────────────────────────────────────────
  'onb.title': { ru: 'My Family Todo', en: 'My Family Todo' },
  'onb.intro.sub': {
    ru: 'общий список задач для семьи · в Telegram',
    en: 'shared family to-do list · in Telegram',
  },
  'onb.bullet.daily': {
    ru: 'Что и кому делать на сегодня',
    en: 'What everyone is doing today',
  },
  'onb.bullet.queues': {
    ru: 'Очереди — справедливо по очереди',
    en: 'Queues — share the load fairly',
  },
  'onb.bullet.rewards': {
    ru: 'Очки и призы — кто помладше',
    en: 'Points & rewards — fun for kids',
  },
  'onb.create': { ru: 'Создать семью', en: 'Create family' },
  'onb.join': { ru: 'Войти по коду', en: 'Join with a code' },
  'onb.create.title': { ru: 'Новая семья', en: 'New family' },
  'onb.create.avatar': { ru: 'Аватар семьи (опц.)', en: 'Family avatar (opt.)' },
  'onb.create.pick': { ru: 'Выбрать', en: 'Choose' },
  'onb.create.name': { ru: 'Название', en: 'Name' },
  'onb.create.name.placeholder': { ru: 'Семья Ивановых', en: 'The Smiths' },
  'onb.create.color': { ru: 'Выбери свой цвет', en: 'Pick your colour' },
  'onb.create.myname': { ru: 'Твоё имя в семье', en: 'Your name in the family' },
  'onb.create.fromTg': { ru: 'из TG', en: 'from TG' },
  'onb.create.submit': { ru: 'Создать', en: 'Create' },
  'onb.create.submitting': { ru: 'Создаём…', en: 'Creating…' },
  'onb.share.sub': {
    ru: 'семья создана · пригласи близких',
    en: 'family is ready · invite your folks',
  },
  'onb.share.code': { ru: 'Инвайт-код', en: 'Invite code' },
  'onb.share.linkHint': {
    ru: 'Или ссылка из Telegram-бота',
    en: 'Or a link from the Telegram bot',
  },
  'onb.share.copied': { ru: 'Скопировано', en: 'Copied' },
  'onb.share.copyFail': { ru: 'Не получилось', en: 'Failed' },
  'onb.share.copy': { ru: 'Скопировать', en: 'Copy' },
  'onb.share.share': { ru: 'Поделиться', en: 'Share' },
  'onb.share.done': { ru: 'Готово', en: 'Done' },
  'onb.toast.copied': { ru: 'Скопировано в буфер обмена', en: 'Copied to clipboard' },
  'onb.toast.copyFail': { ru: 'Не удалось скопировать', en: 'Copy failed' },
  'onb.share.text': {
    ru: 'Заходи в нашу семью «{name}» в My Family Todo',
    en: 'Join our family "{name}" in My Family Todo',
  },
  'onb.join.title': { ru: 'Войти в семью', en: 'Join a family' },
  'onb.join.hint': { ru: 'Инвайт-код или ссылка из бота', en: 'Invite code or bot link' },
  'onb.join.linkHint': {
    ru: 'или вставь ссылку: t.me/MyFamilyTodoBot?start=...',
    en: 'or paste a link: t.me/MyFamilyTodoBot?start=...',
  },
  'onb.join.notFound': { ru: 'Семья с таким кодом не найдена', en: 'No family found for that code' },
  'onb.join.submit': { ru: 'Войти', en: 'Join' },
  'onb.join.submitting': { ru: 'Входим…', en: 'Joining…' },
  'onb.preview.willJoin': { ru: 'Войдёшь в', en: 'You will join' },
  'onb.preview.since': { ru: 'с', en: 'since' },
  'onb.preview.owner': { ru: 'владелец', en: 'owner' },
  'onb.err.alreadyMember': { ru: 'Вы уже состоите в этой семье', en: 'You’re already in this family' },
  'onb.err.invalidTg': {
    ru: 'Сессия Telegram недействительна, перезапустите приложение',
    en: 'Telegram session is invalid — restart the app',
  },
};

export function tr(locale: Locale, key: string, fallback?: string): string {
  const entry = DICT[key];
  if (entry && entry[locale]) return entry[locale];
  if (entry?.ru) return entry.ru;
  return fallback ?? key;
}

/**
 * Template helper: substitutes `{name}`-style placeholders with values.
 * Use in EN strings like 'Take from {name}' — `interpolate(s, { name: 'Lyosha' })`.
 */
export function interpolate(s: string, vars: Record<string, string | number>): string {
  return s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));
}

// ─── React glue ────────────────────────────────────────────────────────────

const LocaleContext = createContext<Locale>('ru');

export function LocaleProvider({
  locale,
  children,
}: {
  locale: string | undefined | null;
  children: ReactNode;
}) {
  return createElement(LocaleContext.Provider, { value: normalizeLocale(locale) }, children);
}

export type TFn = ((key: string, vars?: Record<string, string | number>) => string) & {
  locale: Locale;
};

export function useT(): TFn {
  const locale = useContext(LocaleContext);
  const t = ((key: string, vars?: Record<string, string | number>) => {
    const raw = tr(locale, key);
    return vars ? interpolate(raw, vars) : raw;
  }) as TFn;
  t.locale = locale;
  return t;
}

/** Plural helpers — Russian has 3 forms, English has 2. */
export function pluralRu(n: number, [one, few, many]: [string, string, string]): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

export function pluralize(
  locale: Locale,
  n: number,
  ru: [string, string, string],
  en: [string, string],
): string {
  if (locale === 'en') return n === 1 ? en[0] : en[1];
  return pluralRu(n, ru);
}

/** Plain (no React) accessor for places where a `t` is needed but we only
 *  have a locale string (e.g. helper functions outside a component). */
export function makeT(locale: string | undefined | null): TFn {
  const l = normalizeLocale(locale);
  const t = ((key: string, vars?: Record<string, string | number>) => {
    const raw = tr(l, key);
    return vars ? interpolate(raw, vars) : raw;
  }) as TFn;
  t.locale = l;
  return t;
}
