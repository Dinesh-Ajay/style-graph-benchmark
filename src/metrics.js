'use strict';

const nowNs = () => process.hrtime.bigint();
const elapsedMs = (startedAt) => Number(process.hrtime.bigint() - startedAt) / 1e6;

function percentile(sortedValues, percentileValue) {
  if (!sortedValues.length) return null;
  // Nearest-rank percentile: exact, deterministic, and documented.
  return sortedValues[Math.ceil((percentileValue / 100) * sortedValues.length) - 1];
}

function latencySummary(samples) {
  const sorted = samples.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, p50Ms: null, p95Ms: null, averageMs: null, minMs: null, maxMs: null };
  return {
    count: sorted.length,
    p50Ms: percentile(sorted, 50), p95Ms: percentile(sorted, 95),
    averageMs: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    minMs: sorted[0], maxMs: sorted.at(-1)
  };
}

async function measure(operation) {
  const startedAt = nowNs();
  await operation();
  return elapsedMs(startedAt);
}

async function runLatencyWorkload(operation, parameters, warmupIterations, measuredIterations) {
  for (let index = 0; index < warmupIterations; index += 1) {
      console.log(`Warmup ${index + 1}/${warmupIterations}`);
      await operation(parameters[index % parameters.length]);
  }
  const samples = [];
  for (let index = 0; index < measuredIterations; index += 1) {
      console.log(`Measured iteration ${index + 1}/${measuredIterations}`);
      samples.push(
          await measure(() => operation(parameters[index % parameters.length]))
      );}  
      return latencySummary(samples);
}

module.exports = { nowNs, elapsedMs, percentile, latencySummary, measure, runLatencyWorkload };

