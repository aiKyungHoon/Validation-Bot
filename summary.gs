/**
 * =====================================================
 * 텔레그램 방문 요청 현황 자동 전송 - Apps Script
 * =====================================================
 * 
 * [설정 방법]
 * 1. 아래 설정값(CONFIG)을 본인 것으로 변경
 * 2. 상단 메뉴 > 트리거 설정 (시계 아이콘) > 주기적 트리거 추가
 *    - 함수: sendWeeklySummary
 *    - 이벤트: 시간 기반 > 주간 타이머
 *    - 화요일 오전 12:00, 금요일 오전 12:00 각각 추가
 */

// =====================================================
// ⚙️ 설정값 (여기만 수정하면 됩니다)
// =====================================================
const CONFIG = {
  TELEGRAM_BOT_TOKEN: '여기에_봇_토큰',         // 텔레그램 봇 토큰
  TELEGRAM_CHAT_ID: '여기에_챗_ID',             // 전송할 채팅방 ID (음수 포함)
  MESSAGE_THREAD_ID: '',                          // 토픽방 ID (일반방이면 빈 문자열 '')
  SHEET_NAME: 'requests',                         // 시트 이름
};

// =====================================================
// 📤 메인 함수 (트리거에서 이 함수를 호출)
// =====================================================
function sendWeeklySummary() {
  try {
    // 1. 시트에서 데이터 읽기
    const rows = getSheetRowsAsObjects();

    // 2. 데이터 없으면 전송 안 함
    if (rows.length === 0) {
      console.log('전송할 데이터가 없습니다.');
      return;
    }

    // 3. 교회별 그룹핑
    const grouped = groupByChurch(rows);

    // 4. 메시지 생성
    const message = buildGroupedListMessage(grouped);
    if (!message) {
      console.log('메시지 생성 실패');
      return;
    }

    // 5. 텔레그램 전송 (긴 메시지 분할 처리 포함)
    sendLongMessage(CONFIG.TELEGRAM_CHAT_ID, message);

    console.log('전송 완료!');
  } catch (e) {
    console.error('sendWeeklySummary 오류:', e.message);
  }
}

// =====================================================
// 📊 시트 데이터 조회
// =====================================================
function getSheetRowsAsObjects() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);

  if (!sheet) {
    throw new Error(`시트를 찾을 수 없습니다: ${CONFIG.SHEET_NAME}`);
  }

  const data = sheet.getDataRange().getValues();

  // 데이터가 헤더 행만 있거나 없으면 빈 배열 반환
  if (data.length < 2) return [];

  const headers = data[0];
  const dataRows = data.slice(1);

  // 헤더를 key로 사용하여 객체 배열 생성
  return dataRows
    .filter(row => row.some(cell => cell !== '')) // 빈 행 제거
    .map(row => {
      const obj = {};
      headers.forEach((header, index) => {
        obj[header] = row[index] !== undefined ? String(row[index]) : '';
      });
      return obj;
    });
}

// =====================================================
// 🏛️ 교회별 그룹핑
// =====================================================
function groupByChurch(rows) {
  const groups = {};

  rows.forEach(row => {
    const key = row['group_key'] || '기타/미분류';
    if (!groups[key]) groups[key] = [];
    groups[key].push(row);
  });

  // 각 그룹 내에서 방문일시 오름차순 정렬
  for (const key in groups) {
    groups[key].sort((a, b) => {
      const aVal = a['visit_datetime_display'] || '';
      const bVal = b['visit_datetime_display'] || '';
      return aVal.localeCompare(bVal, 'ko');
    });
  }

  return groups;
}

// =====================================================
// 📝 메시지 빌드 (index.js와 동일한 포맷 유지)
// =====================================================
function buildGroupedListMessage(groupedRows) {
  let message = '📋 교회별 방문 요청 현황\n';

  const keys = Object.keys(groupedRows).sort();
  if (keys.length === 0) return null;

  keys.forEach(key => {
    const members = groupedRows[key];
    message += `\n[${key}] ${members.length}건\n`;
    members.forEach((m, idx) => {
      message += `${idx + 1}. ${m['name']} / ${m['visit_datetime_display']}\n`;
    });
  });

  return message;
}

// =====================================================
// ✉️ 긴 메시지 분할 전송 (4000자 기준)
// =====================================================
function sendLongMessage(chatId, text) {
  const MAX_LENGTH = 4000;

  if (text.length <= MAX_LENGTH) {
    sendTelegramMessage(chatId, text);
    return;
  }

  // 줄 단위로 분할
  const lines = text.split('\n');
  const chunks = [];
  let current = '';

  lines.forEach(line => {
    if ((current + line).length > MAX_LENGTH) {
      chunks.push(current);
      current = line + '\n';
    } else {
      current += line + '\n';
    }
  });
  if (current) chunks.push(current);

  // 순차 전송 (머리말 포함)
  chunks.forEach((chunk, i) => {
    const content = chunks.length > 1 ? `(${i + 1}/${chunks.length})\n${chunk}` : chunk;
    sendTelegramMessage(chatId, content);
    Utilities.sleep(500); // 0.5초 간격으로 전송
  });
}

// =====================================================
// 📡 텔레그램 API 호출
// =====================================================
function sendTelegramMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;

  const payload = {
    chat_id: chatId,
    text: text
  };

  // 토픽방 설정이 있을 때만 포함
  if (CONFIG.MESSAGE_THREAD_ID) {
    payload.message_thread_id = Number(CONFIG.MESSAGE_THREAD_ID);
  }

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(url, options);
  const result = JSON.parse(response.getContentText());

  if (!result.ok) {
    console.error('텔레그램 전송 오류:', result.description);
  }
}

// =====================================================
// 🧪 수동 테스트용 함수 (실행해서 확인)
// =====================================================
function testSendSummary() {
  sendWeeklySummary();
}
