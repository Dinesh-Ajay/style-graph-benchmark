'use strict';

/**
 * dashboard-server.js
 *
 * A thin control-plane for the existing, unmodified benchmark suite.
 * It never requires, imports, or re-implements anything under src/ — it
 * only launches `npm run benchmark` as a child process (exactly as a
 * developer would from a terminal), relays its stdout/stderr live over
 * Server-Sent Events, and reads the results.json that the benchmark
 * already writes.
 *
 * Contract with the existing frontend (public/index.html, public/js/app.js,
 * public/js/charts.js, public/js/terminal.js — none of which are modified
 * here):
 *
 *   GET  /api/status    -> { running, platforms }
 *   POST /api/run       -> { started, platforms, reset }   (body: { platforms: string[], reset?: boolean })
 *   POST /api/stop      -> { stopping: true }
 *   GET  /api/results   -> the parsed contents of results.json
 *   GET  /api/terminal  -> text/event-stream of { type: 'stdout'|'stderr'|'status'|'exit', ... }
 *
 * Requires the "express" package (already declared as a dependency in
 * package.json). Nothing in this file edits package.json, .env, or any
 * file under src/ — configuration continues to flow from .env exactly as
 * it does when the benchmark is run by hand; the only two variables ever
 * overridden are BENCHMARK_PLATFORMS and RESET_DATABASE, and only inside
 * the spawned child process's environment.
 *
 * Start with: node dashboard-server.js
 */

const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const express = require('express');

const PROJECT_ROOT = __dirname;
const RESULTS_PATH = path.join(PROJECT_ROOT, 'results.json');
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const PORT = Number(process.env.DASHBOARD_PORT) || 3000;
const HEARTBEAT_INTERVAL_MS = 20000;

// The four platforms this dashboard exposes. The benchmark itself (via
// orchestrator.js) also recognizes "neptune", but nothing in the uploaded
// frontend offers it, so it is intentionally left out of what the API
// will accept here — this file never touches orchestrator.js's own
// validation, it just avoids handing it something the UI never asked for.
const VALID_PLATFORM_KEYS = ['cognodb', 'neo4j', 'memgraph', 'arangodb'];

/** @type {import('node:child_process').ChildProcess|null} */
let benchmarkProcess = null;
let currentPlatforms = [];

/** @type {Set<import('express').Response>} */
const terminalClients = new Set();

/**
 * Sends one JSON-encoded event to every connected /api/terminal client.
 * JSON.stringify escapes embedded newlines, so a single `data:` line per
 * event is always valid SSE even when a chunk spans several printed lines
 * (e.g. a cli-table3 table) — nothing is buffered, split, or reformatted,
 * so box-drawing characters and column alignment survive untouched.
 *
 * @param {Record<string, unknown>} event
 */
function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of terminalClients) {
    client.write(payload);
  }
}

function isRunning() {
  return benchmarkProcess !== null;
}

/**
 * Terminates the running benchmark process tree as gracefully as the host
 * platform allows. `npm run benchmark` itself spawns `node src/orchestrator.js`
 * as a further child, so a plain kill() on the npm process alone would leave
 * the orchestrator running — this reaches the whole tree on both platforms.
 */
function terminateBenchmarkProcess() {
  if (!benchmarkProcess || !benchmarkProcess.pid) return;
  const pid = benchmarkProcess.pid;

  if (process.platform === 'win32') {
    // Windows has no POSIX process groups; taskkill /T walks the tree instead.
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  } else {
    // Spawned with detached: true below, so this pid is also its own
    // process group leader — signalling the negative pid reaches every
    // descendant, including the orchestrator.
    try {
      process.kill(-pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
}

/**
 * Launches the existing benchmark unchanged via `npm run benchmark`.
 * Only BENCHMARK_PLATFORMS and RESET_DATABASE are overridden, and only in
 * the spawned process's environment — .env on disk is never read, parsed,
 * or written by this server. Every other setting (credentials, timeouts,
 * iteration counts, ...) keeps flowing from .env exactly as it does when
 * the benchmark is run by hand.
 *
 * @param {string[]} platforms Non-empty array of validated platform keys.
 * @param {boolean} reset
 */
function startBenchmark(platforms, reset) {
  const isWindows = process.platform === 'win32';

  // On Windows, npm ships as npm.cmd — a batch file. Node's spawn() can
  // only execute batch files through a shell, so shell:true is required
  // there and *only* there (this is what previously produced `spawn
  // EINVAL`: attempting to spawn "npm" directly, without a shell, on a
  // platform where "npm" isn't a directly-executable binary). POSIX npm
  // is a real executable and needs no shell at all.
  const command = isWindows ? 'npm.cmd' : 'npm';

  benchmarkProcess = spawn(command, ['run', 'benchmark'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      BENCHMARK_PLATFORMS: platforms.join(','),
      RESET_DATABASE: reset ? 'true' : 'false'
    },
    shell: isWindows,
    // On POSIX, running as its own process group leader lets terminateBenchmarkProcess()
    // reach every descendant with a single signal. Not meaningful on Windows,
    // where taskkill /T is used instead.
    detached: !isWindows,
    windowsHide: true
  });

  currentPlatforms = platforms;
  broadcast({ type: 'status', running: true, platforms: currentPlatforms });

  benchmarkProcess.stdout.on('data', (chunk) => {
    broadcast({ type: 'stdout', text: chunk.toString('utf8') });
  });

  benchmarkProcess.stderr.on('data', (chunk) => {
    broadcast({ type: 'stderr', text: chunk.toString('utf8') });
  });

  benchmarkProcess.on('error', (error) => {
    broadcast({ type: 'stderr', text: `Failed to start benchmark: ${error.message}\n` });
    benchmarkProcess = null;
    broadcast({ type: 'status', running: false, platforms: currentPlatforms });
  });

  benchmarkProcess.on('exit', (code, signal) => {
    benchmarkProcess = null;
    broadcast({ type: 'exit', code, signal, platforms: currentPlatforms });
    broadcast({ type: 'status', running: false, platforms: currentPlatforms });
  });
}

/**
 * Validates the body of POST /api/run. Returns either { ok: true, platforms,
 * reset } or { ok: false, error } — this file never returns 400 for a request
 * that is actually well-formed.
 *
 * @param {unknown} body
 */
function validateRunRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be a JSON object.' };
  }

  const { platforms, reset } = body;

  if (!Array.isArray(platforms) || platforms.length === 0) {
    return { ok: false, error: 'platforms must be a non-empty array of platform keys.' };
  }
  if (!platforms.every((p) => typeof p === 'string' && p.trim().length > 0)) {
    return { ok: false, error: 'Every entry in platforms must be a non-empty string.' };
  }

  const normalized = [...new Set(platforms.map((p) => p.trim().toLowerCase()))];
  const unknown = normalized.filter((p) => !VALID_PLATFORM_KEYS.includes(p));
  if (unknown.length) {
    return { ok: false, error: `Unknown platform key(s): ${unknown.join(', ')}. Valid keys are: ${VALID_PLATFORM_KEYS.join(', ')}.` };
  }

  if (reset !== undefined && typeof reset !== 'boolean') {
    return { ok: false, error: 'reset must be a boolean when provided.' };
  }

  return { ok: true, platforms: normalized, reset: Boolean(reset) };
}

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

app.get('/api/status', (_req, res) => {
  res.json({ running: isRunning(), platforms: currentPlatforms });
});

app.post('/api/run', (req, res) => {
  if (isRunning()) {
    res.status(409).json({ error: 'Benchmark already running' });
    return;
  }

  const validation = validateRunRequest(req.body);
  if (!validation.ok) {
    res.status(400).json({ error: validation.error });
    return;
  }

  startBenchmark(validation.platforms, validation.reset);
  res.status(202).json({ started: true, platforms: currentPlatforms, reset: validation.reset });
});

app.post('/api/stop', (_req, res) => {
  if (!isRunning()) {
    res.status(409).json({ error: 'No benchmark is currently running' });
    return;
  }
  terminateBenchmarkProcess();
  res.json({ stopping: true });
});

app.get('/api/results', async (_req, res) => {
  try {
    const raw = await fs.readFile(RESULTS_PATH, 'utf8');
    res.json(JSON.parse(raw));
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.status(404).json({ error: 'results.json not found. Run the benchmark first.' });
      return;
    }
    res.status(500).json({ error: `Failed to read results.json: ${error.message}` });
  }
});

app.get('/api/terminal', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    // Disable buffering on common reverse proxies (e.g. nginx) so chunks
    // reach the browser the instant they are written here.
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();

  terminalClients.add(res);
  res.write(`data: ${JSON.stringify({ type: 'status', running: isRunning(), platforms: currentPlatforms })}\n\n`);

  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), HEARTBEAT_INTERVAL_MS);

  req.on('close', () => {
    clearInterval(heartbeat);
    terminalClients.delete(res);
  });
});

// Catches malformed JSON bodies (from express.json()) and any other
// synchronous route error instead of letting the process crash.
app.use((err, _req, res, _next) => {
  console.error(err);
  if (res.headersSent) return;
  res.status(400).json({ error: 'Invalid request' });
});

const server = app.listen(PORT, () => {
  console.log(`Dashboard listening on http://localhost:${PORT}`);
});

// Best-effort cleanup so a benchmark child process is never orphaned if the
// dashboard server itself is stopped (Ctrl+C, service manager, etc.).
function shutdown() {
  terminateBenchmarkProcess();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);