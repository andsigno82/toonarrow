import { type Rule, plural } from './common.ts';

// Vite/Rollup asset table: `dist/assets/index-abc.js   123.45 kB │ gzip: 40.12 kB │ map: 300.00 kB`.
const ASSET = /^(\S.*?)\s+([\d.,]+) (B|kB|MB)\s+│ gzip:\s+([\d.,]+) (B|kB|MB)(?:\s+│ map:.*)?$/;
const KB: Record<string, number> = { B: 1 / 1000, kB: 1, MB: 1000 };
const SHOWN = 10;

const kb = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(2)} MB` : `${n.toFixed(2)} kB`);
const ext = (path: string): string => /\.([a-z0-9]+)$/i.exec(path)?.[1] ?? 'other';

/**
 * Vite build output: each run of asset-table lines becomes one summary (count per extension, total and gzip size)
 * followed by the largest assets as printed. Every other line (warnings, errors, `✓ built in`) is kept.
 */
export const viteAssets: Rule = {
  name: 'vite-build',
  byFormat: true,
  match: (_cmd, out) => (out.match(/│ gzip:/g)?.length ?? 0) >= SHOWN,
  apply(lines) {
    const out: string[] = [];
    let hidden = 0;
    for (let i = 0; i < lines.length; ) {
      if (!ASSET.test(lines[i]!)) {
        out.push(lines[i]!);
        i++;
        continue;
      }
      const run: Array<{ line: string; path: string; size: number; gzip: number }> = [];
      for (; i < lines.length; i++) {
        const m = ASSET.exec(lines[i]!);
        if (!m) break;
        run.push({ line: lines[i]!, path: m[1]!, size: Number(m[2]!.replace(/,/g, '')) * KB[m[3]!]!, gzip: Number(m[4]!.replace(/,/g, '')) * KB[m[5]!]! });
      }
      if (run.length <= SHOWN) {
        out.push(...run.map((a) => a.line));
        continue;
      }
      const byExt = new Map<string, number>();
      for (const a of run) byExt.set(ext(a.path), (byExt.get(ext(a.path)) ?? 0) + 1);
      const total = run.reduce((s, a) => s + a.size, 0);
      const gzip = run.reduce((s, a) => s + a.gzip, 0);
      const counts = [...byExt].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([e, n]) => `${n} .${e}`).join(', ');
      out.push(`# ${plural(run.length, 'asset')} (${counts}), ${kb(total)}, gzip ${kb(gzip)}; the ${SHOWN} largest:`);
      // Stable sort: equal sizes keep the build's order, so the output is deterministic.
      out.push(...[...run].sort((a, b) => b.size - a.size).slice(0, SHOWN).map((a) => a.line));
      hidden += run.length - SHOWN;
    }
    return hidden ? out : null;
  },
};
