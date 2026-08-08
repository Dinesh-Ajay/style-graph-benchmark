/**
 * public/js/app.js
 *
 * Orchestrates the dashboard: wires the four "Run Benchmark" cards and the
 * Compare Platforms panel to POST /api/run and /api/stop, keeps the live
 * terminal (imported unmodified from ./terminal.js) connected to
 * /api/terminal, and pulls GET /api/results into the summary cards and
 * charts (./charts.js) whenever a run finishes.
 *
 * This file never talks to the benchmark itself — it only calls the five
 * endpoints dashboard-server.js already exposes.
 */

import { Terminal } from './terminal.js';
import { PLATFORMS, normalizeResults, METRIC_DEFINITIONS, platformMeta, renderCharts, destroyCharts } from './charts.js';

/* ============================================================
   STATE
   ============================================================ */

const state = {
  isRunning: false
};

/* ============================================================
   DOM HELPERS
   ============================================================ */

const $ = (selector) => document.querySelector(selector);
const $all = (selector) => Array.from(document.querySelectorAll(selector));

const statusBadge = $('#status-badge');
const statusText = $('#status-text');
const runComparisonBtn = $('#run-comparison-btn');
const stopBtn = $('#stop-btn');
const resultsEmptyState = $('#results-empty-state');
const resultsSummaryGrid = $('#results-summary-grid');
const chartsSection = $('#charts-section');

/* ============================================================
   TOASTS — lightweight, non-blocking error/success notifications
   ============================================================ */

/**
 * @param {string} message
 * @param {'info'|'success'|'error'} [type]
 */
function showToast(message, type = 'info') {
  const container = $('#toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  // Double rAF so the transition reliably fires even on the very first toast.
  requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('toast--visible')));

  setTimeout(() => {
    toast.classList.remove('toast--visible');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  }, 6000);
}

/* ============================================================
   STATUS BADGE + BUTTON STATE
   ============================================================ */

const STATUS_MODES = {
  idle: { text: 'Idle', cls: 'status--idle' },
  running: { text: 'Running', cls: 'status--running' },
  completed: { text: 'Completed', cls: 'status--completed' },
  stopped: { text: 'Stopped', cls: 'status--stopped' }
};

/**
 * @param {'idle'|'running'|'completed'|'stopped'} mode
 * @param {string[]} [platforms]
 */
function updateStatusBadge(mode, platforms = []) {
  const config = STATUS_MODES[mode] || STATUS_MODES.idle;
  const platformLabel = platforms.length
    ? platforms.map((id) => platformMeta(id).label).join(', ')
    : '';

  statusText.textContent = platformLabel ? `${config.text}: ${platformLabel}` : config.text;
  statusBadge.classList.remove('status--idle', 'status--running', 'status--completed', 'status--stopped');
  statusBadge.classList.add(config.cls);
}

/** Enables/disables every Run button and the Stop button based on whether a benchmark is executing. */
function setButtonsForRunning(running) {
  state.isRunning = running;
  $all('.run-btn').forEach((btn) => { btn.disabled = running; });
  runComparisonBtn.disabled = running;
  stopBtn.disabled = !running;
  stopBtn.textContent = '■ Stop Benchmark';
}

/* ============================================================
   RESULTS SECTION VISIBILITY
   ============================================================ */

function showResultsSection() {
  resultsEmptyState.hidden = true;
  resultsSummaryGrid.hidden = false;
  chartsSection.hidden = false;
}

/** @param {string} message */
function showResultsEmptyState(message) {
  resultsEmptyState.textContent = message;
  resultsEmptyState.hidden = false;
  resultsSummaryGrid.hidden = true;
  chartsSection.hidden = true;
  destroyCharts();
}

function clearResultsForNewRun() {
  showResultsEmptyState('Benchmark running — results will appear here as soon as it finishes.');
}

/* ============================================================
   SUMMARY CARDS
   ============================================================ */

/** Formats a raw numeric metric value for display, according to its unit. */
function formatMetricValue(value, unit) {
  if (unit === 'ms') return `${value.toFixed(2)} ms`;
  if (unit === 'ops/sec') return `${Math.round(value).toLocaleString()} ops/sec`;
  return String(value);
}

/**
 * Builds the five "Ingestion Throughput / Traversal Latency / Lookup Latency /
 * Aggregation / Mixed Workload" summary cards from normalized results.
 */
function renderSummaryCards(normalized) {
  resultsSummaryGrid.innerHTML = '';

  for (const def of METRIC_DEFINITIONS) {
    const metric = normalized.metrics[def.key];
    const entries = Object.entries(metric.values);

    const card = document.createElement('article');
    card.className = 'summary-card glass';

    const title = document.createElement('h3');
    title.textContent = metric.label;
    card.appendChild(title);

    if (entries.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'summary-card__empty';
      empty.textContent = 'No data for this run.';
      card.appendChild(empty);
      resultsSummaryGrid.appendChild(card);
      continue;
    }

    // Best-first ordering: higher-is-better metrics sort descending, lower-is-better ascending.
    const sorted = entries.sort(([, a], [, b]) => (metric.better === 'higher' ? b - a : a - b));

    const list = document.createElement('ul');
    list.className = 'summary-card__list';

    sorted.forEach(([platformId, value], index) => {
      const meta = platformMeta(platformId);
      const item = document.createElement('li');

      const dot = document.createElement('span');
      dot.className = 'summary-card__dot';
      dot.style.background = meta.color;

      const label = document.createElement('span');
      label.className = 'summary-card__platform';
      label.textContent = meta.label;

      const value_ = document.createElement('span');
      value_.className = 'summary-card__value';
      value_.textContent = formatMetricValue(value, metric.unit);

      item.append(dot, label, value_);

      if (index === 0) {
        const badge = document.createElement('span');
        badge.className = 'summary-card__badge';
        badge.textContent = 'Best';
        item.appendChild(badge);
      }

      list.appendChild(item);
    });

    card.appendChild(list);
    resultsSummaryGrid.appendChild(card);
  }
}

/* ============================================================
   RESULTS FETCHING
   ============================================================ */

async function loadResults() {
  try {
    const response = await fetch('/api/results');

    if (response.status === 404) {
      showResultsEmptyState('No results yet — run a benchmark above to generate results.json.');
      return;
    }

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error((data && data.error) || `Request failed with status ${response.status}`);
    }

    const normalized = normalizeResults(data);

    if (normalized.platforms.length === 0) {
      showResultsEmptyState('results.json did not contain any recognizable platform metrics.');
      return;
    }

    renderSummaryCards(normalized);
    renderCharts(normalized);
    showResultsSection();
  } catch (error) {
    showToast(`Could not load results: ${error.message}`, 'error');
    showResultsEmptyState('Results could not be loaded — see the notification for details.');
  }
}

/* ============================================================
   RUN / STOP ACTIONS
   ============================================================ */

/**
 * @param {string[]} platforms
 * @param {boolean} reset
 */
async function runBenchmark(platforms, reset) {
  // Optimistic UI update — the SSE 'status' event will confirm this shortly after.
  setButtonsForRunning(true);
  updateStatusBadge('running', platforms);
  clearResultsForNewRun();

  try {
    const response = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platforms, reset })
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || `Request failed with status ${response.status}`);
    }

    showToast(`Benchmark started: ${(data.platforms || platforms).join(', ')}`, 'success');
  } catch (error) {
    setButtonsForRunning(false);
    updateStatusBadge('idle');
    showResultsEmptyState('No results yet. Run a benchmark above to see live metrics and charts appear here.');
    showToast(`Could not start benchmark: ${error.message}`, 'error');
  }
}

async function stopBenchmark() {
  stopBtn.disabled = true;
  stopBtn.textContent = '■ Stopping…';

  try {
    const response = await fetch('/api/stop', { method: 'POST' });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || `Request failed with status ${response.status}`);
    }
    // Authoritative state change (button re-enable, status badge) happens
    // when the terminal's 'exit' event arrives — see onStopped below.
  } catch (error) {
    stopBtn.disabled = !state.isRunning;
    stopBtn.textContent = '■ Stop Benchmark';
    showToast(`Could not stop benchmark: ${error.message}`, 'error');
  }
}

/* ============================================================
   LIVE TERMINAL
   ============================================================
   Terminal (imported unmodified from terminal.js) already parses every SSE
   event from /api/terminal and calls showRunning/showFinished/showStopped
   internally. Subclassing lets the dashboard react to those same state
   transitions (toggle buttons, fetch results) without touching terminal.js
   or duplicating its SSE-parsing logic.
*/

class DashboardTerminal extends Terminal {
  /**
   * @param {ConstructorParameters<typeof Terminal>[0]} options
   * @param {{onRunning: Function, onFinished: Function, onStopped: Function}} hooks
   */
  constructor(options, hooks) {
    super(options);
    this.hooks = hooks;
  }

  showRunning(platforms = []) {
    super.showRunning(platforms);
    this.hooks.onRunning(platforms);
  }

  showFinished(platforms = []) {
    super.showFinished(platforms);
    this.hooks.onFinished(platforms);
  }

  showStopped(platforms = [], code = null, signal = null) {
    super.showStopped(platforms, code, signal);
    this.hooks.onStopped(platforms, code, signal);
  }
}

function initTerminal() {
  const terminal = new DashboardTerminal(
    { outputElement: '#terminal-output', statusElement: '#terminal-status' },
    {
      onRunning: (platforms) => {
        setButtonsForRunning(true);
        updateStatusBadge('running', platforms);
      },
      onFinished: (platforms) => {
        setButtonsForRunning(false);
        updateStatusBadge('completed', platforms);
        showToast('Benchmark finished successfully.', 'success');
        loadResults();
      },
      onStopped: (platforms, code, signal) => {
        setButtonsForRunning(false);
        updateStatusBadge('stopped', platforms);
        const reason = signal ? `signal ${signal}` : `exit code ${code}`;
        showToast(`Benchmark stopped (${reason}).`, code === 0 ? 'info' : 'error');
      }
    }
  );
  terminal.connect();
}

/* ============================================================
   EVENT WIRING
   ============================================================ */

function attachEventListeners() {
  $all('.run-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      runBenchmark([btn.dataset.platform], false);
    });
  });

  runComparisonBtn.addEventListener('click', () => {
    const selected = $all('.compare-checkbox:checked').map((cb) => cb.value);
    if (selected.length === 0) {
      showToast('Select at least one platform to compare.', 'error');
      return;
    }
    const reset = $('#reset-toggle').checked;
    runBenchmark(selected, reset);
  });

  stopBtn.addEventListener('click', stopBenchmark);
}

/* ============================================================
   INITIAL SYNC
   ============================================================
   Covers the case where the dashboard is opened (or reloaded) while a
   benchmark is already running elsewhere, or after one has already
   completed — so the UI reflects real state immediately, before the SSE
   stream's own status event arrives.
*/

async function syncInitialStatus() {
  try {
    const response = await fetch('/api/status');
    if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
    const data = await response.json();

    if (data.running) {
      setButtonsForRunning(true);
      updateStatusBadge('running', data.platforms || []);
    } else {
      setButtonsForRunning(false);
      updateStatusBadge('idle');
    }
  } catch (error) {
    showToast('Could not reach the dashboard server. Make sure dashboard-server.js is running.', 'error');
    updateStatusBadge('idle');
  }
}

/* ============================================================
   BOOTSTRAP
   ============================================================ */

function init() {
  attachEventListeners();
  initTerminal();
  syncInitialStatus();
  loadResults(); // best-effort: show results from a previous run, if any
}

init();