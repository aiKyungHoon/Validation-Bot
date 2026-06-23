const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

// 컬럼 인덱스 → 필드명 고정 매핑 (saveToGoogleSheet 저장 순서와 일치)
const COLUMN_MAP = [
  'created_at',             // A(0)
  'visit_jipa',             // B(1)
  'visit_church',           // C(2)
  'group_key',              // D(3)
  'department',             // E(4)
  'name',                   // F(5)
  'unique_number',          // G(6)
  'phone',                  // H(7)
  'address',                // I(8)
  'reason',                 // J(9)
  'visit_datetime_raw',     // K(10)
  'visit_datetime_display', // L(11)
  'manager_name',           // M(12)
  'manager_phone',          // N(13)
  'telegram_chat_id',       // O(14)
  'telegram_message_id',    // P(15)
  'visit_end_date'          // Q(16) ← 반복 방문 종료일
];


function getGoogleAuth() {
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;

  if (!clientEmail || !privateKey) {
    throw new Error('Google Sheets 인증용 환경변수가 없습니다.');
  }

  return new google.auth.JWT(
    clientEmail,
    null,
    privateKey.replace(/\\n/g, '\n'),
    SCOPES
  );
}

function getSheetsClient() {
  const auth = getGoogleAuth();
  return google.sheets({ version: 'v4', auth });
}

/**
 * requests 시트에 1행 추가
 */
async function saveToGoogleSheet(row) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  if (!spreadsheetId) throw new Error('GOOGLE_SHEET_ID가 없습니다.');

  const sheets = getSheetsClient();

  const values = [[
    row.created_at || '',
    row.visit_jipa || '',
    row.visit_church || '',
    row.group_key || '',
    row.department || '',
    row.name || '',
    row.unique_number || '',
    row.phone || '',
    row.address || '',
    row.reason || '',
    row.visit_datetime_raw || '',
    row.visit_datetime_display || '',
    row.manager_name || '',
    row.manager_phone || '',
    row.telegram_chat_id || '',
    row.telegram_message_id || '',
    row.visit_end_date || ''   // Q(16): 반복 방문 종료일
  ]];

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: 'requests!A:Q',
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values }
  });

  console.log('[Sheets] 저장 완료:', row.name, row.group_key, row.visit_end_date ? `(종료일: ${row.visit_end_date})` : '');

}

/**
 * requests 시트 전체 조회 (raw 2D array)
 */
async function getSheetRows() {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  if (!spreadsheetId) throw new Error('GOOGLE_SHEET_ID가 없습니다.');

  const sheets = getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'requests!A:P'
  });

  return response.data.values || [];
}

/**
 * 2D 배열을 객체 배열로 변환 (고정 컬럼 인덱스 기반)
 * 헤더 행('created_at' 시작)은 자동으로 건너뜀
 */
async function getSheetRowsAsObjects() {
  const rows = await getSheetRows();
  if (rows.length === 0) return [];

  return rows
    .filter(row => row.length > 0 && row[0] !== 'created_at')
    .map(row => {
      const obj = {};
      COLUMN_MAP.forEach((fieldName, index) => {
        obj[fieldName] = row[index] || '';
      });
      console.log('[Sheets] row:', obj.name, '|', obj.group_key, '|', obj.visit_datetime_display);
      return obj;
    });
}

/**
 * 방문지파/방문교회 기준 그룹핑
 */
function groupByChurch(rows) {
  return rows.reduce((acc, row) => {
    const key = row.group_key || '기타/미분류';
    if (!acc[key]) acc[key] = [];
    acc[key].push(row);
    return acc;
  }, {});
}

/**
 * 방문일시_display 기준 오름차순 정렬
 */
function sortRowsByVisitDateTime(rows) {
  return [...rows].sort((a, b) => {
    const aValue = a.visit_datetime_display || '';
    const bValue = b.visit_datetime_display || '';
    return aValue.localeCompare(bValue, 'ko');
  });
}

module.exports = {
  saveToGoogleSheet,
  getSheetRows,
  getSheetRowsAsObjects,
  groupByChurch,
  sortRowsByVisitDateTime
};
