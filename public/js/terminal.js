/**
 * public/js/terminal.js
 *
 * Browser-side controller for the live benchmark terminal. Connects to the
 * dashboard's /api/terminal Server-Sent Events endpoint and renders stdout
 * and stderr chunks exactly as the CLI printed them — same whitespace,
 * same Unicode table borders, same line breaks — with no parsing or
 * reformatting of the underlying cli-table3 output.
 *
 * Usage (once an HTML page provides the target elements):
 *   import { Terminal } from '/js/terminal.js';
 *   const terminal = new Terminal({
 *     outputElement: '#terminal-output',
 *     statusElement: '#terminal-status'
 *   });
 *   terminal.connect();
 */

const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]/g;

/** Strips ANSI escape sequences so only plain text ever reaches the DOM. */
function stripAnsi(text) {
  return typeof text === 'string' ? text.replace(ANSI_ESCAPE_PATTERN, '') : text;
}

/** Accepts either a CSS selector string or an already-resolved Element. */
function resolveElement(target) {
  if (typeof target === 'string') return document.querySelector(target);
  if (target instanceof Element) return target;
  return null;
}

export class Terminal {
  /**
   * @param {object} [options]
   * @param {string|Element} [options.outputElement='#terminal-output'] Container that receives streamed output.
   * @param {string|Element} [options.statusElement='#terminal-status'] Optional element that reflects run state.
   * @param {string} [options.endpoint='/api/terminal'] SSE endpoint to connect to.
   * @param {boolean} [options.autoScroll=true] Whether the output auto-scrolls as new lines arrive.
   * @param {number} [options.minReconnectDelayMs=1000] Initial delay before the first reconnect attempt.
   * @param {number} [options.maxReconnectDelayMs=10000] Ceiling for the exponential reconnect backoff.
   */
  constructor({
    outputElement = '#terminal-output',
    statusElement = '#terminal-status',
    endpoint = '/api/terminal',
    autoScroll = true,
    minReconnectDelayMs = 1000,
    maxReconnectDelayMs = 10000
  } = {}) {
    this.outputElement = resolveElement(outputElement);
    this.statusElement = resolveElement(statusElement);

    if (!this.outputElement) {
      throw new Error(`Terminal: no output element found for "${outputElement}".`);
    }

    this.endpoint = endpoint;
    this.autoScroll = autoScroll;
    this.minReconnectDelayMs = minReconnectDelayMs;
    this.maxReconnectDelayMs = maxReconnectDelayMs;

    this._source = null;
    this._reconnectDelay = this.minReconnectDelayMs;
    this._reconnectTimer = null;
    this._manuallyClosed = false;

    this.preserveWhitespace();
    this.preserveUnicodeTables();
  }

  /** Ensures printed whitespace (indentation, blank lines, column padding) survives untouched. */
  preserveWhitespace() {
    this.outputElement.style.whiteSpace = 'pre-wrap';
    this.outputElement.style.wordBreak = 'break-word';
  }

  /** Ensures box-drawing / Unicode table borders render aligned, monospaced, and un-ligated. */
  preserveUnicodeTables() {
    this.outputElement.style.fontFamily =
      '"Cascadia Code", Consolas, "SFMono-Regular", Menlo, Monaco, monospace';
    this.outputElement.style.fontVariantLigatures = 'none';
    this.outputElement.style.overflowX = 'auto';
  }

  /** Opens the SSE connection and starts streaming benchmark output. No-op if already connected. */
  connect() {
    if (this._source) return;
    this._manuallyClosed = false;
    this._open();
  }

  _open() {
    const source = new EventSource(this.endpoint);
    this._source = source;

    source.onopen = () => {
      this._reconnectDelay = this.minReconnectDelayMs;
    };

    source.onmessage = (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        // Defensive fallback: treat unparseable payloads as raw stdout text
        // rather than dropping them silently.
        this.append(event.data);
        return;
      }
      this._handleEvent(payload);
    };

    source.onerror = () => {
      source.close();
      this._source = null;
      if (this._manuallyClosed) return;
      this._scheduleReconnect();
    };
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._open();
    }, this._reconnectDelay);
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, this.maxReconnectDelayMs);
  }

  _handleEvent(payload) {
    switch (payload.type) {
      case 'stdout':
        this.append(payload.text);
        break;
      case 'stderr':
        this.appendError(payload.text);
        break;
      case 'status':
        if (payload.running) this.showRunning(payload.platforms);
        break;
      case 'exit':
        if (payload.code === 0) this.showFinished(payload.platforms);
        else this.showStopped(payload.platforms, payload.code, payload.signal);
        break;
      default:
        break;
    }
  }

  /** Closes the SSE connection and cancels any pending reconnect attempt. */
  disconnect() {
    this._manuallyClosed = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._source) {
      this._source.close();
      this._source = null;
    }
  }

  /** Empties the terminal output. */
  clear() {
    this.outputElement.textContent = '';
  }

  _appendChunk(text, className) {
    const clean = stripAnsi(text);
    const chunk = document.createElement('span');
    if (className) chunk.className = className;
    chunk.textContent = clean;
    this.outputElement.appendChild(chunk);
    if (this.autoScroll) this.scrollToBottom();
  }

  /** Appends a chunk of normal stdout text exactly as received (whitespace and line breaks intact). */
  append(text) {
    this._appendChunk(text, 'terminal-line terminal-line--stdout');
  }

  /** Appends a chunk of stderr text, visually marked as an error. */
  appendError(text) {
    this._appendChunk(text, 'terminal-line terminal-line--stderr');
  }

  /** Appends a highlighted status message that did not come from the raw process output. */
  appendSuccess(text) {
    this._appendChunk(text, 'terminal-line terminal-line--success');
  }

  /**
   * Reflects that a benchmark run has started.
   * @param {string[]} [platforms]
   */
  showRunning(platforms = []) {
    if (this.statusElement) {
      this.statusElement.textContent = platforms.length ? `Running: ${platforms.join(', ')}` : 'Running';
      this.statusElement.dataset.state = 'running';
    }
  }

  /**
   * Reflects that a benchmark run finished successfully (exit code 0).
   * @param {string[]} [platforms]
   */
  showFinished(platforms = []) {
    if (this.statusElement) {
      this.statusElement.textContent = platforms.length ? `Finished: ${platforms.join(', ')}` : 'Finished';
      this.statusElement.dataset.state = 'finished';
    }
    this.appendSuccess('\nBenchmark finished.\n');
  }

  /**
   * Reflects that a benchmark run was stopped or exited with a failure.
   * @param {string[]} [platforms]
   * @param {number|null} [code]
   * @param {string|null} [signal]
   */
  showStopped(platforms = [], code = null, signal = null) {
    const reason = signal ? `signal ${signal}` : `exit code ${code}`;
    if (this.statusElement) {
      this.statusElement.textContent = platforms.length
        ? `Stopped (${reason}): ${platforms.join(', ')}`
        : `Stopped (${reason})`;
      this.statusElement.dataset.state = 'stopped';
    }
    this.appendError(`\nBenchmark stopped (${reason}).\n`);
  }

  /** Scrolls the output element to the latest streamed line. */
  scrollToBottom() {
    this.outputElement.scrollTop = this.outputElement.scrollHeight;
  }
}