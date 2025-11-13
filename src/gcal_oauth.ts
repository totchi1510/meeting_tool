import { google } from 'googleapis';
import { query } from './db';

export function oauthEnabled() {
  return (
    process.env.ENABLE_GCAL_OAUTH === '1' ||
    process.env.ENABLE_GCAL_OAUTH === 'true'
  );
}

export function hasOAuthClientEnv() {
  return !!process.env.GOOGLE_OAUTH_CLIENT_ID && !!process.env.GOOGLE_OAUTH_CLIENT_SECRET && !!process.env.OAUTH_REDIRECT_BASE_URL;
}

export function buildOAuth2Client() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID!;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET!;
  const base = (process.env.OAUTH_REDIRECT_BASE_URL || '').replace(/\/$/, '');
  const redirectUri = `${base}/oauth/google/callback`;
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function getAuthUrl(): string {
  const oauth2Client = buildOAuth2Client();
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.readonly',
    ],
  });
  return url;
}

export async function exchangeCodeAndStore(code: string) {
  const oauth2Client = buildOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  let email: string | null = null;
  try {
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const me = await oauth2.userinfo.get();
    email = me.data.email || null;
  } catch {}

  await query(
    `insert into oauth_tokens(provider, account_email, access_token, refresh_token, scope, token_type, expiry_date)
     values ($1,$2,$3,$4,$5,$6, to_timestamp($7/1000.0))`,
    [
      'google',
      email,
      tokens.access_token,
      tokens.refresh_token,
      tokens.scope,
      tokens.token_type,
      tokens.expiry_date || null,
    ]
  );
}

async function getAnyToken() {
  const r = await query<{ id: string; access_token: string; refresh_token: string | null; scope: string | null; token_type: string | null; expiry_date: string | null }>(
    `select id, access_token, refresh_token, scope, token_type, expiry_date from oauth_tokens where provider=$1 order by updated_at desc limit 1`,
    ['google']
  );
  return r.rowCount ? r.rows[0] : null;
}

export async function ensureOAuthClientWithToken() {
  const tok = await getAnyToken();
  if (!tok) return null;
  const oauth2Client = buildOAuth2Client();
  oauth2Client.setCredentials({
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || undefined,
  });
  // Refresh if needed (best-effort)
  try {
    const res = await oauth2Client.getAccessToken();
    if (res && res.token && res.token !== tok.access_token) {
      await query('update oauth_tokens set access_token=$1, updated_at=now() where id=$2', [res.token, tok.id]);
    }
  } catch {}
  return oauth2Client;
}

function resolveSharedCalendarId(): string | undefined {
  const raw = process.env.GCALENDAR_ID_SHARED || '';
  if (!raw) return undefined;
  // Guard: if someone set an ICS URL or any URL, ignore and fallback to primary
  if (/^https?:\/\//i.test(raw) || /\.ics(\b|$)/i.test(raw)) {
    console.warn('[gcal-oauth] GCALENDAR_ID_SHARED looks like a URL (.ics). Falling back to primary.');
    return undefined;
  }
  return raw;
}

export async function registerFixedEventToGCalOAuth(eventId: string) {
  if (!oauthEnabled() || !hasOAuthClientEnv()) return;
  const calId = resolveSharedCalendarId(); // optional: user default calendar if unset

  const oauth2Client = await ensureOAuthClientWithToken();
  if (!oauth2Client) {
    console.warn('[gcal-oauth] no stored token; skip');
    return;
  }

  const ev = await query<{
    title: string; location: string | null; gcal_color_id: string | null; booking_id: string; start_at: string; end_at: string; gcal_event_id: string | null;
  }>(
    `select e.title, e.location, p.gcal_color_id,
            b.id as booking_id, b.start_at, b.end_at, b.gcal_event_id
       from events e
  left join projects p on p.id = e.project_id
       join bookings b on b.event_id = e.id
      where e.id = $1 and e.status = 'fixed'
      limit 1`,
    [eventId]
  );
  if (!ev.rowCount) return;
  const row = ev.rows[0];
  if (row.gcal_event_id) return;

  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  const timeMin = new Date(row.start_at).toISOString();
  const timeMax = new Date(row.end_at).toISOString();

  try {
    // Duplicate check (exact match window)
    const found = await calendar.events.list({
      calendarId: calId || 'primary',
      timeMin,
      timeMax,
      maxResults: 10,
      singleEvents: true,
      orderBy: 'startTime',
    });
    const match = (found.data.items || []).find((it) => {
      const s = it.start?.dateTime || it.start?.date;
      const e = it.end?.dateTime || it.end?.date;
      return s && e && s === timeMin && e === timeMax;
    });
    if (match && match.id) {
      await query('update bookings set gcal_event_id=$1 where id=$2', [match.id, row.booking_id]);
      return;
    }

    const created = await calendar.events.insert({
      calendarId: calId || 'primary',
      requestBody: {
        summary: row.title,
        location: row.location || undefined,
        start: { dateTime: timeMin },
        end: { dateTime: timeMax },
        colorId: row.gcal_color_id || undefined,
      },
    });
    const id = created.data.id;
    if (id) {
      await query('update bookings set gcal_event_id=$1 where id=$2', [id, row.booking_id]);
    }
  } catch (e) {
    console.error('[gcal-oauth] registration failed', e);
  }
}

export async function cancelFixedEventFromGCalOAuth(eventId: string) {
  if (!oauthEnabled() || !hasOAuthClientEnv()) return;
  const calId = resolveSharedCalendarId();

  const oauth2Client = await ensureOAuthClientWithToken();
  if (!oauth2Client) {
    console.warn('[gcal-oauth] no stored token; skip cancel');
    return;
  }

  try {
    const b = await query<{ gcal_event_id: string | null }>(
      `select gcal_event_id from bookings where event_id=$1 limit 1`,
      [eventId]
    );
    const gId = b.rowCount ? b.rows[0].gcal_event_id : null;
    if (!gId) return; // nothing to delete

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    await calendar.events.delete({ calendarId: calId || 'primary', eventId: gId });
  } catch (e) {
    console.error('[gcal-oauth] cancel failed', e);
  }
}
