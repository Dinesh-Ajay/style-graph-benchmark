'use strict';

require('dotenv').config();

const fs = require('node:fs/promises');
const path = require('node:path');
const Table = require('cli-table3');
const { nowNs, elapsedMs } = require('./metrics');
const { loadDataset, createParameterSets } = require('./dataset/loader');

const RESULTS_PATH = path.resolve(__dirname, '../results.json');

// Every supported platform key maps 1:1 to a module in src/platforms/*.js.
// Each module exports a zero-argument factory that returns a fresh platform
// instance so a bad instantiation (e.g. missing credentials) never leaks a
// half-open driver from a previous run.
const PLATFORM_MODULES = {
  cognodb: './platforms/cognodb',
  neo4j: './platforms/neo4j',
  memgraph: './platforms/memgraph',
  arangodb: './platforms/arangodb',
  neptune: './platforms/neptune'
};

const ALL_PLATFORM_KEYS = Object.keys(PLATFORM_MODULES);

function resolveActivePlatforms() {
  const raw = (process.env.BENCHMARK_PLATFORMS || '').trim();
  if (!raw) return ALL_PLATFORM_KEYS;
  const requested = [...new Set(raw.split(',').map((key) => key.trim().toLowerCase()).filter(Boolean))];
  if (!requested.length) return ALL_PLATFORM_KEYS;
  const unknown = requested.filter((key) => !ALL_PLATFORM_KEYS.includes(key));
  if (unknown.length) {
    throw new Error(`Unknown platform(s) in BENCHMARK_PLATFORMS: ${unknown.join(', ')}. Valid keys are: ${ALL_PLATFORM_KEYS.join(', ')}.`);
  }
  return requested;
}

function readOptions() {
  const asInt = (name, fallback) => {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
    return value;
  };
  const warmupIterations = asInt('WARMUP_ITERATIONS', 15);
  const measuredIterations = asInt('MEASURED_ITERATIONS', 100);
  const concurrentClients = asInt('CONCURRENT_CLIENTS', 10);
  const concurrentOperationsPerClient = asInt('CONCURRENT_OPERATIONS_PER_CLIENT', 20);

  const writeRatio = Number(process.env.WRITE_RATIO ?? 0.10);
  if (!Number.isFinite(writeRatio) || writeRatio < 0 || writeRatio > 1) throw new Error('WRITE_RATIO must be a number between 0 and 1.');

  const resetDatabase = (process.env.RESET_DATABASE ?? 'true').trim().toLowerCase() !== 'false';

  const edgeLimit = Number(process.env.DATASET_EDGE_LIMIT || 150000);

  return { warmupIterations, measuredIterations, concurrentClients, concurrentOperationsPerClient, writeRatio, resetDatabase, edgeLimit };
}

function fmtMs(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : 'N/A';
}
function fmtRate(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value).toLocaleString() : 'N/A';
}
function fmtSeconds(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : 'N/A';
}
function fmtQps(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : 'N/A';
}

function printIngestionTable(rows) {
  const table = new Table({ head: ['Platform', 'Nodes/sec', 'Rels/sec', 'Total Time (s)'] });
  for (const r of rows) {
    if (r.status === 'error') { table.push([r.platformKey, 'ERROR', 'ERROR', 'ERROR']); continue; }
    if (r.ingestion.skipped) { table.push([r.platform, 'skipped', 'skipped', r.ingestion.reason]); continue; }
    table.push([r.platform, fmtRate(r.ingestion.nodesPerSecond), fmtRate(r.ingestion.relationshipsPerSecond), fmtSeconds(r.ingestion.seconds)]);
  }
  console.log('\nIngestion Throughput');
  console.log(table.toString());
}

function printTraversalTable(rows) {
  const table = new Table({ head: ['Platform', '1-Hop p50', '1-Hop p95', '2-Hop p50', '2-Hop p95', '3-Hop p50', '3-Hop p95'] });
  for (const r of rows) {
    if (r.status === 'error') { table.push([r.platformKey, 'ERROR', 'ERROR', 'ERROR', 'ERROR', 'ERROR', 'ERROR']); continue; }
    const { oneHop, twoHop, threeHop } = r.traversals;
    table.push([r.platform, fmtMs(oneHop.p50Ms), fmtMs(oneHop.p95Ms), fmtMs(twoHop.p50Ms), fmtMs(twoHop.p95Ms), fmtMs(threeHop.p50Ms), fmtMs(threeHop.p95Ms)]);
  }
  console.log('\nMulti-Hop Traversal Latency (ms)');
  console.log(table.toString());
}

function printLookupTable(rows) {
  const table = new Table({ head: ['Platform', 'Point p50', 'Point p95', 'Filtered p50', 'Filtered p95'] });
  for (const r of rows) {
    if (r.status === 'error') { table.push([r.platformKey, 'ERROR', 'ERROR', 'ERROR', 'ERROR']); continue; }
    const { point, filtered } = r.lookups;
    table.push([r.platform, fmtMs(point.p50Ms), fmtMs(point.p95Ms), fmtMs(filtered.p50Ms), fmtMs(filtered.p95Ms)]);
  }
  console.log('\nLookup Latency (ms)');
  console.log(table.toString());
}

function printAggregationTable(rows) {
  const table = new Table({ head: ['Platform', 'p50', 'p95'] });
  for (const r of rows) {
    if (r.status === 'error') { table.push([r.platformKey, 'ERROR', 'ERROR']); continue; }
    table.push([r.platform, fmtMs(r.aggregation.p50Ms), fmtMs(r.aggregation.p95Ms)]);
  }
  console.log('\nAggregation Query Latency (ms)');
  console.log(table.toString());
}

function printMixedWorkloadTable(rows) {
  const table = new Table({ head: ['Platform', 'Clients', 'Ops/Client', 'Write Ratio', 'Total Ops', 'Duration (s)', 'QPS'] });
  for (const r of rows) {
    if (r.status === 'error') { table.push([r.platformKey, 'ERROR', 'ERROR', 'ERROR', 'ERROR', 'ERROR', 'ERROR']); continue; }
    const c = r.concurrent;
    const opsPerClient = c.clients ? Math.round(c.operations / c.clients) : 'N/A';
    table.push([r.platform, c.clients, opsPerClient, `${Math.round(c.writeRatio * 100)}%`, c.operations, fmtSeconds(c.seconds), fmtQps(c.qps)]);
  }
  console.log('\nMixed Workload Throughput');
  console.log(table.toString());
}

function printSummaryTables(results) {
  const failed = results.filter((r) => r.status === 'error');
  if (failed.length) {
    console.log('\nPlatforms that did not complete:');
    for (const failure of failed) console.log(`  - ${failure.platformKey}: ${failure.error}`);
  }
  printIngestionTable(results);
  printTraversalTable(results);
  printLookupTable(results);
  printAggregationTable(results);
  printMixedWorkloadTable(results);
}

async function runPlatform(key, dataset, options) {
  const startedAt = nowNs();
  let platform = null;
  try {
    const factory = require(PLATFORM_MODULES[key]);
    platform = factory();
    console.log(`\n=== ${key} ===`);
    const result = await platform.runBenchmark(dataset, options);
    result.platformKey = key;
    result.status = 'success';
    console.log(`${result.platform}: completed in ${(elapsedMs(startedAt) / 1000).toFixed(1)}s`);
    return result;
  } catch (error) {
    console.error(`${key}: FAILED - ${error.message}`);
    return { platformKey: key, platform: key, status: 'error', error: error.message, generatedAt: new Date().toISOString() };
  } finally {
    if (platform && typeof platform.close === 'function') {
      try { await platform.close(); } catch (closeError) { console.error(`${key}: error while closing driver - ${closeError.message}`); }
    }
  }
}

async function main() {
  const activePlatformKeys = resolveActivePlatforms();
  const options = readOptions();

  console.log(`Platforms: ${activePlatformKeys.join(', ')}`);
  console.log(`Reset database before each run: ${options.resetDatabase}`);

  const dataset = await loadDataset({ edgeLimit: options.edgeLimit });
  console.log(`Dataset ready: ${dataset.nodes.length.toLocaleString()} nodes, ${dataset.edges.length.toLocaleString()} relationships (${dataset.source}).`);

  // Parameter sets must be large enough to cover both the latency workload
  // (warmup + measured iterations) and the mixed-workload phase (clients x
  // operations per client) without an unreasonably short repeat cycle.
  const parameterSetSize = Math.max(
    options.warmupIterations + options.measuredIterations,
    options.concurrentClients * options.concurrentOperationsPerClient,
    100
  );
  const parameterSets = createParameterSets(dataset, parameterSetSize);
  console.log(`Generated ${parameterSets.length} deterministic parameter sets for latency and mixed workloads.`);

  const benchmarkOptions = { ...options, parameterSets };

  const results = [];
  for (const key of activePlatformKeys) {
    results.push(await runPlatform(key, dataset, benchmarkOptions));
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    options: {
      benchmarkPlatforms: activePlatformKeys,
      resetDatabase: options.resetDatabase,
      datasetEdgeLimit: options.edgeLimit,
      warmupIterations: options.warmupIterations,
      measuredIterations: options.measuredIterations,
      concurrentClients: options.concurrentClients,
      concurrentOperationsPerClient: options.concurrentOperationsPerClient,
      writeRatio: options.writeRatio,
      parameterSetSize
    },
    dataset: { source: dataset.source, nodes: dataset.nodes.length, relationships: dataset.edges.length },
    results
  };

  await fs.writeFile(RESULTS_PATH, JSON.stringify(payload, null, 2));
  console.log(`\nRaw results written to ${RESULTS_PATH}`);

  printSummaryTables(results);

  if (results.some((r) => r.status === 'error')) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { resolveActivePlatforms, readOptions };
