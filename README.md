# Telegram Verification Bot (Validation-Bot)

이 봇은 텔레그램을 통해 접수되는 '방문 요청서' 양식을 자동으로 검증하고 구글 시트에 기록하는 자동화 봇입니다.

## 🚀 주요 기능
- **양식 자동 검증**: 정해진 '방문 요청서' 양식(고유번호, 연락처 등)에 맞지 않으면 사용자에게 오류 메시지를 회신합니다.
- **구글 시트 연동**: 양식이 올바르면 구글 시트에 데이터를 자동으로 기록합니다.
- **토픽(Thread) 무시 기능 (`IGNORE_THREAD_IDS`)**: 특정 토픽 창에서 올라오는 메시지는 봇이 검증을 건너뛰고 무시하도록 설정할 수 있습니다.
- **`/topicid` 명령어 지원**: 텔레그램 토픽(Thread) 창 안에서 `/topicid`를 입력하면 해당 토픽의 고유 ID를 쉽게 확인할 수 있습니다.
- **자동 요약 전송**: 특정 시간에 맞춰 현재까지 등록된 방문 요청 현황을 요약해서 지정된 단톡방에 전송합니다.

## ⚙️ 환경 변수 설정 (.env)
로컬 테스트 또는 Cloud Run 환경 변수 설정 시 다음 값들을 등록해야 합니다.

```env
TELEGRAM_BOT_TOKEN=봇파더에게_받은_토큰
WEBHOOK_SECRET=웹훅보안을_위한_임의문자열
SUMMARY_CHAT_ID=요약메시지를_받을_채팅방ID

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
- 배포가 완료된 후에는 해당 URL과 `WEBHOOK_SECRET`을 조합하여 텔레그램 봇의 `setWebhook` API를 등록해주어야 합니다.
