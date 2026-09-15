# ics-time-slice

A calendar someone has been exporting from for ten years is not a small file.
Export your whole work calendar and you can easily end up with tens of
thousands of VEVENTs and a file in the hundreds of megabytes. Most tools that
touch `.ics` files parse the entire thing into an in-memory object tree before
they let you do anything with it, which is fine until it isn't.

`ics-time-slice` does one thing: it reads an `.ics` file and writes out only
the events whose `DTSTART` falls within a date range you give it. It never
buffers more than one event's worth of lines at a time, so it works the same
way on a 2KB test fixture and a 2GB calendar export.

## Usage

```sh
# from a file, to a file
node src/cli.ts --from 2026-01-01 --to 2026-02-01 --input work.ics --output january.ics

# through a pipe, like a normal unix filter
cat work.ics | node src/cli.ts --from 2026-01-01 --to 2026-02-01 > january.ics
```

Dates are parsed with JavaScript's `Date` constructor, so anything in ISO
form works: `2026-01-01`, `2026-01-01T00:00:00Z`, etc. The range is
half-open: an event starting exactly at `--to` is excluded.

The output is a well-formed set of iCalendar lines (`BEGIN:VEVENT` through
`END:VEVENT` for each matching event, plus everything outside of events --
`VCALENDAR` headers, `VTIMEZONE` blocks, and so on -- passed through
unchanged) written to stdout unless `--output` is given.

## Requirements

Node 22.6 or newer, run with `--experimental-strip-types` if you're below the
version where Node runs TypeScript natively (23.6+):

```sh
node --experimental-strip-types src/cli.ts --from 2026-01-01 --to 2026-02-01
```

No dependencies to install -- this repo has no `node_modules` and never will.

## How the streaming works

`src/stream-filter.ts` reads the input line by line with `readline`, first
undoing RFC 5545 line folding (long lines are split across multiple physical
lines with a leading space or tab, and have to be glued back together before
you can read a property value). Lines outside of a `VEVENT` are written
straight through. Lines inside a `VEVENT` are held in a small buffer until
`END:VEVENT`, at which point the buffered event is either flushed to the
output or discarded, and the buffer is reset. Memory use is bounded by the
size of a single event, not the size of the file.

## Known limitations (this is a first pass)

- Recurring events (`RRULE`) are matched only on their first occurrence's
  `DTSTART`. A weekly meeting that started last year and recurs into your
  requested range will be dropped.
- `TZID`-qualified and floating (timezone-less) times are treated as UTC.
  `VTIMEZONE` blocks are passed through but not consulted.
- Output lines are not re-folded, so a single property line can exceed the
  75-octet limit recommended by RFC 5545. Most real-world parsers accept
  this; strict ones may not.

## License

MIT, see LICENSE.
