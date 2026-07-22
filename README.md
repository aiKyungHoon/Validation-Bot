# Telegram Verification Bot (Validation-Bot)

이 봇은 텔레그램을 통해 접수되는 '방문 요청서' 양식을 자동으로 검증하고 구글 시트에 기록하는 자동화 봇입니다.

## 🚀 주요 기능
- **양식 자동 검증**: 정해진 '방문 요청서' 양식(고유번호, 연락처 등)에 맞지 않으면 사용자에게 오류 메시지를 회신합니다.
- **구글 시트 연동**: 양식이 올바르면 구글 시트에 데이터를 자동으로 기록합니다.
- **토픽(Thread) 무시 기능 (`IGNORE_THREAD_IDS`)**: 특정 토픽 창에서 올라오는 메시지는 봇이 검증을 건너뛰고 무시하도록 설정할 수 있습니다.
- **`/topicid` 명령어 지원 (관리자 전용)**: 텔레그램 토픽(Thread) 창 안에서 `/topicid`를 입력하면 해당 토픽의 고유 ID를 확인할 수 있습니다.
- **`/myid` 명령어**: 본인의 사용자 ID를 알려줍니다. `ADMIN_USER_IDS` 설정 시 사용합니다.
- **접근 제어**: `ALLOWED_CHAT_IDS`에 없는 그룹에 초대되면 봇이 **자동으로 나갑니다**. 전체 명단 조회(`/목록`)는 `ADMIN_USER_IDS`에 등록된 관리자만 사용할 수 있습니다.
- **자동 요약 전송**: Cloud Scheduler가 `GET /summary`를 주기적으로 호출하면, 현재 유효한 방문 요청 현황을 요약해 지정된 단톡방(`SUMMARY_CHAT_ID`)에 전송합니다.

## ⚙️ 환경 변수 설정 (.env)
로컬 테스트 또는 Cloud Run 환경 변수 설정 시 다음 값들을 등록해야 합니다.

```env
TELEGRAM_BOT_TOKEN=봇파더에게_받은_토큰
WEBHOOK_SECRET=웹훅_URL경로에_들어갈_임의문자열
TELEGRAM_SECRET_TOKEN=setWebhook의_secret_token_임의문자열
SUMMARY_SECRET=summary_호출용_임의문자열
SUMMARY_CHAT_ID=요약메시지를_받을_채팅방ID

# 접근 제어
ALLOWED_CHAT_IDS=-1001234567890   # 봇이 응답할 채팅방 ID (쉼표 구분). 비우면 SUMMARY_CHAT_ID만 허용
ADMIN_USER_IDS=123456789          # 관리자 전용 명령 사용자 ID (쉼표 구분). /myid 로 확인

# 구글 시트 연동 (Google Service Account)
GOOGLE_SHEET_ID=구글시트_고유ID
GOOGLE_SERVICE_ACCOUNT_EMAIL=서비스어카운트_이메일
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"

# 텔레그램 토픽 및 스레드 설정
USE_MESSAGE_THREAD_ID=false
DEFAULT_MESSAGE_THREAD_ID=
IGNORE_THREAD_IDS=12345,67890  # 봇이 무시할 토픽 ID 목록 (쉼표로 구분하여 여러 개 등록 가능)
```

## 🛠 실행 및 배포 방법

### 로컬 환경에서 테스트
1. 패키지 설치: `npm install`
2. 환경변수 파일 복사 및 작성: `.env.example`을 참고하여 `.env` 작성
3. 실행: `npm start` (또는 `node index.js`)

### 구글 클라우드 런(Cloud Run) 배포
이 프로젝트는 `Dockerfile`을 포함하고 있어 구글 클라우드 런(Google Cloud Run)에 쉽게 배포할 수 있습니다.
- Cloud Run 콘솔에서 코드를 연동하여 배포를 진행합니다.
- 배포 후 `setWebhook`을 등록할 때, **URL 경로의 `WEBHOOK_SECRET`과 `secret_token`을 반드시 함께** 넘겨야 합니다. 둘 중 하나라도 맞지 않으면 서버가 403으로 거부합니다.

```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
        "url": "https://<CLOUD_RUN_URL>/webhook/<WEBHOOK_SECRET>",
        "secret_token": "<TELEGRAM_SECRET_TOKEN>"
      }'
```

### 정기 요약 전송 (Cloud Scheduler)
요약 전송은 `GET /summary` 하나로 통일되어 있습니다. Cloud Scheduler에서 아래처럼 잡을 만들어 주기적으로 호출하세요.

```bash
gcloud scheduler jobs create http visit-summary \
  --location=asia-northeast3 \
  --schedule="0 12 * * 2,5" \
  --time-zone="Asia/Seoul" \
  --uri="https://<CLOUD_RUN_URL>/summary" \
  --http-method=GET \
  --headers="X-Summary-Secret=<SUMMARY_SECRET>"
```

- `--schedule="0 12 * * 2,5"` = 매주 **화·금 낮 12시**. 원하는 주기로 바꾸면 됩니다.
- 콘솔에서 만들 경우 **HTTP 헤더**에 `X-Summary-Secret` / `<SUMMARY_SECRET>`을 추가하세요.
- 인증에 실패하면 403, 데이터가 없으면 `No data`를 반환하고 아무것도 전송하지 않습니다.

> ⚠️ 비밀값은 URL 쿼리스트링이 아니라 **헤더로만** 전달합니다(요청 로그·이력에 남지 않도록).

## 🔐 보안 참고
- **BotFather의 privacy mode는 반드시 꺼둔 상태(Disabled)여야 합니다.** 이 봇은 슬래시 명령이 아닌 평문 '방문 요청서' 메시지를 감지해 동작하므로, privacy mode를 켜면 양식 메시지가 봇에 전달되지 않아 검증 기능이 멈춥니다.
  - 대신 그룹 노출은 `ALLOWED_CHAT_IDS`(미허용 그룹 자동 퇴장)와 `IGNORE_THREAD_IDS`(토픽 제외)로 통제합니다.
- 비밀 환경변수(`TELEGRAM_BOT_TOKEN`, `WEBHOOK_SECRET`, `TELEGRAM_SECRET_TOKEN`, `SUMMARY_SECRET`)가 하나라도 비어 있으면 봇은 기동하지 않고 즉시 종료합니다.
- 인증 없이 시트 데이터를 조회·기록하던 `/test-list`, `/test-save` 엔드포인트는 제거되었습니다.
- 무작위 비밀값 생성: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
