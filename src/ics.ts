type IcsEvent = {
  uid: string;
  title: string;
  start: Date;
  end: Date;
  location?: string | null;
  updated?: Date;
};

function fmtDT(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = date.getUTCFullYear();
  const m = pad(date.getUTCMonth() + 1);
  const d = pad(date.getUTCDate());
  const hh = pad(date.getUTCHours());
  const mm = pad(date.getUTCMinutes());
  const ss = pad(date.getUTCSeconds());
  return `${y}${m}${d}T${hh}${mm}${ss}Z`;
}

function fold(line: string): string {
  // Fold at 75 octets with CRLF + space (simple approximation)
  const max = 75;
  if (line.length <= max) return line;
  const parts: string[] = [];
  let i = 0;
  while (i < line.length) {
    const chunk = line.slice(i, i + max);
    parts.push(i === 0 ? chunk : ` ${chunk}`);
    i += max;
  }
  return parts.join('\r\n');
}

export function buildICS(feedName: string, events: IcsEvent[]): string {
  const lines: string[] = [];
  lines.push('BEGIN:VCALENDAR');
  lines.push('VERSION:2.0');
  lines.push('PRODID:-//meeting-tools//ics//EN');
  lines.push(fold(`NAME:${feedName}`));
  lines.push(fold(`X-WR-CALNAME:${feedName}`));

  for (const ev of events) {
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${ev.uid}`);
    lines.push(`DTSTAMP:${fmtDT(ev.updated || new Date())}`);
    lines.push(`DTSTART:${fmtDT(ev.start)}`);
    lines.push(`DTEND:${fmtDT(ev.end)}`);
    lines.push(fold(`SUMMARY:${ev.title}`));
    if (ev.location) lines.push(fold(`LOCATION:${ev.location}`));
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

