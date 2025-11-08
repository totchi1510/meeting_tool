# 開発ステップ（Docker/常時起動 前提）

## フェーズ0: 環境準備
- リポジトリ/ブランチ運用: main保護、PRレビュー
- ランタイム: Node.js LTS + TypeScript
- コンテナ: Docker（OCIイメージ）。TZ=Asia/Tokyo をコンテナに設定
- ホスティング: Fly.io（常時起動1台、無料枠想定）
- Slack: Socket Mode（公開URL不要）
- DB: Neon（Serverless Postgres 無料枠）
- Secrets: `.env`（ローカル）/ Fly Secrets（本番）
- ツール: flyctl（リモートビルドでローカルDocker不要）、psqlクライアント

必要Secrets（共通）
- `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`
- `DATABASE_URL`
- `PUBLIC_BASE_URL`（ICS配布に推奨）
- （任意）Google OAuth を使う場合:
  - `ENABLE_GCAL_OAUTH=true`
  - `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `OAUTH_REDIRECT_BASE_URL`
  - `GCALENDAR_ID_SHARED`（未設定なら primary）

## Sprint 1
1) DBマイグレーション
- 目的: 初期DDLを適用し最小テーブル群を作成
- タスク: `migrations/001_init.sql` を適用、インデックス含む
- DoD: ローカル/本番で適用可能。再実行に耐える（IF NOT EXISTS）

2) `/mtg new` → 投票UI → 集計更新
- 目的: 候補作成から投票・集計までの基本UX
- タスク:
  - Slash `/mtg new` モーダル（タイトル/プロジェクト/≤8/場所/締切）
  - メッセージ投稿（公開）＋ [参加][未定][不可] ボタン
  - 投票ハンドラ（votes書込→集計→メッセ更新）
  - DB: events, event_options, votes 連携
- DoD: 3名以上で投票し集計が即時反映、応答<2秒

3) 自動確定ロジック + `/mtg close`
- 目的: 締切時の自動確定と手動確定
- ルール: yes最大→maybe少→開始早い
- タスク:
  - ポーリング（アプリ内部`node-cron` 10分）で期限到達を検知→確定処理
  - 手動 `/mtg close <event_id>`（権限制御）
- DoD: 締切後に自動確定、スレッド通知が最小で出る

4) カレンダー反映（ICS/OAuth）
- 目的: 確定イベントをカレンダーに反映
- タスク:
  - ICS配信: `/ics/shared.ics` に反映
  - （任意）OAuth有効時は Google Calendar へ登録（重複検知+colorId）
- DoD: ICS購読で予定が見える／OAuth時はGCalに1件登録（重複なし・色がプロジェクト通り）

## Sprint 2
5) `/room` now/today/week（エフェメラル）
- タスク: 現在/当日/週の空き状況をクエリし整形表示
- DoD: `/room now` が正しく表示

6) `/me set|show` と `attendance_logs` 出力
- タスク: プロフィール登録/確認、確定時に yes 投票者を `attendance_logs` へ書き込み
- DoD: `/me set` 後、確定イベントでログが生成

7) リマインド（Cron＋DM）
- タスク: `node-cron`（10分）でポーリングし、`reminders_sent` で冪等管理
  - 締切前日 09:00: 未投票者へDM
  - 開始 60分前: yes の人へDM
- DoD: 各DMが1回のみ送信

8) 受入テスト＋最小ドキュメント
- タスク: 手順書、コマンドヘルプ、運用Runbook、既知の制約
- DoD: 受入観点に合格し、README更新

## デプロイ手順（Fly.io 無料枠）
1) 初期化
- `flyctl auth login`
- `fly launch --no-deploy`（Dockerfile未作成なら自動生成可）
- リージョン: `nrt` を選択

2) Secrets 設定
- `fly secrets set SLACK_SIGNING_SECRET=... SLACK_BOT_TOKEN=xoxb-... SLACK_APP_TOKEN=xapp-...`
- `fly secrets set DATABASE_URL=... PUBLIC_BASE_URL=... GCALENDAR_ID_SHARED=...`
- （任意/OAuth有効化）`fly secrets set ENABLE_GCAL_OAUTH=true GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... OAUTH_REDIRECT_BASE_URL=...`

3) デプロイ
- `fly deploy --remote-only`
- スケール: デフォルト1台（shared-cpu-1x/256MB）
- 稼働確認: `fly logs` / ヘルスチェック

4) 運用
- ログ監視: エラー（GCal/DB/Slack rate limit）
- 秘密情報ローテーション: `fly secrets set ...` 再投入
- バックアップ: DBスナップショット（Neon）

## 参考ファイル（作成方針）
- Dockerfile（最小）
  - `FROM node:lts-alpine`、`ENV TZ=Asia/Tokyo`、`npm ci`→`npm run build`→`node dist/index.js`
- fly.toml
  - `primary_region = "nrt"`、ヘルスチェック、ログ設定

## テスト戦略
- ユニット: 決定ロジック/集計/時刻境界
- 結合: Slackハンドラ→DB→メッセ更新
- 外部: （任意）GCal API をモックして events.insert/検索を検証（OAuth）
- 手動: 受入基準シナリオ

## 既知の制約（MVP）
- タイムゾーン固定（Asia/Tokyo）
- 共有カレンダーは単一（将来室別分割を検討）
- App Home の傾向カードは簡易版
