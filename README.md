# Meeting Tools MVP（Docker/常時起動 前提）

## 目的
Slack内で日程調整を完結し、締切時に自動確定してカレンダーに反映（ICS購読またはOAuthによるGoogleカレンダー登録）。部屋の使用状況の可視化を提供する。

## スコープ/前提
- 実行基盤: Docker コンテナで常時起動（Fly.io 無料枠想定）
- 受信方式: Slack Socket Mode（公開URL不要）
- DB: Serverless Postgres（Neon 無料枠想定）
- タイムゾーン: Asia/Tokyo 固定
- ユーザー属性: 学部（faculty）・学年（year）のみ収集

## 機能要件（MVP）
1. `/mtg new` で候補作成（タイトル／プロジェクト／候補最大8／場所／締切）
2. 投票UI（参加／未定／不可）＋リアルタイム集計
3. 締切で自動確定（yes最大→maybe少→開始早い）
4. Googleカレンダーへ自動登録（重複チェック・プロジェクト色 `colorId` 付与）
5. `/room`（now/today/week）で空き状況をエフェメラル表示
6. 学部×学年の参加ログを自動記録（確定時にyesをスナップショット）
7. リマインド：未投票者に前日9:00DM、参加者に開始60分前DM（既定ON）

## コマンド（表示特性）
- `/mtg new`: モーダル→投票メッセージをチャンネル1件投稿（以降はスレッドで更新、公開）
- `/mtg status <event_id>`: 集計の要約（共有ボタン付き、エフェメラル）
- `/mtg close <event_id>`: 手動確定（作成者or管理者のみ、エフェメラル）
- `/room [now|today|week]`: 部屋の空き状況（エフェメラル）
- `/cal link`: 購読用リンク（ICS購読URL、エフェメラル）
  - 共有ICS: `/ics/shared.ics`
  - 個人ICS: `/ics/u/<token>.ics`（自分が必要なミーティングのみ）
- `/me set|show`: 学部・学年の登録/確認（エフェメラル）
- `/help`: 使い方（エフェメラル）

## 画面/体験（要点）
- 投票メッセージ: 候補ごとに [参加][未定][不可]＋行末に集計バッジ
- 確定通知: 元スレッドに短文＋GCalリンクのみ（ノイズ最小）
- App Home: 自分の参加予定／投票状況、（将来）傾向カード

## データモデル（最小）
```
create table projects (id uuid primary key default gen_random_uuid(), name text not null, gcal_color_id text);
create table events   (id uuid primary key default gen_random_uuid(), project_id uuid references projects(id),
  title text not null, location text, status text check(status in('planning','closed','fixed')) not null,
  deadline_at timestamptz not null, created_by text not null, created_at timestamptz default now());
create table event_options (id uuid primary key default gen_random_uuid(), event_id uuid references events(id) on delete cascade,
  start_at timestamptz not null, end_at timestamptz not null, unique(event_id,start_at,end_at));
create table votes (id uuid primary key default gen_random_uuid(), event_option_id uuid references event_options(id) on delete cascade,
  slack_user_id text not null, choice text check(choice in('yes','no','maybe')) not null, voted_at timestamptz default now(),
  unique(event_option_id, slack_user_id));

-- 部屋＆予約（MVPは単一カレンダーでroom_idはnull許容）
create table rooms (id uuid primary key default gen_random_uuid(), name text unique, calendar_id text, color text);
create table bookings (id uuid primary key default gen_random_uuid(), room_id uuid references rooms(id),
  event_id uuid references events(id) on delete cascade, start_at timestamptz not null, end_at timestamptz not null,
  gcal_event_id text, unique(room_id, start_at, end_at));

-- ユーザー属性（学部・学年）
create table user_profiles (slack_user_id text primary key, display_name text,
  faculty text not null, year text not null, updated_at timestamptz default now());

-- 参加ログ（確定時にyesだけ出力）
create table attendance_logs (id uuid primary key default gen_random_uuid(), event_id uuid references events(id) on delete cascade,
  slack_user_id text references user_profiles(slack_user_id), decided_option_id uuid references event_options(id),
  start_at timestamptz not null, end_at timestamptz not null, recorded_at timestamptz default now(),
  unique(event_id, slack_user_id));

-- リマインド（冪等管理）
alter table events add column remind_vote_before_minutes int default 24*60;
alter table events add column remind_join_before_minutes int default 60;
create table reminders_sent (id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade, user_id text not null,
  type text check(type in('vote','join')) not null, sent_at timestamptz default now(),
  unique(event_id, user_id, type));
```

## 外部連携（最小）
- ICS購読フィード
  - 共有URL: `/ics/shared.ics`（`PUBLIC_BASE_URL` を設定して配布推奨）
- Google Calendar 直接登録（任意／OAuth方式）
  - 有効化: `ENABLE_GCAL_OAUTH=true` と OAuth クライアント情報を設定
  - 予定作成: `events.insert` 相当のAPIで作成（`projects.gcal_color_id` があれば `colorId` 指定）
  - 重複検知: timeMin/timeMax 検索＋DBの `bookings` 一意制約

## リマインド（既定）
- 締切前日09:00: 未投票者へDM（1回）
- 開始60分前: yesの人へDM（1回）
- スケジュール実行: アプリ内 `node-cron` で10分おきにポーリング（常時起動のため実行安定）

## 権限・可視性
- `/mtg new` のみ公開投稿。他はエフェメラル（必要なら「チャンネルに共有」ボタン）
- `/mtg close` は作成者 or 管理者のみ

## 非機能（MVP）
- 応答: 投票→表示更新 <2秒（常時起動でCold startなし）
- タイムゾーン: Asia/Tokyo固定
- ログ: 作成・投票・確定・登録結果を記録（障害解析用）

## 受入基準（テスト観点）
- `/mtg new` 実行から30秒以内に投票UI表示
- 3人以上の投票→集計が即時に正しく反映
- 締切後に自動確定し、GCalに1件登録（重複なし・色がプロジェクト通り）
- `/room now` で空き部屋がエフェメラル表示
- `/me set` で学部・学年登録→確定時に `attendance_logs` へyesが出力
- 前日・60分前のDMリマインドが1回のみ届く

## デプロイ（Docker + Fly.io）
- 目的: 無料枠で常時起動・低レイテンシ運用
- 前提: `Dockerfile` と `fly.toml` を用意（最小でOK）
- ビルド/デプロイ: ローカルDocker不要。`fly deploy --remote-only`
- 推奨リージョン: `nrt`（東京）

### 必要なSecrets（例）
- `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`（Socket Mode用）
- `DATABASE_URL`（Neon等）
- `PUBLIC_BASE_URL`（ICS配布に推奨）
- （任意）Google OAuthを使う場合
  - `ENABLE_GCAL_OAUTH=true`
  - `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `OAUTH_REDIRECT_BASE_URL`
  - `GCALENDAR_ID_SHARED`（登録先ID。未設定なら `primary`）

### 参考Docker設定（最小）
- Node LTSベース
- `TZ=Asia/Tokyo`
- `npm ci && npm run build && node dist/index.js`

## コスト指針
- Fly.io: 無料枠（shared-cpu-1x/256MB 1台）
- Neon: 無料枠（低トラフィック想定）
- いずれも超過時は性能スロットル/課金に注意

## リポジトリ構成
- `migrations/`（SQL DDL）
- `src/`（Bolt, services, db）
- `README.md`（本書）
- `DEVSTEP.md`（開発手順）

## ローカル動作確認
- 前提: Docker が利用可能
- 起動（Postgres + アプリ）:
  - `docker compose up --build -d`
  - ヘルス確認: `curl http://localhost:3000/healthz` → `ok`
- Slack を繋ぐ場合（任意）:
  - `.env.example` を参考に `.env` を作り、Slack トークンを設定
  - `docker compose` の `app` サービスに環境変数を渡す（環境直書き or `.env` 参照）
  - Slack App 設定: Socket Mode ON、Slash Commands `/mtg` `/help`、Interactivity ON
- コマンド（検証用）:
  - `/help` 疎通確認（エフェメラル）
  - `/mtg new` → モーダル入力 → 投票メッセージ投稿
  - 投票ボタンで集計更新
  - `/mtg status <event_id>` 要約（エフェメラル）
  - `/mtg close <event_id>` 手動確定（作成者のみ）
