require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const {
    saveToGoogleSheet,
    getSheetRowsAsObjects,
    groupByChurch,
    sortRowsByVisitDateTime
} = require('./sheets');

const app = express();
app.use(express.json());

// 환경 변수 설정
const PORT = process.env.PORT || 8080;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
// 비밀값에는 기본값을 두지 않는다. 누락 시 아래 검사에서 기동을 중단시킨다.
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const TELEGRAM_SECRET_TOKEN = process.env.TELEGRAM_SECRET_TOKEN;
const SUMMARY_SECRET = process.env.SUMMARY_SECRET;
const SUMMARY_CHAT_ID = process.env.SUMMARY_CHAT_ID;
const USE_MESSAGE_THREAD_ID = process.env.USE_MESSAGE_THREAD_ID === 'true';
const DEFAULT_MESSAGE_THREAD_ID = process.env.DEFAULT_MESSAGE_THREAD_ID;
const IGNORE_THREAD_IDS = process.env.IGNORE_THREAD_IDS ? process.env.IGNORE_THREAD_IDS.split(',').map(id => id.trim()) : [];

/** 쉼표 구분 ID 목록을 문자열 배열로 파싱 */
function parseIdList(raw) {
    if (!raw) return [];
    return String(raw).split(',').map(id => id.trim()).filter(Boolean);
}

// 미허용 그룹에서 자동 퇴장할지 여부. 허용 목록을 구성하는 동안에는 false 로 두어 오퇴장을 막는다.
const LEAVE_UNKNOWN_CHATS = process.env.LEAVE_UNKNOWN_CHATS !== 'false';

// 봇이 응답할 채팅방 목록. 미지정 시 SUMMARY_CHAT_ID 하나만 허용한다(절대 전체 개방하지 않음).
const ALLOWED_CHAT_IDS = parseIdList(process.env.ALLOWED_CHAT_IDS).length > 0
    ? parseIdList(process.env.ALLOWED_CHAT_IDS)
    : parseIdList(SUMMARY_CHAT_ID);


// 비밀값 누락 상태로 절대 기동하지 않는다(빈 값 = 인증 무력화이므로 즉시 종료).
const REQUIRED_SECRETS = {
    TELEGRAM_BOT_TOKEN,
    WEBHOOK_SECRET,
    TELEGRAM_SECRET_TOKEN,
    SUMMARY_SECRET
};
const missingSecrets = Object.entries(REQUIRED_SECRETS)
    .filter(([, value]) => !value || String(value).trim() === '')
    .map(([key]) => key);
if (missingSecrets.length > 0) {
    // 값 자체는 절대 출력하지 않고 이름만 알린다.
    console.error(`[FATAL] 필수 환경변수 누락: ${missingSecrets.join(', ')} — .env.example 참고`);
    process.exit(1);
}

// 허용 채팅방이 하나도 없으면 봇은 어디서도 동작하지 않는다. 열어두는 것보다 멈추는 쪽이 안전하다.
if (ALLOWED_CHAT_IDS.length === 0) {
    console.error('[FATAL] ALLOWED_CHAT_IDS(또는 SUMMARY_CHAT_ID)가 비어 있습니다 — .env.example 참고');
    process.exit(1);
}

// 레이트 리밋 (S10): 사용자별 최근 요청 시각을 메모리에 기록해 과도한 연타를 막는다.
// 주의 — 이 카운터는 인스턴스 로컬이다. Cloud Run 이 인스턴스를 여러 개로 늘리면
// 인스턴스마다 카운터가 따로 논다. 이 봇은 트래픽이 적어 대개 인스턴스 1개로 유지되므로
// 소규모 연타 방지에는 충분하다. 정밀한 분산 제한이 필요해지면 외부 스토어로 옮긴다.
const RATE_LIMIT_WINDOW_MS = 10 * 1000; // 10초 창
const RATE_LIMIT_MAX = 5;               // 창당 최대 5건
const rateLimitStore = new Map();       // userId -> number[] (요청 시각들)

/**
 * userId 가 창 안에서 허용치를 넘었는지 검사한다.
 * 넘지 않았으면 이번 요청을 기록하고 true, 넘었으면 false 를 돌려준다.
 */
function checkRateLimit(userId) {
    if (userId === undefined || userId === null) return true; // 식별 불가한 요청은 통과
    const key = String(userId);
    const now = Date.now();
    const recent = (rateLimitStore.get(key) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    if (recent.length >= RATE_LIMIT_MAX) {
        rateLimitStore.set(key, recent); // 만료분 정리분 반영
        return false;
    }
    recent.push(now);
    rateLimitStore.set(key, recent);
    return true;
}

// 메모리 누수 방지: 주기적으로 오래된 항목을 청소한다.
setInterval(() => {
    const now = Date.now();
    for (const [key, times] of rateLimitStore) {
        const recent = times.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
        if (recent.length === 0) rateLimitStore.delete(key);
        else rateLimitStore.set(key, recent);
    }
}, RATE_LIMIT_WINDOW_MS).unref();

/**
 * 타이밍 공격 방지용 비밀값 비교. 길이가 달라도 안전하게 false를 돌려준다.
 */
function secretEquals(actual, expected) {
    if (typeof actual !== 'string' || typeof expected !== 'string') return false;
    const a = Buffer.from(actual);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

// -------------------------------------------------------------
// 핵심 함수 정의 (Telegram 관련 로직)
// -------------------------------------------------------------

/**
 * 1. extractField: 텍스트에서 특정 라벨의 값을 추출
 */
function extractField(text, label) {
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 라벨 뒤에 콜론(:)이 나오기 전까지의 부가 설명문구(예: 괄호 내용)를 무시합니다.
    const regex = new RegExp(`${escapedLabel}[^:：\\n]*[:：]\\s*(.*)`, 'i');
    const lines = text.split(/\r?\n|\r|\n|\u2028|\u2029/);
    
    for (const line of lines) {
        const match = line.match(regex);
        if (match) {
            return match[1].trim();
        }
    }
    return null;
}

/**
 * 2. validateVisitRequest: 방문 요청서 메시지 검증
 */
function validateVisitRequest(text) {
    const errors = [];

    const idNumber = extractField(text, '고유번호');
    const phone = extractField(text, '연락처');
    const leaderPhone = extractField(text, '구역장연락처') || extractField(text, '구역장 연락처');
    const address = extractField(text, '현 거주지 주소');
    const reason = extractField(text, '방문 사유');
    const visitDateTime = extractField(text, '방문일시') || extractField(text, '방문일') || extractField(text, '방문희망일');

    if (!idNumber) {
        errors.push('1. 고유번호가 누락되었습니다.');
    } else if (!/^\d{8}-\d{5}$/.test(idNumber)) {
        errors.push('1. 고유번호 형식이 올바르지 않습니다.');
    }

    if (!phone) {
        errors.push('2. 방문자 연락처가 누락되었습니다.');
    } else if (!/^010-\d{4}-\d{4}$/.test(phone)) {
        errors.push('2. 방문자 연락처 형식이 올바르지 않습니다.');
    }

    if (!leaderPhone) {
        errors.push('3. 담당구역장 연락처가 누락되었습니다.');
    } else if (!/^010-\d{4}-\d{4}$/.test(leaderPhone)) {
        errors.push('3. 담당구역장 연락처 형식이 올바르지 않습니다.');
    }

    if (!address) {
        errors.push('4. 현 거주지 주소가 누락되었습니다.');
    } else if (!/^[가-힣\s]+(시|군)$/.test(address)) {
        errors.push('4. 현 거주지 주소 형식이 올바르지 않습니다.');
    }

    if (!reason || reason.trim() === '') {
        errors.push('5. 방문 사유가 비어 있습니다.');
    }

    if (!visitDateTime) {
        errors.push('6. 방문일시(또는 방문일)가 누락되었습니다.');
    } else {
        const dateRegex = /~?\s*\d{4}\.\d{2}\.\d{2}\s\([가-힣\/]+\)/;
        if (!dateRegex.test(visitDateTime)) {
            errors.push('6. 방문일시 형식이 올바르지 않습니다. (예: 2026.04.22 (수) 12:00)');
        }
    }

    const isFixedRaw = extractField(text, '고정여부');
    if (!isFixedRaw) {
        errors.push('7. 고정여부가 누락되었습니다.');
    } else if (!isFixedRaw.includes('고정') && !isFixedRaw.includes('일회성')) {
        errors.push('7. 고정여부는 "고정" 또는 "일회성" 단어를 포함해야 합니다.');
    }

    return {
        isValid: errors.length === 0,
        errors
    };
}

/**
 * 3. normalizeVisitDateTime
 */
function normalizeVisitDateTime(raw) {
    if (!raw) return '';
    return raw.trim();
}

/**
 * 4. parseVisitRequest: 메시지 파싱 (sheets.js 필드명에 맞춤)
 */
function parseVisitRequest(text) {
    const churchInfo = extractField(text, '방문지파/방문교회');
    let branch = '', church = '';
    if (churchInfo && churchInfo.includes('/')) {
        [branch, church] = churchInfo.split('/').map(s => s.trim());
    }

    const visitDateRaw = extractField(text, '방문일시') || extractField(text, '방문일');
    const isFixedRaw = extractField(text, '고정여부');

    // 반복 방문 감지: "방문희망일" 필드 또는 "~" 패턴이 있으면 종료일 파싱
    const endDateLine = extractField(text, '방문희망일');
    let visit_end_date = '';
    let visit_datetime_display = normalizeVisitDateTime(visitDateRaw);

    // 시작일에서 날짜와 요일 추출 (미리 파싱)
    const startDateMatch = visitDateRaw && visitDateRaw.match(/(\d{4}\.\d{2}\.\d{2})/);
    const dayMatch = visitDateRaw && visitDateRaw.match(/\(([가-힣\/]+)\)/);
    const startDate = startDateMatch ? startDateMatch[1] : '';
    const dayOfWeek = dayMatch ? dayMatch[1] : '';

    if (isFixedRaw && isFixedRaw.includes('일회성')) {
        // 일회성인 경우 종료일을 시작일(방문일)과 동일하게 설정하여 한 번만 노출되도록 함
        if (startDate) {
            visit_end_date = startDate;
        }
    } else if (endDateLine) {
        // 기존 방문희망일 로직 (기간 지정)
        const endMatch = endDateLine.match(/(\d{4}\.\d{2}\.\d{2})/);
        if (endMatch) {
            visit_end_date = endMatch[1]; // 예: "2026.12.30"
            visit_datetime_display = startDate
                ? `${startDate} ~ ${visit_end_date}${dayOfWeek ? ' (매주 ' + dayOfWeek + ')' : ''}`
                : visit_end_date;
        }
    } else if (isFixedRaw && isFixedRaw.includes('고정')) {
        // 고정(요일)인 경우 무기한 반복 (종료일 없음)
        visit_datetime_display = startDate 
            ? `${startDate} ~ (매주 고정)`
            : visit_datetime_display;
    }

    return {
        created_at: new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
        visit_jipa: branch,
        visit_church: church,
        group_key: churchInfo || '미분류',
        department: extractField(text, '소속지파'),
        name: extractField(text, '이름'),
        unique_number: extractField(text, '고유번호'),
        phone: extractField(text, '연락처'),
        address: extractField(text, '현 거주지 주소'),
        reason: extractField(text, '방문 사유'),
        visit_datetime_raw: visitDateRaw,
        visit_datetime_display,
        manager_name: extractField(text, '담당구역장') || extractField(text, '담당 구역장') || extractField(text, '구역장이름') || extractField(text, '구역장 이름'),
        manager_phone: extractField(text, '구역장연락처') || extractField(text, '구역장 연락처'),
        visit_end_date
    };
}

/**
 * 8. buildGroupedListMessage: 그룹화된 결과 메시지 빌드
 */
/**
 * 반복 방문 종료일이 오늘 이후인지 확인 (종료일 없으면 항상 활성)
 */
function isActiveRow(row) {
    if (!row.visit_end_date) return true;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const parts = row.visit_end_date.split('.');
    if (parts.length !== 3) return true;
    const endDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
    return endDate >= today;
}

function buildGroupedListMessage(groupedRows, options = {}) {
    let message = '';
    if (options.isSuccess) {
        message += '✅ 등록 완료\n\n';
    }
    message += '📋 교회별 방문 요청 현황\n';

    const keys = Object.keys(groupedRows).sort();
    if (keys.length === 0) return null;

    let hasAny = false;
    keys.forEach(key => {
        // 종료일 지난 항목 제외
        const members = sortRowsByVisitDateTime(groupedRows[key].filter(isActiveRow));
        if (members.length === 0) return;
        hasAny = true;
        message += `\n[${key}] ${members.length}건\n`;
        members.forEach((m, idx) => {
            message += `${idx + 1}. ${m.name} / ${m.visit_datetime_display}\n`;
        });
    });

    return hasAny ? message : null;
}

/**
 * 9. splitMessage
 */
function splitMessage(text, maxLength = 4000) {
    if (text.length <= maxLength) return [text];
    const lines = text.split('\n');
    const chunks = [];
    let current = '';
    for (const line of lines) {
        if ((current + line).length > maxLength) {
            chunks.push(current);
            current = line + '\n';
        } else {
            current += line + '\n';
        }
    }
    if (current) chunks.push(current);
    return chunks;
}

/**
 * 10. sendTelegramMessage
 */
async function sendTelegramMessage(chatId, text, options = {}) {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const payload = {
        chat_id: chatId,
        text: text
    };
    if (options.reply_to_message_id) payload.reply_to_message_id = options.reply_to_message_id;
    if (options.message_thread_id) payload.message_thread_id = options.message_thread_id;

    try {
        await axios.post(url, payload);
    } catch (error) {
        // 응답 본문·요청 URL에는 봇 토큰과 메시지 원문이 섞여 있으므로 상태 코드만 남긴다.
        const status = error.response ? error.response.status : 'no-response';
        console.error(`[Telegram Error] sendMessage 실패 (status=${status})`);
    }
}

/**
 * 10-1. leaveChat: 허용되지 않은 그룹에서 즉시 나간다 (S11)
 */
async function leaveChat(chatId) {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/leaveChat`;
    try {
        await axios.post(url, { chat_id: chatId });
        console.log('[Guard] 미허용 그룹에서 퇴장');
    } catch (error) {
        const status = error.response ? error.response.status : 'no-response';
        console.error(`[Guard] leaveChat 실패 (status=${status})`);
    }
}

/** 봇이 응답해도 되는 채팅방인지 */
function isAllowedChat(chatId) {
    return ALLOWED_CHAT_IDS.includes(String(chatId));
}

/**
 * 11. sendLongMessage
 */
async function sendLongMessage(chatId, text, options = {}) {
    const chunks = splitMessage(text);
    for (let i = 0; i < chunks.length; i++) {
        let content = chunks[i];
        if (chunks.length > 1) {
            content = `(${i + 1}/${chunks.length})\n` + content;
        }
        await sendTelegramMessage(chatId, content, options);
    }
}

// -------------------------------------------------------------
// 웹훅 및 API 핸들러
// -------------------------------------------------------------

app.post('/webhook/:secret', async (req, res) => {
    // 1차: URL 경로의 무작위 시크릿, 2차: 텔레그램이 붙여 보내는 secret_token 헤더.
    // 두 검사 모두 타이밍 안전 비교로 수행한다.
    if (!secretEquals(req.params.secret, WEBHOOK_SECRET)) return res.status(403).send('Forbidden');
    if (!secretEquals(req.get('X-Telegram-Bot-Api-Secret-Token') || '', TELEGRAM_SECRET_TOKEN)) {
        return res.status(403).send('Forbidden');
    }

    const update = req.body;
    if (!update || !update.message || !update.message.text) return res.status(200).send('OK');

    const message = update.message;
    const chatId = message.chat.id;
    const chatType = message.chat.type;
    const userId = message.from ? message.from.id : undefined;
    const text = message.text;
    const messageId = message.message_id;
    const threadId = message.message_thread_id || (USE_MESSAGE_THREAD_ID ? DEFAULT_MESSAGE_THREAD_ID : undefined);

    // 허용 채팅방 게이트 (S11): 미허용 그룹이면 즉시 나가고, 그 외에는 어떤 반응도 하지 않는다.
    // chat_id 는 개인정보가 아니라 설정에 필요한 식별자이므로, 허용 목록 구성을 위해 로그에 남긴다.
    if (!isAllowedChat(chatId)) {
        console.warn(`[Guard] 미허용 채팅방 요청 차단: chat_id=${chatId} type=${chatType}`);
        // LEAVE_UNKNOWN_CHATS=false 로 두면 나가지 않고 무반응만 한다(허용 목록 설정 중 오퇴장 방지).
        if (LEAVE_UNKNOWN_CHATS && (chatType === 'group' || chatType === 'supergroup')) {
            await leaveChat(chatId);
        }
        return res.status(200).send('OK');
    }

    // 레이트 리밋 (S10): 허용된 방 안에서도 동일 사용자의 연타는 차단한다.
    // 초과 시 조용히 무시한다(경고 메시지 자체가 또 다른 스팸이 되지 않도록).
    if (!checkRateLimit(userId)) {
        console.warn(`[RateLimit] 요청 초과로 무시: user=${userId}`);
        return res.status(200).send('OK');
    }

    // 본인 ID 확인용. 요청자 본인 ID만 알려준다.
    if (text.trim() === '/myid') {
        await sendTelegramMessage(chatId, `당신의 ID는 ${userId} 입니다.`, { reply_to_message_id: messageId, message_thread_id: threadId });
        return res.status(200).send('OK');
    }

    // 특정 토픽(스레드) 무시 로직
    if (message.message_thread_id && IGNORE_THREAD_IDS.includes(String(message.message_thread_id))) {
        return res.status(200).send('OK'); // 무시
    }

    // 토픽 ID 확인용 명령어.
    // 자기가 속한 토픽의 ID를 돌려줄 뿐이고 허용된 방에서만 동작하므로 멤버 누구나 쓸 수 있다.
    if (text.trim() === '/topicid') {
        const msg = message.message_thread_id
            ? `이 토픽의 ID는 ${message.message_thread_id} 입니다.\n\n.env 파일의 IGNORE_THREAD_IDS=${message.message_thread_id} 로 설정하면 이 토픽에서 봇이 무시합니다.`
            : `이 채팅방은 토픽이 아닙니다.`;
        await sendTelegramMessage(chatId, msg, { reply_to_message_id: messageId, message_thread_id: threadId });
        return res.status(200).send('OK');
    }

    if (text.includes('방문 요청서')) {
        const validation = validateVisitRequest(text);
        if (!validation.isValid) {
            const errorText = `❌ 양식 검증 실패\n\n${validation.errors.join('\n')}`;
            await sendTelegramMessage(chatId, errorText, { reply_to_message_id: messageId, message_thread_id: threadId });
            return res.status(200).send('OK');
        }

        try {
            const data = parseVisitRequest(text);
            data.telegram_chat_id = String(chatId);
            data.telegram_message_id = String(messageId);
            
            await saveToGoogleSheet(data);

            // 등록 회신은 전원에게 전체 현황을 보낸다.
            // 같은 방 멤버는 이미 서로의 양식 원문을 보고 있고, 이 목록은 이름·방문일시만 담는다.
            const rows = await getSheetRowsAsObjects();
            const grouped = groupByChurch(rows);
            const responseMsg = buildGroupedListMessage(grouped, { isSuccess: true });
            await sendLongMessage(chatId, responseMsg, { reply_to_message_id: messageId, message_thread_id: threadId });
        } catch (error) {
            // 예외 객체에는 요청 본문(입력 원문)·경로가 실릴 수 있어 종류만 남긴다.
            console.error(`[Save Error] 저장 실패 (${error.code || error.name || 'Error'})`);
            await sendTelegramMessage(chatId, '⚠️ 데이터를 저장하는 중 오류가 발생했습니다.', { reply_to_message_id: messageId, message_thread_id: threadId });
        }
    }

    res.status(200).send('OK');
});

// 자동 스케줄 요약 전송 (스케줄러 전용 — 비밀값은 URL이 아닌 헤더로 받는다)
app.get('/summary', async (req, res) => {
    if (!secretEquals(req.get('X-Summary-Secret') || '', SUMMARY_SECRET)) {
        return res.status(403).send('Forbidden');
    }

    try {
        const rows = await getSheetRowsAsObjects();
        if (rows.length === 0) return res.status(200).send('No data');

        const grouped = groupByChurch(rows);
        const responseMsg = buildGroupedListMessage(grouped);
        
        const threadId = USE_MESSAGE_THREAD_ID ? DEFAULT_MESSAGE_THREAD_ID : undefined;
        await sendLongMessage(SUMMARY_CHAT_ID, responseMsg, { message_thread_id: threadId });
        
        res.status(200).send('Summary sent');
    } catch (error) {
        console.error(`[Summary Error] 요약 전송 실패 (${error.code || error.name || 'Error'})`);
        res.status(500).send('Error');
    }
});

// 상태 확인 전용 — 어떤 데이터도 노출하지 않는다.
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// 참고: /test-save, /test-list는 인증 없이 시트 쓰기·개인정보 전량 조회가 가능해 제거했다.

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
