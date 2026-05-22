import { signInitDataForTest } from '@family-todo/tg-auth';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is not set');
  process.exit(1);
}

const initData = signInitDataForTest({
  botToken: token,
  user: {
    id: 777777,
    firstName: 'Dev',
    username: 'devuser',
    languageCode: 'ru',
  },
});

console.log(initData);
