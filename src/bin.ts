#!/usr/bin/env node
// npm entry point: checks the runtime before loading the CLI, whose static imports (e.g. zstd in node:zlib) would
// otherwise fail on an older Node with an unhelpful link error.
const major = Number(process.versions.node.split('.')[0]);
if (major < 24) {
  console.error(`toonarrow needs Node.js >= 24 (running ${process.version})`);
  process.exit(1);
}
await import('./cli.ts');
