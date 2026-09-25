import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/**
 * RFC 5545 lines can be "folded": a long line is split into a CRLF followed
 * by a single leading space or tab, and a reader is expected to undo that by
 * dropping the CRLF + whitespace. We rely on readline to deal with chunk
 * boundaries for us and only have to glue folded lines back together here.
 */
async function* unfoldLines(input: Readable): AsyncGenerator<string> {
  const rl = createInterface({ input, crlfDelay: Infinity });
  let pending: string | null = null;

  for await (const rawLine of rl) {
    const isContinuation =
      pending !== null && (rawLine.startsWith(" ") || rawLine.startsWith("\t"));

    if (isContinuation) {
      pending += rawLine.slice(1);
      continue;
    }

    if (pending !== null) {
      yield pending;
    }
    pending = rawLine;
  }

  if (pending !== null) {
    yield pending;
  }
}

/**
 * Parses the handful of DATE and DATE-TIME forms iCalendar actually uses on
 * the wire. Local (floating) times and TZID-qualified times are treated as
 * UTC because we don't have a VTIMEZONE parser yet -- good enough for a
 * first pass, wrong near a change in a viewer's own timezone offset.
 */
function parseIcsDateTime(value: string): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!match) {
    return null;
  }

  const [, y, mo, d, h, mi, s] = match;
  const year = Number(y);
  const month = Number(mo) - 1;
  const day = Number(d);

  if (h === undefined) {
    return new Date(Date.UTC(year, month, day));
  }

  return new Date(Date.UTC(year, month, day, Number(h), Number(mi), Number(s)));
}

function parseRRuleParams(value: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const part of value.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) {
      continue;
    }
    params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).trim();
  }
  return params;
}

const SUPPORTED_RRULE_FREQUENCIES = new Set(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]);

// BYxxx parts change which days within a period actually recur (every
// weekday, the last Friday of the month, and so on). Expanding those
// correctly is a bigger job than plain interval stepping, and getting it
// wrong silently would be worse than the old first-occurrence-only check,
// so a rule with any of these falls back to that instead.
const UNSUPPORTED_RRULE_PARTS = [
  "BYSECOND",
  "BYMINUTE",
  "BYHOUR",
  "BYDAY",
  "BYMONTHDAY",
  "BYYEARDAY",
  "BYWEEKNO",
  "BYMONTH",
  "BYSETPOS",
];

function monthlyOccurrence(
  year0: number,
  month0: number,
  day0: number,
  h: number,
  mi: number,
  s: number,
  monthOffset: number
): Date | null {
  const totalMonths = month0 + monthOffset;
  const year = year0 + Math.floor(totalMonths / 12);
  const month = ((totalMonths % 12) + 12) % 12;
  const candidate = new Date(Date.UTC(year, month, day0, h, mi, s));
  // Date.UTC rolls an out-of-range day into the next month (Feb 31 becomes
  // Mar 3); RFC 5545 says a month that doesn't have that day just has no
  // occurrence, so treat a roll-over as "no occurrence" rather than a date.
  if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month) {
    return null;
  }
  return candidate;
}

function yearlyOccurrence(
  year0: number,
  month0: number,
  day0: number,
  h: number,
  mi: number,
  s: number,
  yearOffset: number
): Date | null {
  const year = year0 + yearOffset;
  const candidate = new Date(Date.UTC(year, month0, day0, h, mi, s));
  if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month0) {
    return null; // Feb 29 anniversary landing on a non-leap year
  }
  return candidate;
}

/**
 * Decides whether a recurring event has any occurrence in [from, to).
 * Handles FREQ/INTERVAL/COUNT/UNTIL for DAILY, WEEKLY, MONTHLY and YEARLY
 * rules by walking occurrences forward from DTSTART. Occurrences are
 * non-decreasing, so the walk can stop the moment one reaches `to` --
 * bounded by however many occurrences fit before the range, not by COUNT
 * or how far out UNTIL is.
 */
function hasOccurrenceInRange(dtstart: Date, rruleValue: string, from: Date, to: Date): boolean {
  const params = parseRRuleParams(rruleValue);
  const freq = params.FREQ;

  if (!freq || !SUPPORTED_RRULE_FREQUENCIES.has(freq) || UNSUPPORTED_RRULE_PARTS.some((key) => key in params)) {
    return dtstart >= from && dtstart < to;
  }

  const rawInterval = Number(params.INTERVAL);
  const interval = Number.isInteger(rawInterval) && rawInterval > 0 ? rawInterval : 1;
  const count = params.COUNT !== undefined ? Number(params.COUNT) : null;
  const until = params.UNTIL !== undefined ? parseIcsDateTime(params.UNTIL) : null;

  const year0 = dtstart.getUTCFullYear();
  const month0 = dtstart.getUTCMonth();
  const day0 = dtstart.getUTCDate();
  const h = dtstart.getUTCHours();
  const mi = dtstart.getUTCMinutes();
  const s = dtstart.getUTCSeconds();

  // A hard cap so a malformed rule (e.g. COUNT that fails to parse) can't
  // spin forever instead of falling through to "no occurrence found".
  const MAX_STEPS = 100_000;
  let produced = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    let occurrence: Date | null;
    switch (freq) {
      case "DAILY":
        occurrence = new Date(Date.UTC(year0, month0, day0 + step * interval, h, mi, s));
        break;
      case "WEEKLY":
        occurrence = new Date(Date.UTC(year0, month0, day0 + step * interval * 7, h, mi, s));
        break;
      case "MONTHLY":
        occurrence = monthlyOccurrence(year0, month0, day0, h, mi, s, step * interval);
        break;
      default: // YEARLY
        occurrence = yearlyOccurrence(year0, month0, day0, h, mi, s, step * interval);
        break;
    }

    if (occurrence === null) {
      continue; // this period has no valid occurrence; try the next one
    }
    if (until !== null && occurrence > until) {
      return false;
    }
    if (occurrence >= to) {
      return false;
    }
    if (count !== null && produced >= count) {
      return false;
    }
    if (occurrence >= from) {
      return true;
    }
    produced++;
  }

  return false;
}

/**
 * Streams `input` line by line and writes to `output` only the VEVENT
 * components that have an occurrence in [from, to) -- either a plain
 * DTSTART in range, or (for recurring events) an RRULE-generated
 * occurrence in range. At most one event's worth of lines is ever held in
 * memory -- everything else is a single buffered line -- so this scales
 * to calendars far larger than available RAM.
 */
export async function filterEventsByDateRange(
  input: Readable,
  output: Writable,
  from: Date,
  to: Date
): Promise<void> {
  let insideEvent = false;
  let eventLines: string[] = [];
  let eventStart: Date | null = null;
  let eventRRule: string | null = null;

  const write = (line: string): Promise<void> =>
    new Promise((resolve, reject) => {
      output.write(`${line}\r\n`, (err) => (err ? reject(err) : resolve()));
    });

  for await (const line of unfoldLines(input)) {
    const upper = line.toUpperCase();

    if (upper === "BEGIN:VEVENT") {
      insideEvent = true;
      eventLines = [line];
      eventStart = null;
      eventRRule = null;
      continue;
    }

    if (insideEvent) {
      eventLines.push(line);

      if (upper.startsWith("DTSTART")) {
        const colon = line.indexOf(":");
        if (colon !== -1) {
          eventStart = parseIcsDateTime(line.slice(colon + 1));
        }
      }

      if (upper.startsWith("RRULE")) {
        const colon = line.indexOf(":");
        if (colon !== -1) {
          eventRRule = line.slice(colon + 1);
        }
      }

      if (upper === "END:VEVENT") {
        insideEvent = false;
        const keep =
          eventStart !== null &&
          (eventRRule !== null
            ? hasOccurrenceInRange(eventStart, eventRRule, from, to)
            : eventStart >= from && eventStart < to);
        if (keep) {
          for (const bufferedLine of eventLines) {
            await write(bufferedLine);
          }
        }
        eventLines = [];
      }
      continue;
    }

    // Outside of a VEVENT: VCALENDAR headers, VTIMEZONE, VALARM-free
    // properties, etc. pass straight through so the output stays valid.
    await write(line);
  }
}
