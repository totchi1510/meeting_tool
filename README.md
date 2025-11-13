# Meeting Tools — Slackで日程調整

Slack上で「作成 → 投票 → 確定/取消 → リマインド → カレンダー反映」まで完結する会議調整ツールです。ICS配信に対応し、任意で Google カレンダーへの直接登録（OAuth）も行えます。Socket Mode で動作するため公開URLなしでも使用できます。

## 特徴
- Slack Socket Mode で動作（公開URL不要）
- 投票締切の到来で自動確定（10分ごとにバッチ）
- ICS配信（共有/ユーザー別）と、任意の Google カレンダー登録/削除
- 部屋状況を `now/today/week/month` で一覧化（確定・候補・未割当）
- 投票前/開始前のDMリマインド（重複送信防止済み）

## クイックスタート（ローカル）
- 前提: Node `>= 20`, PostgreSQL 接続先, Slack App の各種トークン
- 手順:
  1) `.env.example` を参考に `.env` を作成
  2) `npm ci`
  3) `npm run build` → `npm start`（開発時は `npm run dev`）
  4) `http://localhost:3000/healthz` が `ok` を返せば起動成功
- Slackの環境変数が揃っていれば、Socket Mode でリスナーが起動します
- DBマイグレーションは起動時に自動実行（可能な範囲）

## Docker Compose
- 1) `.env` を用意
- 2) `docker compose up -d --build`
- 3) `http://localhost:3000/healthz` が `ok`

## Fly.io へのデプロイ
- 初回: `fly launch` 済みを前提。以降は `fly deploy`（ローカルビルド時は `--local-only`）
- Secrets: `fly secrets set DATABASE_URL=... SLACK_* ... PUBLIC_BASE_URL=...`
- 確認: `fly logs`, `fly status`, `GET /healthz`
- ログに `Slack Bolt (Socket Mode) started` と `[cron] auto-close scheduled every 10 minutes` が出力されます

## スラッシュコマンド
- `/help` … 全機能の日本語ヘルプ
- `/mtg new` … 新規ミーティング作成モーダル
- `/mtg status <event_id>` … 候補/投票状況の表示
- `/mtg close <event_id>` … 投票結果から日時を確定（作成者のみ）
- `/mtg cancel <event_id>` … ミーティング取消（作成者のみ）
- `/mtg cal` … ICS購読リンクの案内（個人用トークン発行）＋Google連携リンク
- `/room now|today|week|month` … 部屋の空き/確定/候補の可視化
- 返信は原則エフェメラル（実行者にのみ表示）。`/mtg new` 初回投稿のみチャンネル公開、以降の通知はスレッドに紐づきます

## ICS と Google カレンダー
- ICS
  - 共有フィード: `GET /ics/shared.ics`（確定済みのみ）
  - 個人フィード: `GET /ics/u/<token>.ics`（`/mtg cal` 実行で発行）
- Google（任意）
  - OAuth: `GET /oauth/google/start` → `GET /oauth/google/callback`
  - 確定で作成・取消で削除（ベストエフォート）
  - `GCALENDAR_ID_SHARED` は「カレンダーID」を設定（例: `xxxxx@group.calendar.google.com`）。URLや`.ics`を指定した場合は `primary` にフォールバック
  - 403 `requiredAccessLevel` は、そのIDに「Make changes to events」権限を付与

## 自動確定のロジック
- 条件: `events.status = 'planning' AND deadline_at <= now()`
- 選び方: yes票優先 → maybe票 → 早い開始時刻
- 定員/重複チェック: 同室の重複や定員超過は自動確定を保留（手動確定時はエラー表示）
- 確定時: `bookings` 作成、参加者スナップショット、スレッド通知、ICS反映、（任意）Google登録

## リマインド（自動）
- 投票リマインド: 締切の所定時間前に未投票の必須参加者へDM
- 開始前リマインド: 開始の所定時間前に参加者へDM
- 実行間隔: 10分ごと＋Slack起動時にスケジュール
- 重複防止: `reminders_sent` への予約INSERT（`insert ... on conflict ... returning`）で送信前ロック

## 主要エンドポイント
- 健康確認: `GET /healthz` → `ok`
- ルート: `GET /` → `meeting-tools running`
- ICS: `GET /ics/shared.ics`, `GET /ics/u/:token.ics`
- Google OAuth: `GET /oauth/google/start`, `GET /oauth/google/callback`

## 環境変数（主要）
- Slack: `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`
- DB: `DATABASE_URL`
- 公開URL: `PUBLIC_BASE_URL`（ICSリンク生成に使用）
- Google（任意）: `ENABLE_GCAL_OAUTH`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `OAUTH_REDIRECT_BASE_URL`, `GCALENDAR_ID_SHARED`
- App: `NODE_ENV`, `APP_TIMEZONE`（例: `Asia/Tokyo`）

## データモデル（概要）
- `events`（planning/closed/fixed, deadline, room_id, meeting_url, Slackメッセージ紐づけ）
- `event_options`, `votes`, `rooms(capacity)`, `bookings`（unique event）, `attendance_logs`
- `event_required_users`, `user_ics_tokens`, `oauth_tokens`, `reminders_sent`

## 開発メモ
- スクリプト: `npm run dev`, `npm run build`, `npm start`
- 起動時にマイグレーションを実行（`src/migrate.ts` → `migrations/*.sql`）
- ソケットモードのログは起動時のコンソールを確認

## ライセンス
プロジェクト方針に合わせて追記してください

