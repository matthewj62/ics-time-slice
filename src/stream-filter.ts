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

/**
 * Streams `input` line by line and writes to `output` only the VEVENT
 * components whose DTSTART falls in [from, to). At most one event's worth
 * of lines is ever held in memory -- everything else is a single buffered
 * line -- so this scales to calendars far larger than available RAM.
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

      if (upper === "END:VEVENT") {
        insideEvent = false;
        const keep = eventStart !== null && eventStart >= from && eventStart < to;
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
