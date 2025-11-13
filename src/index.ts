import express from 'express';
import { App, LogLevel } from '@slack/bolt';
import cron from 'node-cron';
import dotenv from 'dotenv';
import { migrateIfPossible } from './migrate';
import { query, withClient } from './db';
import { getAuthUrl, exchangeCodeAndStore, oauthEnabled, registerFixedEventToGCalOAuth, cancelFixedEventFromGCalOAuth } from './gcal_oauth';
import { buildICS } from './ics';
import crypto from 'crypto';

// Load .env if present (local dev convenience)
dotenv.config();

const PORT = Number(process.env.PORT || 3000);

// Minimal health server
const http = express();
http.get('/healthz', (_req, res) => {
  res.status(200).send('ok');
});
http.get('/', (_req, res) => {
  res.status(200).send('meeting-tools running');
});

// OAuth: start and callback (Google, non-Workspace)
http.get('/oauth/google/start', (_req, res) => {
  try {
    const url = getAuthUrl();
    res.redirect(url);
  } catch (e) {
    res.status(500).send('OAuth not configured');
  }
});

http.get('/oauth/google/callback', async (req, res) => {
  const { code, error } = req.query as any;
  if (error) return res.status(400).send(`OAuth error: ${error}`);
  if (!code) return res.status(400).send('Missing code');
  try {
    await exchangeCodeAndStore(String(code));
    res.status(200).send('Google連携が完了しました。ウィンドウを閉じてください。');
  } catch (e) {
    console.error('[oauth] callback failed', e);
    res.status(500).send('OAuth連携に失敗しました');
  }
});

// Shared ICS feed for fixed events
http.get('/ics/shared.ics', async (_req, res) => {
  try {
    const r = await query<{
      uid: string; title: string; location: string | null; meeting_url: string | null; start_at: string; end_at: string; updated_at: string;
    }>(
      `select b.id as uid, e.title, e.location, e.meeting_url, b.start_at, b.end_at, coalesce(e.created_at, now()) as updated_at
         from bookings b
         join events e on e.id = b.event_id
        where e.status = 'fixed'
        order by b.start_at asc`
    );
    const events = r.rows.map((row: { uid: string; title: string; location: string | null; meeting_url: string | null; start_at: string; end_at: string; updated_at: string; }) => ({
      uid: row.uid,
      title: row.title,
      location: row.meeting_url ? (row.location ? `${row.location} | ${row.meeting_url}` : row.meeting_url) : row.location,
      start: new Date(row.start_at),
      end: new Date(row.end_at),
      updated: new Date(row.updated_at),
    }));
    const ics = buildICS('Meeting Tools (Shared)', events);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.status(200).send(ics);
  } catch (e) {
    console.error('[ics] failed', e);
    res.status(500).send('failed to build ics');
  }
});

// User-specific ICS feed (required attendee only)
http.get('/ics/u/:token.ics', async (req, res) => {
  const token = req.params.token;
  try {
    const u = await query<{ slack_user_id: string }>('select slack_user_id from user_ics_tokens where token=$1', [token]);
    if (!u.rowCount) return res.status(404).send('not found');
    const userId = u.rows[0].slack_user_id;
    const r = await query<{
      uid: string; title: string; location: string | null; meeting_url: string | null; start_at: string; end_at: string; updated_at: string;
    }>(
      `select b.id as uid, e.title, e.location, e.meeting_url, b.start_at, b.end_at, coalesce(e.created_at, now()) as updated_at
         from bookings b
         join events e on e.id = b.event_id
         join event_required_users ru on ru.event_id = e.id and ru.slack_user_id = $1
        where e.status = 'fixed'
        order by b.start_at asc`,
      [userId]
    );
    const events = r.rows.map((row) => ({
      uid: row.uid,
      title: row.title,
      location: row.meeting_url ? (row.location ? `${row.location} | ${row.meeting_url}` : row.meeting_url) : row.location,
      start: new Date(row.start_at),
      end: new Date(row.end_at),
      updated: new Date(row.updated_at),
    }));
    const ics = buildICS('Meeting Tools (My)', events as any);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.status(200).send(ics);
  } catch (e) {
    console.error('[ics-user] failed', e);
    res.status(500).send('failed to build ics');
  }
});

http.listen(PORT, () => {
  console.log(`[health] listening on :${PORT}`);
});

// Slack (Socket Mode) — start only when envs are available
const hasSlackEnv =
  !!process.env.SLACK_SIGNING_SECRET &&
  !!process.env.SLACK_BOT_TOKEN &&
  !!process.env.SLACK_APP_TOKEN;

if (!hasSlackEnv) {
  console.warn('[slack] env not set; skipping Slack startup');
} else {
  (async () => {
    // Run DB migrations before starting listeners
    await migrateIfPossible();

    const app = new App({
      token: process.env.SLACK_BOT_TOKEN,
      signingSecret: process.env.SLACK_SIGNING_SECRET,
      socketMode: true,
      appToken: process.env.SLACK_APP_TOKEN,
      logLevel: (process.env.SLACK_LOG_LEVEL as LogLevel) || LogLevel.INFO,
    });
    // Expose client for non-listener helpers (thread notifications)
    (global as any)._boltClient = app.client;

    // Minimal command stub for sanity
    app.command('/help', async ({ ack, respond }) => {
      await ack();
      const blocks: any[] = [
        { type: 'header', text: { type: 'plain_text', text: 'Meeting Tools ヘルプ' } },
        { type: 'section', text: { type: 'mrkdwn', text: '*ミーティング関連*（/mtg）\n• `/mtg new` 新規ミーティング作成モーダルを開く\n• `/mtg status <event_id>` 候補の投票状況を表示\n• `/mtg close <event_id>` 投票結果から日時を確定（作成者のみ）\n• `/mtg cancel <event_id>` ミーティングをキャンセル（作成者のみ）\n• `/mtg cal` ICS購読リンクとGoogle連携案内' } },
        { type: 'section', text: { type: 'mrkdwn', text: '*部屋関連*（/room）\n• `/room now` 現在の空き/使用状況\n• `/room today` 今日の確定/候補スロット＋未割当候補\n• `/room week` 今週の確定/候補スロット（圧縮表示）\n• `/room month` 今月の確定/候補スロット（圧縮表示）' } },
        { type: 'section', text: { type: 'mrkdwn', text: '*例*\n• 例: `/mtg status 123e4567-...`\n• 例: `/room today`' } },
      ];
      await respond({ response_type: 'ephemeral', text: 'Meeting Tools ヘルプ', blocks });
    });

    // /mtg handler (new|status|close|cancel|cal)
    app.command('/mtg', async ({ ack, body, client, command }) => {
      await ack();
      const text = (command.text || '').trim();

      if (!text || text.toLowerCase().startsWith('new')) {
        // Open modal for new meeting
        // Load rooms for selection
        let roomOptions: any[] = [];
        try {
          const r = await query<{ id: string; name: string; capacity: number | null }>(
            'select id, name, capacity from rooms order by name asc'
          );
          roomOptions = r.rows.map((row) => ({
            text: { type: 'plain_text', text: row.capacity ? `${row.name} (cap ${row.capacity})` : row.name },
            value: row.id,
          }));
        } catch {}

        // Load projects for selection
        let projectOptions: any[] = [];
        try {
          const p = await query<{ id: string; name: string }>('select id, name from projects order by name asc');
          projectOptions = p.rows.map((row) => ({
            text: { type: 'plain_text', text: row.name },
            value: row.id,
          }));
        } catch {}
        const meta = { channel_id: body.channel_id, options_count: 4 };
        await client.views.open({
          trigger_id: body.trigger_id,
          view: {
            type: 'modal',
            callback_id: 'mtg_new_modal',
            private_metadata: JSON.stringify(meta),
            title: { type: 'plain_text', text: 'New Meeting' },
            submit: { type: 'plain_text', text: 'Create' },
            close: { type: 'plain_text', text: 'Cancel' },
            blocks: [
              {
                type: 'input',
                block_id: 'title_b',
                label: { type: 'plain_text', text: 'Title' },
                element: { type: 'plain_text_input', action_id: 'title_a' },
              },
              {
                type: 'input',
                block_id: 'required_b',
                label: { type: 'plain_text', text: 'Required attendees' },
                element: { type: 'multi_users_select', action_id: 'required_a', placeholder: { type: 'plain_text', text: 'Select users' } },
                optional: true,
              },
              projectOptions.length > 0 ? {
                type: 'input',
                block_id: 'project_b',
                label: { type: 'plain_text', text: 'Project' },
                element: { type: 'static_select', action_id: 'project_a', options: projectOptions, placeholder: { type: 'plain_text', text: 'Select a project' } },
              } as any : {
                type: 'input',
                block_id: 'project_text_b',
                label: { type: 'plain_text', text: 'Project name' },
                element: { type: 'plain_text_input', action_id: 'project_text_a', placeholder: { type: 'plain_text', text: 'e.g., Core' } },
              },
              roomOptions.length > 0 ? {
                type: 'input',
                block_id: 'room_b',
                label: { type: 'plain_text', text: 'Location (room)' },
                element: { type: 'static_select', action_id: 'room_a', options: roomOptions, placeholder: { type: 'plain_text', text: 'Select a room' } },
              } as any : {
                type: 'input',
                block_id: 'location_b',
                label: { type: 'plain_text', text: 'Location (free text)' },
                element: { type: 'plain_text_input', action_id: 'location_a' },
              },
              {
                type: 'input',
                block_id: 'meeting_url_b',
                label: { type: 'plain_text', text: 'Online meeting URL (optional)' },
                element: { type: 'plain_text_input', action_id: 'meeting_url_a', placeholder: { type: 'plain_text', text: 'https://...' } },
                optional: true,
              },
              { type: 'section', text: { type: 'mrkdwn', text: '*Deadline*' } },
              {
                type: 'input',
                block_id: 'deadline_date_b',
                label: { type: 'plain_text', text: 'Date' },
                element: { type: 'datepicker', action_id: 'deadline_date_a' },
              },
              {
                type: 'input',
                block_id: 'deadline_time_b',
                label: { type: 'plain_text', text: 'Time' },
                element: { type: 'timepicker', action_id: 'deadline_time_a', placeholder: { type: 'plain_text', text: 'HH:mm' } },
              },
              { type: 'divider' },
              { type: 'section', text: { type: 'mrkdwn', text: '*Options (up to 8)*' } },
              { type: 'section', text: { type: 'mrkdwn', text: 'Option 1' } },
              { type: 'input', block_id: 'opt1_date_b', label: { type: 'plain_text', text: 'Date' }, element: { type: 'datepicker', action_id: 'opt1_date_a' }, optional: true },
              { type: 'input', block_id: 'opt1_start_b', label: { type: 'plain_text', text: 'Start' }, element: { type: 'timepicker', action_id: 'opt1_start_a' }, optional: true },
              { type: 'input', block_id: 'opt1_end_b', label: { type: 'plain_text', text: 'End' }, element: { type: 'timepicker', action_id: 'opt1_end_a' }, optional: true },
              { type: 'section', text: { type: 'mrkdwn', text: 'Option 2' } },
              { type: 'input', block_id: 'opt2_date_b', label: { type: 'plain_text', text: 'Date' }, element: { type: 'datepicker', action_id: 'opt2_date_a' }, optional: true },
              { type: 'input', block_id: 'opt2_start_b', label: { type: 'plain_text', text: 'Start' }, element: { type: 'timepicker', action_id: 'opt2_start_a' }, optional: true },
              { type: 'input', block_id: 'opt2_end_b', label: { type: 'plain_text', text: 'End' }, element: { type: 'timepicker', action_id: 'opt2_end_a' }, optional: true },
              { type: 'section', text: { type: 'mrkdwn', text: 'Option 3' } },
              { type: 'input', block_id: 'opt3_date_b', label: { type: 'plain_text', text: 'Date' }, element: { type: 'datepicker', action_id: 'opt3_date_a' }, optional: true },
              { type: 'input', block_id: 'opt3_start_b', label: { type: 'plain_text', text: 'Start' }, element: { type: 'timepicker', action_id: 'opt3_start_a' }, optional: true },
              { type: 'input', block_id: 'opt3_end_b', label: { type: 'plain_text', text: 'End' }, element: { type: 'timepicker', action_id: 'opt3_end_a' }, optional: true },
              { type: 'section', text: { type: 'mrkdwn', text: 'Option 4' } },
              { type: 'input', block_id: 'opt4_date_b', label: { type: 'plain_text', text: 'Date' }, element: { type: 'datepicker', action_id: 'opt4_date_a' }, optional: true },
              { type: 'input', block_id: 'opt4_start_b', label: { type: 'plain_text', text: 'Start' }, element: { type: 'timepicker', action_id: 'opt4_start_a' }, optional: true },
              { type: 'input', block_id: 'opt4_end_b', label: { type: 'plain_text', text: 'End' }, element: { type: 'timepicker', action_id: 'opt4_end_a' }, optional: true },
              { type: 'actions', block_id: 'opt_actions_b', elements: [
                { type: 'button', action_id: 'opt_add', text: { type: 'plain_text', text: '候補を追加' }, value: 'add' }
              ] },
            ],
          },
        });
        return;
      } else if (text.toLowerCase().startsWith('help')) {
        const blocks: any[] = [
          { type: 'header', text: { type: 'plain_text', text: 'Meeting Tools ヘルプ' } },
          { type: 'section', text: { type: 'mrkdwn', text: '*ミーティング関連*（/mtg）\n• `/mtg new` 新規ミーティング作成モーダルを開く\n• `/mtg status <event_id>` 候補の投票状況を表示\n• `/mtg close <event_id>` 投票結果から日時を確定（作成者のみ）\n• `/mtg cancel <event_id>` ミーティングをキャンセル（作成者のみ）\n• `/mtg cal` ICS購読リンクとGoogle連携案内' } },
          { type: 'section', text: { type: 'mrkdwn', text: '*部屋関連*（/room）\n• `/room now` 現在の空き/使用状況\n• `/room today` 今日の確定/候補スロット＋未割当候補\n• `/room week` 今週の確定/候補スロット（圧縮表示）\n• `/room month` 今月の確定/候補スロット（圧縮表示）' } },
          { type: 'section', text: { type: 'mrkdwn', text: '*例*\n• 例: `/mtg status 123e4567-...`\n• 例: `/room today`' } },
        ];
        await client.chat.postEphemeral({ channel: body.channel_id, user: body.user_id, text: 'Meeting Tools ヘルプ', blocks });
        return;
      } else if (text.toLowerCase().startsWith('cal') || text.toLowerCase() === 'calendar') {
        const base = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
        const url = `${base.replace(/\/$/, '')}/ics/shared.ics`;
        // Ensure user-specific ICS token
        let tokenRow = await query<{ token: string }>('select token from user_ics_tokens where slack_user_id=$1', [body.user_id]);
        if (!tokenRow.rowCount) {
          const token = crypto.randomBytes(16).toString('hex');
          await query('insert into user_ics_tokens(slack_user_id, token) values ($1,$2) on conflict (slack_user_id) do nothing', [body.user_id, token]);
          tokenRow = await query<{ token: string }>('select token from user_ics_tokens where slack_user_id=$1', [body.user_id]);
        }
        const myUrl = `${base.replace(/\/$/, '')}/ics/u/${tokenRow.rows[0].token}.ics`;
        let msg = `購読リンク(共有): ${url}\n購読リンク(自分用): ${myUrl}\nGoogle/Apple/Outlook 等で購読できます。`;
        if (oauthEnabled() && process.env.OAUTH_REDIRECT_BASE_URL && process.env.GOOGLE_OAUTH_CLIENT_ID) {
          const connectUrl = `${base.replace(/\/$/, '')}/oauth/google/start`;
          msg += `\n\nGoogleカレンダーへ直接登録したい場合: <${connectUrl}|Google連携を開始>`;
        }
        await client.chat.postEphemeral({
          channel: body.channel_id,
          user: body.user_id,
          text: msg,
        });
        return;
      } else if (text.toLowerCase().startsWith('status')) {
        const parts = text.split(/\s+/);
        const eventId = parts[1];
        if (!eventId) {
          await client.chat.postEphemeral({ channel: body.channel_id, user: body.user_id, text: '使い方: /mtg status <event_id>' });
          return;
        }

        const ev = await query<{ id: string; title: string; location: string | null; room_name: string | null; meeting_url: string | null }>(
          'select e.id, e.title, e.location, r.name as room_name, e.meeting_url from events e left join rooms r on r.id = e.room_id where e.id = $1',
          [eventId]
        );
        if (!ev.rowCount) {
          await client.chat.postEphemeral({ channel: body.channel_id, user: body.user_id, text: 'Event not found.' });
          return;
        }

        const agg = await query<{
          id: string; start_at: string; end_at: string; yes: number; maybe: number; no: number;
        }>(
          `select eo.id, eo.start_at, eo.end_at,
                  count(*) filter (where v.choice = 'yes') as yes,
                  count(*) filter (where v.choice = 'maybe') as maybe,
                  count(*) filter (where v.choice = 'no') as no
           from event_options eo
           left join votes v on v.event_option_id = eo.id
           where eo.event_id = $1
           group by eo.id, eo.start_at, eo.end_at
           order by eo.start_at asc`,
          [eventId]
        );

        let blocks = buildVoteBlocksFromAgg(agg.rows);
        const reqs = await query<{ slack_user_id: string }>('select slack_user_id from event_required_users where event_id=$1', [eventId]);
        const mentions = reqs.rowCount ? reqs.rows.map(r => `<@${r.slack_user_id}>`).join(' ') : null;
        const placeRaw = ev.rows[0].room_name || ev.rows[0].location;
        const place = ev.rows[0].meeting_url ? (placeRaw ? `${placeRaw} | <${ev.rows[0].meeting_url}|meeting link>` : `<${ev.rows[0].meeting_url}|meeting link>`) : placeRaw;
        blocks = prependHeader(blocks, ev.rows[0].title, place, mentions);
        await client.chat.postEphemeral({ channel: body.channel_id, user: body.user_id, text: 'Status', blocks });
        return;
      } else if (text.toLowerCase().startsWith('close')) {
        const parts = text.split(/\s+/);
        const eventId = parts[1];
        if (!eventId) {
          await client.chat.postEphemeral({ channel: body.channel_id, user: body.user_id, text: '使い方: /mtg close <event_id>' });
          return;
        }

        // Permission: creator only (simple rule for MVP)
        const ev = await query<{ created_by: string; status: string }>('select created_by, status from events where id = $1', [eventId]);
        if (!ev.rowCount) {
          await client.chat.postEphemeral({ channel: body.channel_id, user: body.user_id, text: 'イベントが見つかりません。' });
          return;
        }
        if (ev.rows[0].status !== 'planning') {
          await client.chat.postEphemeral({ channel: body.channel_id, user: body.user_id, text: 'このイベントは既に確定またはキャンセル済みです。' });
          return;
        }
        if (ev.rows[0].created_by !== body.user_id) {
          await client.chat.postEphemeral({ channel: body.channel_id, user: body.user_id, text: '確定できるのは作成者のみです。' });
          return;
        }

        let result: any = null;
        try {
          result = await decideAndClose(eventId, 'manual');
          if (!result) {
            await client.chat.postEphemeral({ channel: body.channel_id, user: body.user_id, text: 'No options or decision failed.' });
            return;
          }
        } catch (e: any) {
          const msg = (e && e.message) ? e.message : '決定に失敗しました。後でもう一度お試しください。';
          await client.chat.postEphemeral({ channel: body.channel_id, user: body.user_id, text: msg });
          return;
        }
        await client.chat.postEphemeral({ channel: body.channel_id, user: body.user_id, text: `確定しました: ${formatTimeRange(result.start_at, result.end_at)}` });
        return;
      } else if (text.toLowerCase().startsWith('cancel')) {
        const parts = text.split(/\s+/);
        const eventId = parts[1];
        if (!eventId) {
          await client.chat.postEphemeral({ channel: body.channel_id, user: body.user_id, text: '使い方: /mtg cancel <event_id>' });
          return;
        }

        const ev = await query<{ created_by: string; status: string }>('select created_by, status from events where id = $1', [eventId]);
        if (!ev.rowCount) {
          await client.chat.postEphemeral({ channel: body.channel_id, user: body.user_id, text: 'イベントが見つかりません。' });
          return;
        }
        if (ev.rows[0].status === 'closed') {
          await client.chat.postEphemeral({ channel: body.channel_id, user: body.user_id, text: 'このイベントは既にキャンセル済みです。' });
          return;
        }
        if (ev.rows[0].created_by !== body.user_id) {
          await client.chat.postEphemeral({ channel: body.channel_id, user: body.user_id, text: 'キャンセルできるのは作成者のみです。' });
          return;
        }

        try {
          const info = await cancelEvent(eventId);
          const label = info?.start_at && info?.end_at ? ` (${formatTimeRange(info.start_at, info.end_at)})` : '';
          await client.chat.postEphemeral({ channel: body.channel_id, user: body.user_id, text: `Cancelled${label}` });
        } catch (e: any) {
          const msg = (e && e.message) ? e.message : 'キャンセルに失敗しました。後でもう一度お試しください。';
          await client.chat.postEphemeral({ channel: body.channel_id, user: body.user_id, text: msg });
        }
        return;
      }

      // Unknown subcommand
      await app.client.chat.postEphemeral({
        channel: body.channel_id,
        user: body.user_id,
        text: '使い方: /mtg new | /mtg status <event_id> | /mtg close <event_id> | /mtg cancel <event_id> | /mtg cal | /mtg help',
      });
    });

    // /room handler (now|today|week)
    app.command('/room', async ({ ack, body, client, command }) => {
      await ack();
      const arg = (command.text || '').trim().toLowerCase();
      const sub = arg === 'today' ? 'today' : arg === 'week' ? 'week' : arg === 'month' ? 'month' : 'now';

      try {
        if (sub === 'now') {
          const nowIso = new Date().toISOString();
          const rs = await query<{ id: string; name: string; capacity: number | null; busy: boolean; curr_end: string | null; next_start: string | null }>(
            `select r.id, r.name, r.capacity,
                    exists(
                      select 1 from bookings b
                       where b.room_id = r.id
                         and not ($1 <= b.start_at or $1 >= b.end_at)
                    ) as busy,
                    (
                      select b.end_at from bookings b
                       where b.room_id = r.id and not ($1 <= b.start_at or $1 >= b.end_at)
                       order by b.end_at asc limit 1
                    ) as curr_end,
                    (
                      select b.start_at from bookings b
                       where b.room_id = r.id and b.start_at > $1
                       order by b.start_at asc limit 1
                    ) as next_start
               from rooms r
              order by r.name asc`
            , [nowIso]
          );
          const blocks: any[] = [{ type: 'header', text: { type: 'plain_text', text: 'Room availability — now' } }];
          for (const r of rs.rows) {
            const status = r.busy
              ? `使用中（〜 ${r.curr_end ? formatTimeRange(r.curr_end, r.curr_end).split(' ')[2] : '?'}）`
              : `空き（次: ${r.next_start ? formatTimeRange(r.next_start, r.next_start).split(' ')[1] : '未定'}〜）`;
            const cap = r.capacity != null ? `cap ${r.capacity}` : 'cap ?';
            blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `• ${r.name} (${cap}) — ${status}` } });
          }
          await client.chat.postEphemeral({ channel: body.channel_id, user: body.user_id, text: 'Room availability — now', blocks });
          return;
        }

        const now = new Date();
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
        const startOfWeek = new Date(startOfDay);
        startOfWeek.setDate(startOfWeek.getDate() - ((startOfWeek.getDay() + 6) % 7)); // Monday start
        const endOfWeek = new Date(startOfWeek);
        endOfWeek.setDate(endOfWeek.getDate() + 7);
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);

        if (sub === 'today') {
          const range = [startOfDay.toISOString(), endOfDay.toISOString()];
          // Confirmed bookings in range
          const booked = await query<{ room_id: string; name: string; capacity: number | null; start_at: string; end_at: string }>(
            `select r.id as room_id, r.name, r.capacity, b.start_at, b.end_at
               from rooms r
               left join bookings b on b.room_id = r.id and not ($2 <= b.start_at or $1 >= b.end_at)
              order by r.name asc, b.start_at asc nulls last`,
            range
          );
          // Candidate options assigned to a room
          const candAssigned = await query<{ room_id: string; name: string; capacity: number | null; start_at: string; end_at: string }>(
            `select r.id as room_id, r.name, r.capacity, eo.start_at, eo.end_at
               from rooms r
               join events e on e.room_id = r.id and e.status='planning'
               join event_options eo on eo.event_id = e.id
              where not ($2 <= eo.start_at or $1 >= eo.end_at)
              order by r.name asc, eo.start_at asc`,
            range
          );
          // Unassigned candidates
          const candUnassigned = await query<{ start_at: string; end_at: string; title: string; id: string }>(
            `select eo.start_at, eo.end_at, e.title, e.id
               from events e
               join event_options eo on eo.event_id = e.id
              where e.status='planning' and e.room_id is null
                and not ($2 <= eo.start_at or $1 >= eo.end_at)
              order by eo.start_at asc`,
            range
          );

          type RoomInfo = { cap: number | null; booked: Array<{ s: string; e: string }>; cands: Array<{ s: string; e: string }>; };
          const byRoom = new Map<string, RoomInfo>();
          for (const r of booked.rows) {
            if (!byRoom.has(r.name)) byRoom.set(r.name, { cap: r.capacity, booked: [], cands: [] });
            if (r.start_at && r.end_at) byRoom.get(r.name)!.booked.push({ s: r.start_at, e: r.end_at });
          }
          for (const r of candAssigned.rows) {
            if (!byRoom.has(r.name)) byRoom.set(r.name, { cap: r.capacity, booked: [], cands: [] });
            byRoom.get(r.name)!.cands.push({ s: r.start_at, e: r.end_at });
          }

          const blocks: any[] = [{ type: 'header', text: { type: 'plain_text', text: 'Room schedule — today' } }];
          for (const [name, info] of byRoom.entries()) {
            const cap = info.cap != null ? `cap ${info.cap}` : 'cap ?';
            const bookedStr = info.booked.length
              ? info.booked.map(x => `${formatTimeRange(x.s, x.e).split(' ')[1]}-${formatTimeRange(x.s, x.e).split(' ')[3]}`).join(', ')
              : '（なし）';
            const candStr = info.cands.length
              ? info.cands.map(x => `${formatTimeRange(x.s, x.e).split(' ')[1]}-${formatTimeRange(x.s, x.e).split(' ')[3]}`).join(', ')
              : '（なし）';
            blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `• ${name} (${cap})\n  確定: ${bookedStr}\n  候補: ${candStr}` } });
          }
          if (candUnassigned.rowCount) {
            const list = candUnassigned.rows.map(x => `- ${x.title || ''} ${formatTimeRange(x.start_at, x.end_at)}`).join('\n');
            blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*未割当（候補）*\n${list}` } });
          }
          await client.chat.postEphemeral({ channel: body.channel_id, user: body.user_id, text: 'Room schedule — today', blocks });
          return;
        }

        if (sub === 'week') {
          const range = [startOfWeek.toISOString(), endOfWeek.toISOString()];
          const MAX = 3;
          const booked = await query<{ room_id: string; name: string; start_at: string; end_at: string }>(
            `select r.id as room_id, r.name, b.start_at, b.end_at
               from rooms r
               left join bookings b on b.room_id = r.id and not ($2 <= b.start_at or $1 >= b.end_at)
              order by r.name asc, b.start_at asc nulls last`,
            range
          );
          const cands = await query<{ room_id: string | null; name: string | null; start_at: string; end_at: string }>(
            `select e.room_id, r.name, eo.start_at, eo.end_at
               from events e
               left join rooms r on r.id = e.room_id
               join event_options eo on eo.event_id = e.id
              where e.status='planning' and not ($2 <= eo.start_at or $1 >= eo.end_at)
              order by r.name asc nulls last, eo.start_at asc`,
            range
          );
          const blocks: any[] = [];
          const roomDays = new Map<string, Map<string, { booked: Array<{ s: string; e: string }>; cand: Array<{ s: string; e: string }> }>>();
          const add = (room: string, type: 'booked' | 'cand', s: string, e: string) => {
            const day = new Date(s);
            const key = `${day.getFullYear()}-${String(day.getMonth()+1).padStart(2,'0')}-${String(day.getDate()).padStart(2,'0')}`;
            if (!roomDays.has(room)) roomDays.set(room, new Map());
            const days = roomDays.get(room)!;
            if (!days.has(key)) days.set(key, { booked: [], cand: [] });
            days.get(key)![type].push({ s, e });
          };
          for (const r of booked.rows) if (r.start_at && r.end_at && r.name) add(r.name, 'booked', r.start_at, r.end_at);
          for (const r of cands.rows) if (r.start_at && r.end_at) add(r.name || '未割当', 'cand', r.start_at, r.end_at);

          let totalBooked = 0, totalCand = 0;
          for (const [, days] of roomDays) {
            for (const [, v] of days) { totalBooked += v.booked.length; totalCand += v.cand.length; }
          }
          blocks.push({ type: 'header', text: { type: 'plain_text', text: `Room schedule — this week (確定 ${totalBooked} / 候補 ${totalCand})` } });

          for (const [room, days] of roomDays) {
            const lines: string[] = [];
            for (const [d, v] of days) {
              const b = v.booked.map(x => `${formatTimeRange(x.s, x.e).split(' ')[1]}-${formatTimeRange(x.s, x.e).split(' ')[3]}`);
              const c = v.cand.map(x => `${formatTimeRange(x.s, x.e).split(' ')[1]}-${formatTimeRange(x.s, x.e).split(' ')[3]}`);
              const showB = b.slice(0, MAX).join(', ') + (b.length > MAX ? ` + ${b.length-MAX} more` : '');
              const showC = c.slice(0, MAX).join(', ') + (c.length > MAX ? ` + ${c.length-MAX} more` : '');
              lines.push(`${d}  確定: ${b.length?showB:'（なし）'}  候補: ${c.length?showC:'（なし）'}`);
            }
            blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `• ${room}\n${lines.join('\n')}` } });
          }
          await client.chat.postEphemeral({ channel: body.channel_id, user: body.user_id, text: 'Room schedule — this week', blocks });
          return;
        }

        if (sub === 'month') {
          const range = [startOfMonth.toISOString(), endOfMonth.toISOString()];
          const MAX = 3;
          const booked = await query<{ room_id: string; name: string; start_at: string; end_at: string }>(
            `select r.id as room_id, r.name, b.start_at, b.end_at
               from rooms r
               left join bookings b on b.room_id = r.id and not ($2 <= b.start_at or $1 >= b.end_at)
              order by r.name asc, b.start_at asc nulls last`,
            range
          );
          const cands = await query<{ room_id: string | null; name: string | null; start_at: string; end_at: string }>(
            `select e.room_id, r.name, eo.start_at, eo.end_at
               from events e
               left join rooms r on r.id = e.room_id
               join event_options eo on eo.event_id = e.id
              where e.status='planning' and not ($2 <= eo.start_at or $1 >= eo.end_at)
              order by r.name asc nulls last, eo.start_at asc`,
            range
          );
          const blocks: any[] = [];
          const roomDays = new Map<string, Map<string, { booked: Array<{ s: string; e: string }>; cand: Array<{ s: string; e: string }> }>>();
          const add = (room: string, type: 'booked' | 'cand', s: string, e: string) => {
            const day = new Date(s);
            const key = `${day.getFullYear()}-${String(day.getMonth()+1).padStart(2,'0')}-${String(day.getDate()).padStart(2,'0')}`;
            if (!roomDays.has(room)) roomDays.set(room, new Map());
            const days = roomDays.get(room)!;
            if (!days.has(key)) days.set(key, { booked: [], cand: [] });
            days.get(key)![type].push({ s, e });
          };
          for (const r of booked.rows) if (r.start_at && r.end_at && r.name) add(r.name, 'booked', r.start_at, r.end_at);
          for (const r of cands.rows) if (r.start_at && r.end_at) add(r.name || '未割当', 'cand', r.start_at, r.end_at);

          let totalBooked = 0, totalCand = 0;
          for (const [, days] of roomDays) {
            for (const [, v] of days) { totalBooked += v.booked.length; totalCand += v.cand.length; }
          }
          blocks.push({ type: 'header', text: { type: 'plain_text', text: `Room schedule — this month (確定 ${totalBooked} / 候補 ${totalCand})` } });

          for (const [room, days] of roomDays) {
            const lines: string[] = [];
            for (const [d, v] of days) {
              const b = v.booked.map(x => `${formatTimeRange(x.s, x.e).split(' ')[1]}-${formatTimeRange(x.s, x.e).split(' ')[3]}`);
              const c = v.cand.map(x => `${formatTimeRange(x.s, x.e).split(' ')[1]}-${formatTimeRange(x.s, x.e).split(' ')[3]}`);
              const showB = b.slice(0, MAX).join(', ') + (b.length > MAX ? ` + ${b.length-MAX} more` : '');
              const showC = c.slice(0, MAX).join(', ') + (c.length > MAX ? ` + ${c.length-MAX} more` : '');
              lines.push(`${d}  確定: ${b.length?showB:'（なし）'}  候補: ${c.length?showC:'（なし）'}`);
            }
            blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `• ${room}\n${lines.join('\n')}` } });
          }
          await client.chat.postEphemeral({ channel: body.channel_id, user: body.user_id, text: 'Room schedule — this month', blocks });
          return;
        }
      } catch (e) {
        await client.chat.postEphemeral({ channel: body.channel_id, user: body.user_id, text: 'Failed to load room availability.' });
      }
    });

    // Modal submission: create event and options
    app.view('mtg_new_modal', async ({ ack, body, view, client }) => {
      const errors: Record<string, string> = {};
      const getVal = (b: string, a: string) => (view.state.values[b]?.[a] as any)?.value as string | undefined;
      const title = (getVal('title_b', 'title_a') || '').trim();
      const projectIdSel = (view.state.values['project_b']?.['project_a'] as any)?.selected_option?.value as string | undefined;
      const projectNameText = (getVal('project_text_b', 'project_text_a') || '').trim();
      const location = (getVal('location_b', 'location_a') || '').trim();
      const meetingUrl = (getVal('meeting_url_b', 'meeting_url_a') || '').trim();
      const requiredUsers = ((view.state.values['required_b']?.['required_a'] as any)?.selected_users as string[] | undefined) || [];
      const roomId = (view.state.values['room_b']?.['room_a'] as any)?.selected_option?.value as string | undefined;
      const deadlineDate = (view.state.values['deadline_date_b']?.['deadline_date_a'] as any)?.selected_date as string | undefined;
      const deadlineTime = (view.state.values['deadline_time_b']?.['deadline_time_a'] as any)?.selected_time as string | undefined;

      if (!title) errors['title_b'] = 'Required';
      if (!deadlineDate) errors['deadline_date_b'] = 'Required';
      if (!deadlineTime) errors['deadline_time_b'] = 'Required';

      let deadlineAt: Date | null = null;
      if (deadlineDate && deadlineTime) {
        const d = new Date(`${deadlineDate}T${deadlineTime}:00`);
        if (isNaN(d.getTime())) {
          errors['deadline_time_b'] = 'Invalid time';
        } else {
          deadlineAt = d;
        }
      }

      // Collect up to 8 options from date/time pickers (dynamic)
      const optionLines: string[] = [];
      const optIds = [1,2,3,4,5,6,7,8];
      for (const i of optIds) {
        const date = (view.state.values[`opt${i}_date_b`]?.[`opt${i}_date_a`] as any)?.selected_date as string | undefined;
        const start = (view.state.values[`opt${i}_start_b`]?.[`opt${i}_start_a`] as any)?.selected_time as string | undefined;
        const end = (view.state.values[`opt${i}_end_b`]?.[`opt${i}_end_a`] as any)?.selected_time as string | undefined;
        const anyFilled = !!(date || start || end);
        const allFilled = !!(date && start && end);
        if (anyFilled && !allFilled) {
          if (!date) errors[`opt${i}_date_b`] = 'Required';
          if (!start) errors[`opt${i}_start_b`] = 'Required';
          if (!end) errors[`opt${i}_end_b`] = 'Required';
        }
        if (allFilled) {
          optionLines.push(`${date} ${start} - ${end}`);
        }
      }
      if (optionLines.length === 0) {
        // Require at least one option
        errors['opt1_date_b'] = errors['opt1_date_b'] || 'Required';
        errors['opt1_start_b'] = errors['opt1_start_b'] || 'Required';
        errors['opt1_end_b'] = errors['opt1_end_b'] || 'Required';
      }

      // Require project (either selection or text)
      const hasProjectSelect = !!view.state.values['project_b'];
      const hasProjectText = !!view.state.values['project_text_b'];
      if (!projectIdSel && !projectNameText) {
        if (hasProjectSelect) errors['project_b'] = 'Required';
        if (hasProjectText) errors['project_text_b'] = 'Required';
      }

      // Require location (either room or free text)
      const hasRoom = !!view.state.values['room_b'];
      const hasLocationText = !!view.state.values['location_b'];
      if (!roomId && !location) {
        if (hasRoom) errors['room_b'] = 'Required';
        if (hasLocationText) errors['location_b'] = 'Required';
      }

      // Validate capacity and room usage (allow overlap if combined attendees <= capacity)
      if (roomId && optionLines.length > 0) {
        try {
          const rc = await query<{ capacity: number | null; name: string }>('select capacity, name from rooms where id=$1', [roomId]);
          const cap = rc.rowCount ? rc.rows[0].capacity : null;
          // Direct capacity check against required attendees only
          if (cap != null && requiredUsers.length > cap) {
            errors['room_b'] = `Capacity exceeded (cap ${cap}, required ${requiredUsers.length})`;
          }
          // For each option, sum overlapping bookings' attendees and ensure total <= capacity
          for (let idx = 0; idx < optionLines.length; idx++) {
            const line = optionLines[idx];
            const m = line.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})$/);
            if (!m) continue;
            const [_, date, s, e] = m;
            const startIso = new Date(`${date}T${s}:00`).toISOString();
            const endIso = new Date(`${date}T${e}:00`).toISOString();
            if (cap != null) {
              const existing = await query<{ attendees: number | null }>(
                `with overlapping as (
                   select b.event_id
                     from bookings b
                    where b.room_id = $1
                      and not ($3 <= b.start_at or $2 >= b.end_at)
                 ), per_event as (
                   select o.event_id,
                          count(al.slack_user_id) as al_count,
                          (select count(*) from event_required_users ru where ru.event_id = o.event_id) as ru_count
                     from overlapping o
                     left join attendance_logs al on al.event_id = o.event_id
                    group by o.event_id
                 )
                 select sum(case when al_count > 0 then al_count else ru_count end) as attendees
                   from per_event`,
                [roomId, startIso, endIso]
              );
              const others = existing.rows[0]?.attendees ?? 0;
              const total = others + requiredUsers.length;
              if (total > cap) {
                const key = `opt${idx + 1}_date_b` as const;
                errors[key] = `Capacity exceeded with overlapping booking(s) (cap ${cap}, existing ${others}, this ${requiredUsers.length})`;
              }
            } else {
              // If capacity is unknown, disallow overlapping usage conservatively
              const ov = await query<{ c: string }>(
                `select 'x' as c from bookings where room_id=$1 and not ($3 <= start_at or $2 >= end_at) limit 1`,
                [roomId, startIso, endIso]
              );
              if (ov.rowCount) {
                const key = `opt${idx + 1}_date_b` as const;
                errors[key] = 'Room already booked';
              }
            }
          }
        } catch {}
      }

      if (Object.keys(errors).length) {
        await ack({ response_action: 'errors', errors });
        return;
      }

      await ack();

      const metadata = JSON.parse(view.private_metadata || '{}');
      const channelId: string = metadata.channel_id;
      const userId = body.user?.id || 'unknown';

      // Insert DB rows and post message
      try {
        const projectId = projectIdSel || (projectNameText ? await ensureProject(projectNameText) : null);
        const eventId = await createEvent({
          projectId,
          title,
          location: location || null,
          meetingUrl: meetingUrl || null,
          roomId: roomId || null,
          deadlineAt: deadlineAt!,
          createdBy: userId,
        });

        const options = await createOptions(eventId, optionLines);

        let blocks = buildVoteBlocksFromAgg(
          options.map((o) => ({ id: o.id, start_at: o.start_at, end_at: o.end_at, yes: 0, maybe: 0, no: 0 }))
        );
        // Header with place and attendees
        let place: string | null = location || null;
        let meeting_url_for_header: string | null = meetingUrl || null;
        try {
          if (roomId) {
            const rr = await query<{ name: string }>('select name from rooms where id=$1', [roomId]);
            if (rr.rowCount) place = rr.rows[0].name;
          }
        } catch {}
        const placeForHeader = meeting_url_for_header
          ? (place ? `${place} | <${meeting_url_for_header}|meeting link>` : `<${meeting_url_for_header}|meeting link>`)
          : place;
        const mentions = requiredUsers.length ? requiredUsers.map((u) => `<@${u}>`).join(' ') : null;
        blocks = prependHeader(blocks, title, placeForHeader, mentions);
        const post = await client.chat.postMessage({
          channel: channelId,
          text: `New meeting: ${title}`,
          blocks,
        });

        // Store channel + ts for updates
        if (post.ok && post.ts) {
          await query('update events set slack_channel_id = $1, slack_message_ts = $2 where id = $3', [
            channelId,
            post.ts,
            eventId,
          ]);
        }

        // Save required attendees
        if (requiredUsers.length) {
          const values = requiredUsers.map((u) => `('${eventId}','${u.replace(/'/g, "''")}')`).join(',');
          await query(`insert into event_required_users(event_id, slack_user_id) values ${values} on conflict do nothing`);
        }

        // Notify creator with event_id and required attendees
        const mentionsText = requiredUsers.map((u) => `<@${u}>`).join(' ');
        await client.chat.postEphemeral({ channel: channelId, user: userId, text: `Created event: ${eventId}${mentionsText ? `\nRequired: ${mentionsText}` : ''}` });
      } catch (err) {
        console.error('[mtg_new] failed', err);
        // Best-effort user notice
        try {
          await client.chat.postEphemeral({ channel: channelId, user: userId, text: 'Creation failed. Please try again.' });
        } catch {}
      }
    });

    // Voting handlers
    const voteHandler = async (choice: 'yes' | 'maybe' | 'no', body: any) => {
      const action = body.actions[0] as any;
      const optionId = action.value; // event_option_id
      const userId = body.user.id;

      await withClient(async (c) => {
        await c.query(
          `insert into votes (event_option_id, slack_user_id, choice)
           values ($1, $2, $3)
           on conflict (event_option_id, slack_user_id)
           do update set choice = excluded.choice, voted_at = now()`,
          [optionId, userId, choice]
        );

        // Aggregate counts per option for the parent event
        const { rows } = await c.query<{ event_id: string; title: string; location: string | null; room_name: string | null; meeting_url: string | null; slack_channel_id: string | null; slack_message_ts: string | null }>(
          `select e.id as event_id, e.title, e.location, r.name as room_name, e.meeting_url, e.slack_channel_id, e.slack_message_ts
           from event_options eo
           join events e on e.id = eo.event_id
           left join rooms r on r.id = e.room_id
           where eo.id = $1`,
          [optionId]
        );
        if (rows.length === 0) return;
        const { event_id, title, location, room_name, meeting_url, slack_channel_id, slack_message_ts } = rows[0];
        if (!slack_channel_id || !slack_message_ts) return;

        const agg = await c.query<{
          id: string;
          start_at: string;
          end_at: string;
          yes: number;
          maybe: number;
          no: number;
        }>(
          `select eo.id, eo.start_at, eo.end_at,
                  count(*) filter (where v.choice = 'yes') as yes,
                  count(*) filter (where v.choice = 'maybe') as maybe,
                  count(*) filter (where v.choice = 'no') as no
           from event_options eo
           left join votes v on v.event_option_id = eo.id
           where eo.event_id = $1
           group by eo.id, eo.start_at, eo.end_at
           order by eo.start_at asc`,
          [event_id]
        );

        let blocks = buildVoteBlocksFromAgg(agg.rows);
        const rq = await c.query<{ slack_user_id: string }>('select slack_user_id from event_required_users where event_id=$1', [event_id]);
        const mentions = rq.rowCount ? rq.rows.map(r => `<@${r.slack_user_id}>`).join(' ') : null;
        const placeRaw = room_name || location;
        const place = meeting_url ? (placeRaw ? `${placeRaw} | <${meeting_url}|meeting link>` : `<${meeting_url}|meeting link>`) : placeRaw;
        blocks = prependHeader(blocks, title, place, mentions);
        await app.client.chat.update({ channel: slack_channel_id, ts: slack_message_ts, text: 'Updated', blocks });
      });
    };

    app.action('vote_yes', async ({ ack, body }) => { await ack(); await voteHandler('yes', body as any); });
    app.action('vote_maybe', async ({ ack, body }) => { await ack(); await voteHandler('maybe', body as any); });
    app.action('vote_no', async ({ ack, body }) => { await ack(); await voteHandler('no', body as any); });

    // Add candidate option dynamically (up to 8)
    app.action('opt_add', async ({ ack, body, client }) => {
      await ack();
      try {
        const view: any = (body as any).view;
        const meta = (() => { try { return JSON.parse(view.private_metadata || '{}'); } catch { return {}; }})();
        const current = Number(meta.options_count || 4);
        const next = Math.min(8, current + 1);

        // Rebuild room/project options
        let roomOptions: any[] = [];
        try {
          const r = await query<{ id: string; name: string; capacity: number | null }>('select id, name, capacity from rooms order by name asc');
          roomOptions = r.rows.map((row) => ({ text: { type: 'plain_text', text: row.capacity ? `${row.name} (cap ${row.capacity})` : row.name }, value: row.id }));
        } catch {}
        let projectOptions: any[] = [];
        try {
          const p = await query<{ id: string; name: string }>('select id, name from projects order by name asc');
          projectOptions = p.rows.map((row) => ({ text: { type: 'plain_text', text: row.name }, value: row.id }));
        } catch {}

        const blocks: any[] = [];
        blocks.push({ type: 'input', block_id: 'title_b', label: { type: 'plain_text', text: 'Title' }, element: { type: 'plain_text_input', action_id: 'title_a' } });
        blocks.push({ type: 'input', block_id: 'required_b', label: { type: 'plain_text', text: 'Required attendees' }, element: { type: 'multi_users_select', action_id: 'required_a', placeholder: { type: 'plain_text', text: 'Select users' } }, optional: true });
        if (projectOptions.length > 0) {
          blocks.push({ type: 'input', block_id: 'project_b', label: { type: 'plain_text', text: 'Project' }, element: { type: 'static_select', action_id: 'project_a', options: projectOptions, placeholder: { type: 'plain_text', text: 'Select a project' } } });
        } else {
          blocks.push({ type: 'input', block_id: 'project_text_b', label: { type: 'plain_text', text: 'Project name' }, element: { type: 'plain_text_input', action_id: 'project_text_a', placeholder: { type: 'plain_text', text: 'e.g., Core' } } });
        }
        if (roomOptions.length > 0) {
          blocks.push({ type: 'input', block_id: 'room_b', label: { type: 'plain_text', text: 'Location (room)' }, element: { type: 'static_select', action_id: 'room_a', options: roomOptions, placeholder: { type: 'plain_text', text: 'Select a room' } } });
        } else {
          blocks.push({ type: 'input', block_id: 'location_b', label: { type: 'plain_text', text: 'Location (free text)' }, element: { type: 'plain_text_input', action_id: 'location_a' } });
        }
        blocks.push({ type: 'input', block_id: 'meeting_url_b', label: { type: 'plain_text', text: 'Online meeting URL (optional)' }, element: { type: 'plain_text_input', action_id: 'meeting_url_a', placeholder: { type: 'plain_text', text: 'https://...' } }, optional: true });
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*Deadline*' } });
        blocks.push({ type: 'input', block_id: 'deadline_date_b', label: { type: 'plain_text', text: 'Date' }, element: { type: 'datepicker', action_id: 'deadline_date_a' } });
        blocks.push({ type: 'input', block_id: 'deadline_time_b', label: { type: 'plain_text', text: 'Time' }, element: { type: 'timepicker', action_id: 'deadline_time_a', placeholder: { type: 'plain_text', text: 'HH:mm' } } });
        blocks.push({ type: 'divider' });
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*Options (up to 8)*' } });
        for (let i = 1; i <= next; i++) {
          blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `Option ${i}` } });
          blocks.push({ type: 'input', block_id: `opt${i}_date_b`, label: { type: 'plain_text', text: 'Date' }, element: { type: 'datepicker', action_id: `opt${i}_date_a` }, optional: true });
          blocks.push({ type: 'input', block_id: `opt${i}_start_b`, label: { type: 'plain_text', text: 'Start' }, element: { type: 'timepicker', action_id: `opt${i}_start_a` }, optional: true });
          blocks.push({ type: 'input', block_id: `opt${i}_end_b`, label: { type: 'plain_text', text: 'End' }, element: { type: 'timepicker', action_id: `opt${i}_end_a` }, optional: true });
        }
        blocks.push({ type: 'actions', block_id: 'opt_actions_b', elements: [
          next >= 8 ? { type: 'button', action_id: 'opt_add', text: { type: 'plain_text', text: '上限(8)に達しました' }, value: 'add', disabled: true } as any
                    : { type: 'button', action_id: 'opt_add', text: { type: 'plain_text', text: '候補を追加' }, value: 'add' }
        ] });

        await client.views.update({
          view_id: view.id,
          hash: view.hash,
          view: {
            type: 'modal',
            callback_id: 'mtg_new_modal',
            private_metadata: JSON.stringify({ ...(meta || {}), options_count: next }),
            title: { type: 'plain_text', text: 'New Meeting' },
            submit: { type: 'plain_text', text: 'Create' },
            close: { type: 'plain_text', text: 'Cancel' },
            blocks,
          },
        });
      } catch (e) {
        // ignore
      }
    });
    // Auto-closing cron (every 10 minutes)
    try {
      cron.schedule('*/10 * * * *', async () => {
        try {
          const due = await query<{ id: string }>(
            `select id from events where status='planning' and deadline_at <= now() order by deadline_at asc limit 10`
          );
          for (const row of due.rows) {
            await decideAndClose(row.id, 'auto');
          }
          // Vote reminders: events reaching reminder window
          const voteDue = await query<{ id: string }>(
            `select id from events
              where status='planning'
                and now() >= (deadline_at - make_interval(mins => coalesce(remind_vote_before_minutes, 24*60)))
            `
          );
          for (const ev of voteDue.rows) {
            // Load event meta for context in DM
            let meta: { title: string; deadline_at: string; slack_channel_id: string | null; slack_message_ts: string | null } | null = null;
            try {
              const m = await query<{ title: string; deadline_at: string; slack_channel_id: string | null; slack_message_ts: string | null }>(
                `select title, deadline_at, slack_channel_id, slack_message_ts from events where id=$1`,
                [ev.id]
              );
              meta = m.rowCount ? m.rows[0] : null;
            } catch {}
            // users required but not yet voted
            const users = await query<{ slack_user_id: string }>(`select slack_user_id from event_required_users where event_id=$1`, [ev.id]);
            for (const u of users.rows) {
              const voted = await query(
                `select 1 from votes v join event_options eo on eo.id=v.event_option_id where eo.event_id=$1 and v.slack_user_id=$2 limit 1`,
                [ev.id, u.slack_user_id]
              );
              if (voted.rowCount) continue;
              // Acquire send-token first to avoid duplicate DMs across instances
              const token = await query<{ id: string }>(
                `insert into reminders_sent(event_id, user_id, type)
                 values ($1,$2,'vote')
                 on conflict do nothing
                 returning id`,
                [ev.id, u.slack_user_id]
              );
              if (!token.rowCount) continue; // another instance already handled it
              try {
                const open = await (global as any)._boltClient?.conversations.open({ users: u.slack_user_id });
                const dm = open?.channel?.id;
                if (dm) {
                  // Build context with title, deadline and permalink (if available)
                  let link: string | null = null;
                  if (meta?.slack_channel_id && meta?.slack_message_ts) {
                    try {
                      const perm = await (global as any)._boltClient?.chat.getPermalink({
                        channel: meta.slack_channel_id,
                        message_ts: meta.slack_message_ts,
                      });
                      link = (perm as any)?.permalink || null;
                    } catch {}
                  }
                  const title = meta?.title ? `「${meta.title}」` : 'このミーティング';
                  const deadline = meta?.deadline_at ? `締切: ${formatDateTime(meta.deadline_at)}` : '';
                  const suffix = link ? `\n投票はこちら: ${link}` : '';
                  const msg = `[投票リマインド] ${title} の投票がまだです。${deadline}${suffix}`.trim();
                  await (global as any)._boltClient?.chat.postMessage({ channel: dm, text: msg });
                }
              } catch (e) {
                console.warn('[remind] vote DM failed', e);
              }
            }
          }

          // Join reminders: fixed events approaching start
          const joinDue = await query<{ id: string; start_at: string; end_at: string }>(
            `select e.id, b.start_at, b.end_at
               from events e
               join bookings b on b.event_id=e.id
              where e.status='fixed' and now() >= (b.start_at - make_interval(mins => coalesce(e.remind_join_before_minutes, 60)))`
          );
          for (const ev of joinDue.rows) {
            // Load event meta for context in DM
            let meta: { title: string | null; meeting_url: string | null; slack_channel_id: string | null; slack_message_ts: string | null } | null = null;
            try {
              const m = await query<{ title: string | null; meeting_url: string | null; slack_channel_id: string | null; slack_message_ts: string | null }>(
                `select title, meeting_url, slack_channel_id, slack_message_ts from events where id=$1`,
                [ev.id]
              );
              meta = m.rowCount ? m.rows[0] : null;
            } catch {}
            const atts = await query<{ slack_user_id: string }>(`select slack_user_id from attendance_logs where event_id=$1`, [ev.id]);
            for (const a of atts.rows) {
              // Acquire send-token first to avoid duplicate DMs across instances
              const token = await query<{ id: string }>(
                `insert into reminders_sent(event_id, user_id, type)
                 values ($1,$2,'join')
                 on conflict do nothing
                 returning id`,
                [ev.id, a.slack_user_id]
              );
              if (!token.rowCount) continue; // already handled elsewhere
              try {
                const open = await (global as any)._boltClient?.conversations.open({ users: a.slack_user_id });
                const dm = open?.channel?.id;
                if (dm) {
                  // Build message with title, time range and optional links
                  let permalink: string | null = null;
                  if (meta?.slack_channel_id && meta?.slack_message_ts) {
                    try {
                      const perm = await (global as any)._boltClient?.chat.getPermalink({
                        channel: meta.slack_channel_id,
                        message_ts: meta.slack_message_ts,
                      });
                      permalink = (perm as any)?.permalink || null;
                    } catch {}
                  }
                  const title = meta?.title ? `「${meta.title}」` : 'このミーティング';
                  const when = formatTimeRange(ev.start_at, ev.end_at);
                  const linkLine = meta?.meeting_url ? `\n参加リンク: ${meta.meeting_url}` : '';
                  const permLine = permalink ? `\n詳細: ${permalink}` : '';
                  const text = `[開始前リマインド] ${title} ${when} まもなくミーティング開始です。${linkLine}${permLine}`.trim();
                  await (global as any)._boltClient?.chat.postMessage({ channel: dm, text });
                }
              } catch (e) {
                console.warn('[remind] join DM failed', e);
              }
            }
          }
        } catch (e) {
          console.error('[cron] auto-close failed', e);
        }
      });
      console.log('[cron] auto-close scheduled every 10 minutes');
    } catch (e) {
      console.warn('[cron] scheduling failed', e);
    }

    try {
      await app.start(); // Socket Mode: no HTTP port needed
      console.log('⚡️ Slack Bolt (Socket Mode) started');
    } catch (err) {
      console.error('[slack] failed to start', err);
    }
  })();
}

// Helpers
async function ensureProject(name?: string | null): Promise<string | null> {
  if (!name) return null;
  const ex = await query<{ id: string }>('select id from projects where lower(name)=lower($1) limit 1', [name]);
  if (ex.rowCount && ex.rows[0]) return ex.rows[0].id;
  const ins = await query<{ id: string }>('insert into projects(name) values($1) returning id', [name]);
  return ins.rows[0].id;
}

async function createEvent(args: {
  projectId: string | null;
  title: string;
  location: string | null;
  meetingUrl: string | null;
  roomId: string | null;
  deadlineAt: Date;
  createdBy: string;
}): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `insert into events(project_id, title, location, meeting_url, room_id, status, deadline_at, created_by)
     values ($1,$2,$3,$4,$5,'planning',$6,$7)
     returning id`,
    [args.projectId, args.title, args.location, args.meetingUrl, args.roomId, args.deadlineAt.toISOString(), args.createdBy]
  );
  return rows[0].id;
}

async function createOptions(eventId: string, lines: string[]): Promise<Array<{ id: string; start_at: string; end_at: string }>> {
  const out: Array<{ id: string; start_at: string; end_at: string }> = [];
  for (const line of lines) {
    // expect: YYYY-MM-DD HH:mm - HH:mm
    const m = line.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})$/);
    if (!m) continue;
    const [_, date, start, end] = m;
    const startAt = new Date(`${date}T${start}:00`);
    const endAt = new Date(`${date}T${end}:00`);
    const { rows } = await query<{ id: string; start_at: string; end_at: string }>(
      `insert into event_options(event_id, start_at, end_at)
       values ($1,$2,$3)
       on conflict (event_id, start_at, end_at) do update set start_at = excluded.start_at
       returning id, start_at, end_at`,
      [eventId, startAt.toISOString(), endAt.toISOString()]
    );
    out.push(rows[0]);
  }
  return out;
}

function formatTimeRange(startISO: string, endISO: string): string {
  const s = new Date(startISO);
  const e = new Date(endISO);
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${s.getFullYear()}-${pad(s.getMonth() + 1)}-${pad(s.getDate())}`;
  const sh = `${pad(s.getHours())}:${pad(s.getMinutes())}`;
  const eh = `${pad(e.getHours())}:${pad(e.getMinutes())}`;
  return `${date} ${sh} - ${eh}`;
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Header wrapper for blocks
function prependHeader(
  blocks: any[],
  title?: string,
  place?: string | null,
  attendeesMentions?: string | null
) {
  const arr: any[] = [];
  if (title) arr.push({ type: 'header', text: { type: 'plain_text', text: title } });
  if (place) arr.push({ type: 'section', text: { type: 'mrkdwn', text: `*場所*: ${place}` } });
  if (attendeesMentions) arr.push({ type: 'section', text: { type: 'mrkdwn', text: `*参加予定者*: ${attendeesMentions}` } });
  return [...arr, ...blocks];
}

function buildVoteBlocksFromAgg(rows: Array<{ id: string; start_at: string; end_at: string; yes: number; maybe: number; no: number }>) {
  const blocks: any[] = [];
  for (const r of rows) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: formatTimeRange(r.start_at, r.end_at) } });
    blocks.push({
      type: 'actions',
      elements: [
        { type: 'button', action_id: 'vote_yes', text: { type: 'plain_text', text: '参加' }, style: 'primary', value: r.id },
        { type: 'button', action_id: 'vote_maybe', text: { type: 'plain_text', text: '未定' }, value: r.id },
        { type: 'button', action_id: 'vote_no', text: { type: 'plain_text', text: '不可' }, style: 'danger', value: r.id },
      ],
    });
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `yes ${r.yes} | maybe ${r.maybe} | no ${r.no}` }] });
    blocks.push({ type: 'divider' });
  }
  if (blocks.length === 0) {
    blocks.push({ type: 'section', text: { type: 'plain_text', text: 'No options.' } });
  }
  return blocks;
}

// Auto decision + close
async function decideAndClose(eventId: string, source: 'auto' | 'manual') {
  // Pick best option: yes desc, maybe asc, start_at asc
  const agg = await query<{
    id: string; start_at: string; end_at: string; yes: number; maybe: number;
  }>(
    `select eo.id, eo.start_at, eo.end_at,
            count(*) filter (where v.choice='yes') as yes,
            count(*) filter (where v.choice='maybe') as maybe
     from event_options eo
     left join votes v on v.event_option_id = eo.id
     where eo.event_id = $1
     group by eo.id, eo.start_at, eo.end_at
     order by yes desc, maybe asc, start_at asc
     limit 1`,
    [eventId]
  );

  if (!agg.rowCount) return null;
  const best = agg.rows[0];

  // Capacity re-check before fixing/booking
  try {
    const roomRow = await query<{ room_id: string | null; capacity: number | null }>(
      `select e.room_id, r.capacity
         from events e
         left join rooms r on r.id = e.room_id
        where e.id = $1`,
      [eventId]
    );
    const roomId = roomRow.rowCount ? roomRow.rows[0].room_id : null;
    const cap = roomRow.rowCount ? roomRow.rows[0].capacity : null;
    if (roomId) {
      // Count YES votes for the chosen option (this meeting attendees)
      const yesRes = await query<{ c: number }>(
        `select count(*)::int as c from votes where event_option_id=$1 and choice='yes'`,
        [best.id]
      );
      const thisYes = yesRes.rowCount ? (yesRes.rows[0].c as unknown as number) : 0;

      if (cap != null) {
        // Sum attendees from overlapping bookings (prefer attendance_logs; fallback to required users)
        const existing = await query<{ attendees: number | null }>(
          `with overlapping as (
             select b.event_id
               from bookings b
              where b.room_id = $1
                and not ($3 <= b.start_at or $2 >= b.end_at)
                and b.event_id <> $4
           ), per_event as (
             select o.event_id,
                    count(al.slack_user_id) as al_count,
                    (select count(*) from event_required_users ru where ru.event_id = o.event_id) as ru_count
               from overlapping o
               left join attendance_logs al on al.event_id = o.event_id
              group by o.event_id
           )
           select sum(case when al_count > 0 then al_count else ru_count end) as attendees
             from per_event`,
          [roomId, best.start_at, best.end_at, eventId]
        );
        const others = existing.rows[0]?.attendees ?? 0;
        const total = Number(others) + Number(thisYes);
        if (total > cap) {
          const msg = `定員超過のため確定できません: 既存 ${others} 人 + 今回 ${thisYes} 人 > 定員 ${cap}`;
          if (source === 'manual') throw new Error(msg);
          return null; // auto: skip silently
        }
      } else {
        // Unknown capacity: disallow any overlapping usage conservatively
        const ov = await query<{ x: string }>(
          `select 'x' as x from bookings where room_id=$1 and not ($3 <= start_at or $2 >= end_at) limit 1`,
          [roomId, best.start_at, best.end_at]
        );
        if (ov.rowCount) {
          const msg = 'この部屋の定員が未設定で、重複予約があるため確定できません。';
          if (source === 'manual') throw new Error(msg);
          return null;
        }
      }
    }
  } catch (e) {
    // If re-check fails, fail safe; surface message for manual close
    if (source === 'manual') throw e;
    return null;
  }

  // Update status → fixed
  const ev = await query<{ slack_channel_id: string | null; slack_message_ts: string | null; title: string; location: string | null }>(
    `update events set status='fixed'
     where id = $1 and status='planning'
     returning slack_channel_id, slack_message_ts, title, location`,
    [eventId]
  );
  if (!ev.rowCount) return null; // already closed

  // Snapshot attendance: yes votes for chosen option
  await query(
    `insert into attendance_logs(event_id, slack_user_id, decided_option_id, start_at, end_at)
     select $1, v.slack_user_id, $2, eo.start_at, eo.end_at
       from votes v
       join event_options eo on eo.id = v.event_option_id
       join user_profiles up on up.slack_user_id = v.slack_user_id
      where v.choice = 'yes' and eo.id = $2
     on conflict (event_id, slack_user_id) do nothing`,
    [eventId, best.id]
  );

  // Booking with selected room (if any)
  const evRoom = await query<{ room_id: string | null }>(`select room_id from events where id = $1`, [eventId]);
  const roomId = evRoom.rowCount ? evRoom.rows[0].room_id : null;
  await query(
    `insert into bookings(event_id, room_id, start_at, end_at)
     values ($1, $4, $2, $3)
     on conflict do nothing`,
    [eventId, best.start_at, best.end_at, roomId]
  );

  // Notify thread
  const ch = ev.rows[0].slack_channel_id;
  const ts = ev.rows[0].slack_message_ts;
  if (ch && ts) {
    try {
      // Compose mentions for required attendees
      const req = await query<{ slack_user_id: string }>(`select slack_user_id from event_required_users where event_id=$1`, [eventId]);
      const mentions = req.rows.map((r) => `<@${r.slack_user_id}>`).join(' ');
      const msg = `${source === 'auto' ? '自動確定' : '手動確定'}: ${formatTimeRange(best.start_at, best.end_at)}${mentions ? `\n${mentions}` : ''}`;
      await (global as any)._boltClient?.chat.postMessage({ channel: ch, thread_ts: ts, text: msg });
    } catch {
      // ignore
    }
  }

  // Google Calendar registration（OAuthのみ）
  if (oauthEnabled()) {
    try {
      await registerFixedEventToGCalOAuth(eventId);
    } catch (e) {
      console.error('[gcal-oauth] post-close register failed', e);
    }
  }

  return best;
}

// Cancel event (planning or fixed)
async function cancelEvent(eventId: string): Promise<{ start_at?: string; end_at?: string } | null> {
  // Fetch event context
  const ev = await query<{ slack_channel_id: string | null; slack_message_ts: string | null; status: string; title: string | null }>(
    `select slack_channel_id, slack_message_ts, status, title from events where id=$1`,
    [eventId]
  );
  if (!ev.rowCount) return null;

  // If registered to Google Calendar, delete (best-effort)
  try {
    if (oauthEnabled()) await cancelFixedEventFromGCalOAuth(eventId);
  } catch (e) {
    console.warn('[gcal-oauth] cancel best-effort failed', e);
  }

  // Delete booking (if existed)
  const del = await query<{ start_at: string; end_at: string }>(
    `delete from bookings where event_id=$1 returning start_at, end_at`,
    [eventId]
  );

  // Update status to closed
  await query(`update events set status='closed' where id=$1`, [eventId]);

  // Notify thread if available
  const ch = ev.rows[0].slack_channel_id;
  const ts = ev.rows[0].slack_message_ts;
  if (ch && ts) {
    try {
      const req = await query<{ slack_user_id: string }>(`select slack_user_id from event_required_users where event_id=$1`, [eventId]);
      const mentions = req.rowCount ? req.rows.map((r) => `<@${r.slack_user_id}>`).join(' ') : '';
      const timeLabel = del.rowCount ? `: ${formatTimeRange(del.rows[0].start_at, del.rows[0].end_at)}` : '';
      const msg = `キャンセルしました${timeLabel}${mentions ? `\n${mentions}` : ''}`;
      await (global as any)._boltClient?.chat.postMessage({ channel: ch, thread_ts: ts, text: msg });
    } catch {
      // ignore
    }
  }

  return del.rowCount ? { start_at: del.rows[0].start_at, end_at: del.rows[0].end_at } : null;
}
