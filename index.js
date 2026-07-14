require('dotenv').config();
const express = require('express');
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
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'default-secret';
const SUMMARY_CHAT_ID = process.env.SUMMARY_CHAT_ID;
const USE_MESSAGE_THREAD_ID = process.env.USE_MESSAGE_THREAD_ID === 'true';
const DEFAULT_MESSAGE_THREAD_ID = process.env.DEFAULT_MESSAGE_THREAD_ID;
const IGNORE_THREAD_IDS = process.env.IGNORE_THREAD_IDS ? process.env.IGNORE_THREAD_IDS.split(',').map(id => id.trim()) : [];

// -------------------------------------------------------------
// 핵심 함수 정의 (Telegram 관련 로직)
// -------------------------------------------------------------

/**
 * 1. extractField: 텍스트에서 특정 라벨의 값을 추출
 */
function extractField(text, label) {
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`${escapedLabel}\\s*[:：]\\s*(.*)`, 'i');
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
    const leaderPhone = extractField(text, '구역장연락처');
    const address = extractField(text, '현 거주지 주소(시/군까지만 기록)');
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
        department: extractField(text, '소속지파/교회/부서'),
        name: extractField(text, '이름'),
        unique_number: extractField(text, '고유번호'),
        phone: extractField(text, '연락처'),
        address: extractField(text, '현 거주지 주소(시/군까지만 기록)'),
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
        console.error('[Telegram Error]', error.response ? error.response.data : error.message);
    }
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
    if (req.params.secret !== WEBHOOK_SECRET) return res.status(403).send('Forbidden');

    const update = req.body;
    if (!update || !update.message || !update.message.text) return res.status(200).send('OK');

    const message = update.message;
    const chatId = message.chat.id;
    const text = message.text;
    const messageId = message.message_id;
    const threadId = message.message_thread_id || (USE_MESSAGE_THREAD_ID ? DEFAULT_MESSAGE_THREAD_ID : undefined);

    // 특정 토픽(스레드) 무시 로직
    if (message.message_thread_id && IGNORE_THREAD_IDS.includes(String(message.message_thread_id))) {
        return res.status(200).send('OK'); // 무시
    }

    // 토픽 ID 확인용 명령어
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
            
            const rows = await getSheetRowsAsObjects();
            const grouped = groupByChurch(rows);
            const responseMsg = buildGroupedListMessage(grouped, { isSuccess: true });
            
            await sendLongMessage(chatId, responseMsg, { reply_to_message_id: messageId, message_thread_id: threadId });
        } catch (error) {
            console.error(error);
            await sendTelegramMessage(chatId, '⚠️ 데이터를 저장하는 중 오류가 발생했습니다.', { reply_to_message_id: messageId, message_thread_id: threadId });
        }
    } else if (text.trim() === '/목록') {
        const rows = await getSheetRowsAsObjects();
        const grouped = groupByChurch(rows);
        const responseMsg = buildGroupedListMessage(grouped);
        
        if (!responseMsg) {
            await sendTelegramMessage(chatId, '현재 등록된 방문 요청이 없습니다.', { reply_to_message_id: messageId, message_thread_id: threadId });
        } else {
            await sendLongMessage(chatId, responseMsg, { reply_to_message_id: messageId, message_thread_id: threadId });
        }
    }

    res.status(200).send('OK');
});

// 자동 스케줄 요약 전송
app.get('/summary', async (req, res) => {
    try {
        const rows = await getSheetRowsAsObjects();
        if (rows.length === 0) return res.status(200).send('No data');

        const grouped = groupByChurch(rows);
        const responseMsg = buildGroupedListMessage(grouped);
        
        const threadId = USE_MESSAGE_THREAD_ID ? DEFAULT_MESSAGE_THREAD_ID : undefined;
        await sendLongMessage(SUMMARY_CHAT_ID, responseMsg, { message_thread_id: threadId });
        
        res.status(200).send('Summary sent');
    } catch (error) {
        res.status(500).send('Error');
    }
});

// --- 사용자 요청 테스트 엔드포인트 ---
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/test-save', async (req, res) => {
  try {
    await saveToGoogleSheet({
      created_at: '2026-04-23 22:00:00',
      visit_jipa: '서울지파',
      visit_church: '은혜교회',
      group_key: '서울지파/은혜교회',
      department: '서울지파/은혜교회/청년부',
      name: '홍길동',
      unique_number: '12345678-12345',
      phone: '010-1234-5678',
      address: '수원시',
      reason: '예배 참석',
      visit_datetime_raw: '2026.04.25 (금) 14:00',
      visit_datetime_display: '2026.04.25 (금) 14:00',
      manager_name: '김담당',
      manager_phone: '010-9999-8888',
      telegram_chat_id: '-1001234567890',
      telegram_message_id: '101'
    });
    res.json({ ok: true, message: '저장 완료' });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/test-list', async (req, res) => {
  try {
    const rows = await getSheetRowsAsObjects();
    const grouped = groupByChurch(rows);
    const result = Object.entries(grouped).map(([groupKey, items]) => ({
      groupKey,
      count: items.length,
      items: sortRowsByVisitDateTime(items)
    }));
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
