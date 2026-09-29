// Compares Webswitch with the other browsers installed here: how fast each starts, how much memory
// and CPU it uses (memory as PSS, which does not count shared libraries twice), and how fast its
// engine runs the same JavaScript/DOM workload.
//
//   node tools/bench/bench.mjs [--browsers webswitch,firefox,chrome] [--out results.json]
//
// Every browser gets its own fresh profile, opens visible windows on this desktop, and talks only to
// a small server on 127.0.0.1. Each run is a warm start: the profile is created by a discarded run.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const PAGES = path.join(import.meta.dirname, 'pages');
const PORT = 8770;
const ARGS = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce(
      (acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc),
      [],
    ),
);
const WANTED = (ARGS.browsers ?? 'webswitch,firefox,chrome').split(',');
const RUNS = { startup: 3, tabs: 2, js: 2 };
const SETTLE_MS = 8000;
const WINDOW_MS = 10000;
const TABS = 5;

// ── The browsers ────────────────────────────────────────────────────────────────────────────
const BROWSERS = {
  webswitch: {
    label: 'Webswitch (WebKitGTK)',
    prepare: (profile) => fs.mkdirSync(profile, { recursive: true }),
    command: (profile, urls) => ({
      cmd: 'gjs',
      args: ['-m', path.join(ROOT, 'dist/main.js'), ...urls],
      env: {
        WEBSWITCH_APP_ID: 'dev.webswitch.Bench',
        XDG_CONFIG_HOME: `${profile}/config`,
        XDG_DATA_HOME: `${profile}/data`,
        XDG_CACHE_HOME: `${profile}/cache`,
      },
    }),
  },
  firefox: {
    label: 'Firefox',
    prepare: (profile) => {
      fs.mkdirSync(profile, { recursive: true });
      // Only what keeps first-run pages from opening extra tabs; everything else is stock.
      fs.writeFileSync(
        `${profile}/user.js`,
        [
          'user_pref("browser.aboutwelcome.enabled", false);',
          'user_pref("browser.startup.homepage_override.mstone", "ignore");',
          'user_pref("startup.homepage_welcome_url", "");',
          'user_pref("browser.shell.checkDefaultBrowser", false);',
          'user_pref("datareporting.policy.firstRunURL", "");',
          'user_pref("browser.startup.page", 0);',
        ].join('\n'),
      );
    },
    command: (profile, urls) => ({
      cmd: 'firefox',
      args: ['--no-remote', '--new-instance', '--profile', profile, ...urls],
      env: {},
    }),
  },
  chrome: {
    label: 'Google Chrome',
    prepare: (profile) => fs.mkdirSync(profile, { recursive: true }),
    command: (profile, urls) => ({
      cmd: 'google-chrome-stable',
      args: [
        '--user-data-dir=' + profile,
        '--no-first-run',
        '--no-default-browser-check',
        '--ozone-platform-hint=auto',
        ...urls,
      ],
      env: {},
    }),
  },
};

// ── The local server the browsers talk to ───────────────────────────────────────────────────
const events = [];
const results = new Map();
http
  .createServer((req, res) => {
    const t = process.hrtime.bigint();
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const id = url.searchParams.get('id');
    events.push({ path: url.pathname, id, t });
    const page = { '/page': 'page.html', '/heavy': 'heavy.html', '/bench': 'bench.html' }[
      url.pathname
    ];
    if (page) {
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      res.end(fs.readFileSync(path.join(PAGES, page)));
    } else if (url.pathname === '/result') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        results.set(id, JSON.parse(body));
        res.writeHead(204).end();
      });
    } else {
      res.writeHead(204).end();
    }
  })
  .listen(PORT, '127.0.0.1');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, ms) {
  for (let waited = 0; waited < ms; waited += 50) {
    const value = check();
    if (value) return value;
    await sleep(50);
  }
  return null;
}
const seen = (pathname, id) => events.find((e) => e.path === pathname && e.id === id)?.t ?? null;
const url = (pathname, id) => `http://127.0.0.1:${PORT}${pathname}?id=${id}`;

// ── Processes ───────────────────────────────────────────────────────────────────────────────
function pidsInSession(sid) {
  return execFileSync('ps', ['-eo', 'pid=,sid='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([, s]) => s === sid)
    .map(([pid]) => pid);
}
function pssKb(pid) {
  try {
    return Number(
      /^Pss:\s+(\d+) kB/m.exec(fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'))?.[1] ?? 0,
    );
  } catch {
    return 0;
  }
}
function cpuTicks(pid) {
  try {
    const fields = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = fields.slice(fields.lastIndexOf(')') + 2).split(' ');
    return Number(rest[11]) + Number(rest[12]);
  } catch {
    return 0;
  }
}
function sample(sid) {
  const pids = pidsInSession(sid);
  return {
    pids,
    pssMb: pids.reduce((sum, pid) => sum + pssKb(pid), 0) / 1024,
    ticks: new Map(pids.map((pid) => [pid, cpuTicks(pid)])),
  };
}
async function stop(sid) {
  for (let i = 0; i < 40 && pidsInSession(sid).length > 0; i++) {
    try {
      execFileSync('pkill', [i < 10 ? '-TERM' : '-KILL', '-s', String(sid)]);
    } catch {
      /* nothing left to kill */
    }
    await sleep(250);
  }
  await sleep(500);
}
function start(browser, profile, urls) {
  const { cmd, args, env } = browser.command(profile, urls);
  const child = spawn(cmd, args, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...env },
  });
  child.unref();
  return child.pid;
}

// ── Scenarios ───────────────────────────────────────────────────────────────────────────────
async function measureIdle(sid) {
  await sleep(SETTLE_MS);
  const before = sample(sid);
  await sleep(WINDOW_MS);
  const after = sample(sid);
  let ticks = 0;
  for (const [pid, t] of after.ticks)
    if (before.ticks.has(pid)) ticks += t - (before.ticks.get(pid) ?? 0);
  return {
    memoryMb: Math.round(after.pssMb),
    processes: after.pids.length,
    idleCpuPercent: Math.round((ticks / 100 / (WINDOW_MS / 1000)) * 1000) / 10,
  };
}

async function startupRun(name, browser, profile, run) {
  const id = `${name}-a-${run}`;
  const t0 = process.hrtime.bigint();
  const sid = start(browser, profile, [url('/page', id)]);
  const first = await waitFor(() => seen('/page', id), 60000);
  const loaded = await waitFor(() => seen('/loaded', id), 60000);
  if (!first || !loaded) {
    await stop(sid);
    return null;
  }
  const idle = await measureIdle(sid);
  await stop(sid);
  return { firstRequestMs: Number(first - t0) / 1e6, loadedMs: Number(loaded - t0) / 1e6, ...idle };
}

async function tabsRun(name, browser, profile, run) {
  const ids = Array.from({ length: TABS }, (_, i) => `${name}-b-${run}-${i}`);
  const sid = start(
    browser,
    profile,
    ids.map((id) => url('/heavy', id)),
  );
  const ok = await waitFor(() => ids.every((id) => seen('/loaded', id)), 90000);
  if (!ok) {
    await stop(sid);
    return null;
  }
  const idle = await measureIdle(sid);
  await stop(sid);
  return idle;
}

async function jsRun(name, browser, profile, run) {
  const id = `${name}-c-${run}`;
  const sid = start(browser, profile, [url('/bench', id)]);
  const done = await waitFor(() => results.get(id), 180000);
  await stop(sid);
  return done;
}

// ── Main ────────────────────────────────────────────────────────────────────────────────────
const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const summary = {};
const log = (message) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${message}`);

for (const name of WANTED) {
  const browser = BROWSERS[name];
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `bench-${name}-`));
  browser.prepare(profile);
  log(`${browser.label}: warming up the profile`);
  await startupRun(name, browser, profile, 0);

  const startup = [];
  for (let run = 1; run <= RUNS.startup; run++) {
    log(`${browser.label}: one tab, run ${run}/${RUNS.startup}`);
    const result = await startupRun(name, browser, profile, run);
    if (result) startup.push(result);
  }
  const tabs = [];
  for (let run = 1; run <= RUNS.tabs; run++) {
    log(`${browser.label}: ${TABS} heavy tabs, run ${run}/${RUNS.tabs}`);
    const result = await tabsRun(name, browser, profile, run);
    if (result) tabs.push(result);
  }
  const js = [];
  for (let run = 1; run <= RUNS.js; run++) {
    log(`${browser.label}: JS/DOM suite, run ${run}/${RUNS.js}`);
    const result = await jsRun(name, browser, profile, run);
    if (result) js.push(result);
  }

  const m = (rows, key) =>
    rows.length ? Math.round(median(rows.map((r) => r[key])) * 10) / 10 : null;
  const suiteNames = js[0] ? Object.keys(js[0].results) : [];
  summary[name] = {
    label: browser.label,
    startup: { firstRequestMs: m(startup, 'firstRequestMs'), loadedMs: m(startup, 'loadedMs') },
    oneTab: {
      memoryMb: m(startup, 'memoryMb'),
      processes: m(startup, 'processes'),
      idleCpuPercent: m(startup, 'idleCpuPercent'),
    },
    fiveTabs: {
      memoryMb: m(tabs, 'memoryMb'),
      processes: m(tabs, 'processes'),
      idleCpuPercent: m(tabs, 'idleCpuPercent'),
    },
    js: {
      total: js.length ? median(js.map((r) => r.total)) : null,
      tests: Object.fromEntries(suiteNames.map((t) => [t, median(js.map((r) => r.results[t]))])),
      agent: js[0]?.agent,
    },
  };
  fs.rmSync(profile, { recursive: true, force: true });
}

if (ARGS.out) fs.writeFileSync(ARGS.out, JSON.stringify(summary, null, 2));
console.log('\nRESULT_JSON ' + JSON.stringify(summary));
process.exit(0);
