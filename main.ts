// I/O contract: reads /input/cases.json (array of {input:{text,header}}),
// writes /output/answers.json (array of solve.js run() results, same order).
// Output dir is emptied by CONTENTS only — never rm the dir itself, since
// /output is a mount point on the grader and removing it fails EBUSY.
// main.ts — the program the harness runs: read every case from
// /input/cases.json, answer each with solve.js's run, and write
// /output/answers.json. Runs on Node 22.18+ (type stripping) with no
// dependencies and no network.
import { setFlagsFromString } from 'node:v8';

// Match the house driver's V8 tuning: incremental marking off, set before
// solve.js is imported so it applies to its compilation.
setFlagsFromString('--no-incremental-marking');

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const inputDir = process.env.MAKEFUN_INPUT_DIR || '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';

const { run } = await import('./solve.js');

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));
const answers = cases.map((c: { input: { text: string; header: boolean } }) => run(c.input));

// Create the output directory, then empty only its CONTENTS: on the
// grader /output is a mount point, and removing the directory itself
// fails EBUSY.
mkdirSync(outputDir, { recursive: true });
for (const entryName of readdirSync(outputDir)) {
  rmSync(join(outputDir, entryName), { recursive: true, force: true });
}
writeFileSync(join(outputDir, 'answers.json'), JSON.stringify(answers));
