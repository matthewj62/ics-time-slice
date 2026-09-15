#!/usr/bin/env node
import { createReadStream, createWriteStream } from "node:fs";
import process, { stdin, stdout } from "node:process";
import { filterEventsByDateRange } from "./stream-filter.js";

interface Options {
  from: Date;
  to: Date;
  input?: string;
  output?: string;
}

function printUsage(): void {
  console.error(
    [
      "usage: ics-time-slice --from <date> --to <date> [--input file.ics] [--output file.ics]",
      "",
      "Reads a calendar from stdin (or --input) and writes only the VEVENTs",
      "whose DTSTART falls in [from, to) to stdout (or --output).",
      "Dates are parsed with `new Date(...)`, so ISO forms like 2026-01-01 work.",
    ].join("\n")
  );
}

function parseArgs(argv: string[]): Options {
  let from: Date | undefined;
  let to: Date | undefined;
  let input: string | undefined;
  let output: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--from":
        from = new Date(argv[++i]);
        break;
      case "--to":
        to = new Date(argv[++i]);
        break;
      case "--input":
      case "-i":
        input = argv[++i];
        break;
      case "--output":
      case "-o":
        output = argv[++i];
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`unrecognized argument: ${arg}`);
    }
  }

  if (!from || Number.isNaN(from.getTime())) {
    throw new Error("--from is required and must be a parseable date");
  }
  if (!to || Number.isNaN(to.getTime())) {
    throw new Error("--to is required and must be a parseable date");
  }

  return { from, to, input, output };
}

async function main(): Promise<void> {
  let options: Options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    printUsage();
    process.exitCode = 1;
    return;
  }

  const input = options.input ? createReadStream(options.input) : stdin;
  const output = options.output ? createWriteStream(options.output) : stdout;

  await filterEventsByDateRange(input, output, options.from, options.to);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
