// Minimal RFC 5545 iCal parser. Scope is intentionally narrow: just enough to read
// NYSE's holiday-and-hours feed. We support:
//
//   - line unfolding (continuation lines start with space/tab — RFC 5545 §3.1)
//   - VEVENT blocks
//   - DTSTART;VALUE=DATE:YYYYMMDD (the only date form NYSE emits for holidays)
//   - SUMMARY:<text>
//   - DESCRIPTION:<text>  (carries early-close times for half-days)
//
// We deliberately throw on RRULE / EXDATE / VTIMEZONE references inside VEVENT —
// NYSE has historically emitted only plain VEVENT blocks. If they change shape and
// start including recurrence rules, the throw surfaces it on the next deploy rather
// than silently dropping events.
//
// Zero external deps.

export interface IcalEvent {
  readonly dtStart: string;      // 'YYYYMMDD' as parsed from VALUE=DATE
  readonly summary: string;
  readonly description: string;
}

export function parseIcal(text: string): IcalEvent[] {
  // 1. Line unfolding: per RFC 5545 §3.1, a CRLF followed by a space or tab is a
  //    continuation of the previous logical line. We normalise CRLF → LF first.
  const normalised = text.replace(/\r\n/g, '\n');
  const lines: string[] = [];
  for (const line of normalised.split('\n')) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }

  // 2. Scan top-level VEVENT blocks. Anything between BEGIN:VEVENT and END:VEVENT
  //    is a single event; we extract the three fields we care about.
  const events: IcalEvent[] = [];
  let cur: { dtStart?: string; summary?: string; description?: string } | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') {
      const dtStart = cur?.dtStart;
      if (cur && dtStart) {
        events.push({
          dtStart,
          summary:     cur.summary ?? '',
          description: cur.description ?? '',
        });
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    // Inside a VEVENT. Reject shape-change indicators.
    if (line.startsWith('RRULE') || line.startsWith('EXDATE') || line.startsWith('RDATE')) {
      throw new Error(`[ical-parser] unsupported recurrence property in VEVENT: ${line.slice(0, 60)}. Update the parser before deploy.`);
    }
    // DTSTART;VALUE=DATE:20261225 is the only form we accept. End-of-line anchor
    // rejects datetime variants (20261225T140000Z) so a shape change throws rather
    // than silently truncating to the date part.
    if (line.startsWith('DTSTART')) {
      const m = line.match(/^DTSTART(?:;[^:]+)?:(\d{8})$/);
      if (!m || !m[1]) throw new Error(`[ical-parser] unsupported DTSTART form: ${line}. Parser only handles VALUE=DATE.`);
      cur.dtStart = m[1];
      continue;
    }
    if (line.startsWith('SUMMARY:'))     cur.summary     = unescapeIcal(line.slice('SUMMARY:'.length));
    if (line.startsWith('DESCRIPTION:')) cur.description = unescapeIcal(line.slice('DESCRIPTION:'.length));
  }
  return events;
}

// RFC 5545 §3.3.11 TEXT escaping: \\ \, \; \n
function unescapeIcal(s: string): string {
  return s.replace(/\\([nN,;\\])/g, (_, c) => {
    if (c === 'n' || c === 'N') return '\n';
    return c;
  });
}

// Parse 'YYYYMMDD' → 'YYYY-MM-DD' for downstream consumers.
export function icalDateToIso(dtStart: string): string {
  return `${dtStart.slice(0, 4)}-${dtStart.slice(4, 6)}-${dtStart.slice(6, 8)}`;
}

export function icalDateYear(dtStart: string): number {
  return parseInt(dtStart.slice(0, 4), 10);
}

// NYSE encodes early-close times in DESCRIPTION as "Markets close at 1:00 PM." or
// "Closes at 1:00 PM ET." Extract the time and convert to 24h "HH:MM".
// Returns null if no time found — caller treats as a full closure.
export function parseEarlyCloseFromDescription(desc: string): string | null {
  if (!desc) return null;
  // Capture e.g. "1:00 PM", "11:30 AM". Case-insensitive, allows no minutes.
  const m = desc.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);
  if (!m) return null;
  let hour = parseInt(m[1]!, 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const meridiem = m[3]!.toUpperCase();
  if (meridiem === 'PM' && hour !== 12) hour += 12;
  if (meridiem === 'AM' && hour === 12) hour = 0;
  return `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}
