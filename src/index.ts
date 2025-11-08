import express from 'express';
import { App, LogLevel, BlockAction, ButtonAction } from '@slack/bolt';
import cron from 'node-cron';
import dotenv from 'dotenv';
import { migrateIfPossible } from './migrate';
import { query, withClient } from './db';
import { getAuthUrl, exchangeCodeAndStore, oauthEnabled, registerFixedEventToGCalOAuth } from './gcal_oauth';
import { buildICS } from './ics';

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
      uid: string; title: string; location: string | null; start_at: string; end_at: string; updated_at: string;
    }>(
      `select b.id as uid, e.title, e.location, b.start_at, b.end_at, coalesce(e.created_at, now()) as updated_at
         from bookings b
         join events e on e.id = b.event_id
        where e.status = 'fixed'
        order by b.start_at asc`
    );
    const events = r.rows.map(row => ({
      uid: row.uid,
      title: row.title,
      location: row.location,
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
      await respond({
        response_type: 'ephemeral',
        text: 'Meeting Tools is alive. Commands coming soon. \n- /mtg new (WIP)\n- /room now (WIP)'
      });
    });

    // /mtg handler (new|status|close|cal)
    app.command('/mtg', async ({ ack, body, client, command }) => {
      await ack();
      const text = (command.text || '').trim();

      if (!text || text.toLowerCase().startsWith('new')) {
        // Open modal for new meeting
        await client.views.open({
          trigger_id: body.trigger_id,
          view: {
            type: 'modal',
            callback_id: 'mtg_new_modal',
            private_metadata: JSON.stringify({ channel_id: body.channel_id }),
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
                optional: true,
                block_id: 'project_b',
                label: { type: 'plain_text', text: 'Project (optional)' },
                element: { type: 'plain_text_input', action_id: 'project_a', placeholder: { type: 'plain_text', text: 'e.g., Core' } },
              },
              {
                type: 'input',
                optional: true,
                block_id: 'location_b',
                label: { type: 'plain_text', text: 'Location (optional)' },
                element: { type: 'plain_text_input', action_id: 'location_a' },
              },
              {
                type: 'input',
                block_id: 'deadline_b',
                label: { type: 'plain_text', text: 'Deadline (YYYY-MM-DD HH:mm)' },
                element: { type: 'plain_text_input', action_id: 'deadline_a', placeholder: { type: 'plain_text', text: '2025-01-20 18:00' } },
              },
              {
                type: 'input',
                block_id: 'options_b',
                label: { type: 'plain_text', text: 'Options (one per line: YYYY-MM-DD HH:mm - HH:mm)' },
                element: { type: 'plain_text_input', action_id: 'options_a', multiline: true, placeholder: { type: 'plain_text', text: '2025-01-22 10:00 - 11:00\n2025-01-23 15:00 - 16:00' } },
              },
            ],
          },
        });
        return;
      } else if (text.toLowerCase().startsWith('cal') || text.toLowerCase() === 'calendar') {
        const base = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
        const url = `${base.replace(/\/$/, '')}/ics/shared.ics`;
        let msg = `購読リンク: ${url}\nGoogle/Apple/Outlook 等で購読できます。`;
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
          await client.chat.postEphemeral({ channel: body.channel_id, user: body.user_id, text: 'Usage: /mtg status <event_id>' });
          return;
        }

        const ev = await query<{ id: string; title: string; location: string | null }>(
          'select id, title, location from events where id = $1',
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
        blocks = prependHeader(blocks, ev.rows[0].title, ev.rows[0].location);
        await client.chat.postEphemeral({ channel: body.channel_id, user: body.user_id, text: 'Status', blocks });
        return;
      } else if (text.toLowerCase().startsWith('close')) {
        const parts = text.split(/\s+/);
        const eventId = parts[1];
        if (!eventId) {
          await client.chat.postEphemeral({ channel: body.channel_id, user: body.user_id, text: 'Usage: /mtg close <event_id>' });
          return;
        }

        // Permission: creator only (simple rule for MVP)
        const ev = await query<{ created_by: string; status: string }>('select created_by, status from events where id = $1', [eventId]);
        if (!ev.rowCount) {
          await client.chat.postEphemeral({ channel: body.channel_id, user: body.user_id, text: 'Event not found.' });
          return;
        }
        if (ev.rows[0].status !== 'planning') {
          await client.chat.postEphemeral({ channel: body.channel_id, user: body.user_id, text: 'Event already closed/fixed.' });
          return;
        }
        if (ev.rows[0].created_by !== body.user_id) {
          await client.chat.postEphemeral({ channel: body.channel_id, user: body.user_id, text: 'Only the creator can close this event.' });
          return;
        }

        const result = await decideAndClose(eventId, 'manual');
        if (!result) {
          await client.chat.postEphemeral({ channel: body.channel_id, user: body.user_id, text: 'No options or decision failed.' });
          return;
        }
        await client.chat.postEphemeral({ channel: body.channel_id, user: body.user_id, text: `Closed: ${formatTimeRange(result.start_at, result.end_at)}` });
        return;
      }

      // Unknown subcommand
      await app.client.chat.postEphemeral({
        channel: body.channel_id,
        user: body.user_id,
        text: 'Usage: /mtg new | /mtg status <event_id> | /mtg close <event_id> | /mtg cal',
      });
    });

    // Modal submission: create event and options
    app.view('mtg_new_modal', async ({ ack, body, view, client }) => {
      const errors: Record<string, string> = {};
      const getVal = (b: string, a: string) => (view.state.values[b]?.[a] as any)?.value as string | undefined;
      const title = (getVal('title_b', 'title_a') || '').trim();
      const projectName = (getVal('project_b', 'project_a') || '').trim();
      const location = (getVal('location_b', 'location_a') || '').trim();
      const deadlineStr = (getVal('deadline_b', 'deadline_a') || '').trim();
      const optionsText = (getVal('options_b', 'options_a') || '').trim();

      if (!title) errors['title_b'] = 'Required';
      if (!deadlineStr) errors['deadline_b'] = 'Required';
      if (!optionsText) errors['options_b'] = 'Required';

      let deadlineAt: Date | null = null;
      if (deadlineStr) {
        const d = new Date(deadlineStr.replace(' ', 'T'));
        if (isNaN(d.getTime())) errors['deadline_b'] = 'Invalid datetime';
        else deadlineAt = d;
      }

      const optionLines = optionsText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      if (optionLines.length > 8) {
        errors['options_b'] = 'Up to 8 options';
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
        const projectId = await ensureProject(projectName);
        const eventId = await createEvent({
          projectId,
          title,
          location: location || null,
          deadlineAt: deadlineAt!,
          createdBy: userId,
        });

        const options = await createOptions(eventId, optionLines);

        let blocks = buildVoteBlocksFromAgg(
          options.map((o) => ({ id: o.id, start_at: o.start_at, end_at: o.end_at, yes: 0, maybe: 0, no: 0 }))
        );
        blocks = prependHeader(blocks, title, location);
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

        // Notify creator with event_id for manual operations
        await client.chat.postEphemeral({ channel: channelId, user: userId, text: `Created event: ${eventId}` });
      } catch (err) {
        console.error('[mtg_new] failed', err);
        // Best-effort user notice
        try {
          await client.chat.postEphemeral({ channel: channelId, user: userId, text: 'Creation failed. Please try again.' });
        } catch {}
      }
    });

    // Voting handlers
    const voteHandler = async (choice: 'yes' | 'maybe' | 'no', body: BlockAction<ButtonAction>) => {
      const action = body.actions[0] as ButtonAction;
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
        const { rows } = await c.query<{ event_id: string; title: string; location: string | null; slack_channel_id: string | null; slack_message_ts: string | null }>(
          `select e.id as event_id, e.title, e.location, e.slack_channel_id, e.slack_message_ts
           from event_options eo
           join events e on e.id = eo.event_id
           where eo.id = $1`,
          [optionId]
        );
        if (rows.length === 0) return;
        const { event_id, title, location, slack_channel_id, slack_message_ts } = rows[0];
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
        blocks = prependHeader(blocks, title, location);
        await app.client.chat.update({ channel: slack_channel_id, ts: slack_message_ts, text: 'Updated', blocks });
      });
    };

    app.action('vote_yes', async ({ ack, body }) => { await ack(); await voteHandler('yes', body as any); });
    app.action('vote_maybe', async ({ ack, body }) => { await ack(); await voteHandler('maybe', body as any); });
    app.action('vote_no', async ({ ack, body }) => { await ack(); await voteHandler('no', body as any); });

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
  deadlineAt: Date;
  createdBy: string;
}): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `insert into events(project_id, title, location, status, deadline_at, created_by)
     values ($1,$2,$3,'planning',$4,$5)
     returning id`,
    [args.projectId, args.title, args.location, args.deadlineAt.toISOString(), args.createdBy]
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

// Header wrapper for blocks
function prependHeader(blocks: any[], title?: string, location?: string | null) {
  const arr: any[] = [];
  if (title) arr.push({ type: 'header', text: { type: 'plain_text', text: title } });
  if (location) arr.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Location: ${location}` }] });
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
     where v.choice = 'yes' and eo.id = $2
     on conflict (event_id, slack_user_id) do nothing`,
    [eventId, best.id]
  );

  // Booking placeholder (roomless). Unique on (room_id,start,end) allows NULL ⇒ may not de-dupe; acceptable for MVP
  await query(
    `insert into bookings(event_id, room_id, start_at, end_at)
     values ($1, null, $2, $3)
     on conflict do nothing`,
    [eventId, best.start_at, best.end_at]
  );

  // Notify thread
  const ch = ev.rows[0].slack_channel_id;
  const ts = ev.rows[0].slack_message_ts;
  if (ch && ts) {
    try {
      const msg = `${source === 'auto' ? '自動確定' : '手動確定'}: ${formatTimeRange(best.start_at, best.end_at)}`;
      // Post a short thread reply
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
