/**
 * Монитор доступности «НОРМА. Планер» (GitHub Actions, по расписанию; отдельный публичный репозиторий — бесплатные минуты).
 *
 * GET CHECK_URL (/api/health, ждём { ok: true }). Два падения подряд — сообщение
 * в Telegram, о падении не чаще раза в час; после восстановления — одно
 * сообщение «снова работает» (только если о падении сообщали). Состояние между
 * запусками — в STATE_FILE (кэш Actions). Задание всегда завершается успешно:
 * извещение — через Telegram, а не письмами о красных запусках.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const url = process.env.CHECK_URL;
const stateFile = process.env.STATE_FILE ?? '.uptime-state/state.json';
const token = process.env.TELEGRAM_BOT_TOKEN;
const chat = process.env.TELEGRAM_CHAT_ID;
const now = Date.now();
const HOUR = 60 * 60 * 1000;
const THRESHOLD = 2;

let state = { failStreak: 0, downSince: null, alerted: false, lastAlertAt: null };

try {
    state = { ...state, ...JSON.parse(readFileSync(stateFile, 'utf8')) };
} catch {
    // Первый запуск или кэш истёк — начинаем с чистого состояния.
}

async function check() {
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { 'user-agent': 'norma-uptime' } });

        if (!response.ok) {
            return { ok: false, reason: `HTTP ${response.status}` };
        }

        const body = await response.json().catch(() => null);

        return body?.ok === true ? { ok: true, version: String(body.version ?? '?').slice(0, 7) } : { ok: false, reason: 'ответ без ok: true' };
    } catch (error) {
        return { ok: false, reason: error?.name === 'TimeoutError' ? 'нет ответа за 20 с' : `сеть: ${error?.cause?.code ?? error?.message ?? error}` };
    }
}

async function telegram(text) {
    if (!token || !chat) {
        console.log('Telegram: секреты не заданы — сообщение не отправлено');

        return false;
    }

    try {
        const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
            signal: AbortSignal.timeout(20_000),
        });
        const body = await response.json().catch(() => ({}));

        console.log(`Telegram: ${body.ok ? `доставлено (message_id ${body.result?.message_id})` : `ошибка ${body.error_code ?? response.status}`}`);

        return body.ok === true;
    } catch (error) {
        console.log(`Telegram: не отправлено — ${error?.name ?? error}`);

        return false;
    }
}

const result = await check();

console.log(`проверка ${url}: ${result.ok ? `ок, версия ${result.version}` : `неудача — ${result.reason}`}`);

if (result.ok) {
    if (state.alerted) {
        const minutes = state.downSince ? Math.max(1, Math.round((now - state.downSince) / 60_000)) : null;

        await telegram(`НОРМА. Планер снова работает${minutes ? ` (был недоступен около ${minutes} мин)` : ''}.`);
    }

    state = { failStreak: 0, downSince: null, alerted: false, lastAlertAt: state.lastAlertAt };
} else {
    state.failStreak += 1;
    state.downSince ??= now;

    if (state.failStreak >= THRESHOLD) {
        if (!state.lastAlertAt || now - state.lastAlertAt >= HOUR) {
            const sent = await telegram(`НОРМА. Планер не отвечает: ${result.reason}. Проверок подряд: ${state.failStreak}.\n${url}`);

            if (sent) {
                state.alerted = true;
                state.lastAlertAt = now;
            }
        } else {
            console.log('о падении уже сообщено в последний час — без повтора');
        }
    }
}

mkdirSync(dirname(stateFile), { recursive: true });
writeFileSync(stateFile, JSON.stringify(state));
console.log(`состояние: ${JSON.stringify(state)}`);
