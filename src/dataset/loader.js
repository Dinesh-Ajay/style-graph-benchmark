'use strict';

/**
 * Builds a deterministic sample from SNAP soc-Epinions1 (508,837 directed edges).
 * The original source is public: https://snap.stanford.edu/data/soc-Epinions1.html
 * Its first N valid edges provide a stable, <1 GB free-tier-friendly workload.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const zlib = require('node:zlib');

const SNAP_URL = 'https://snap.stanford.edu/data/soc-Epinions1.txt.gz';
const DATA_DIR = path.resolve(__dirname, '../../data');

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if ([301, 302, 307, 308].includes(response.statusCode) && response.headers.location) return resolve(download(response.headers.location));
      if (response.statusCode !== 200) return reject(new Error(`Dataset download failed: HTTP ${response.statusCode}`));
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

function parseSnap(text, edgeLimit) {
  const nodeIds = new Set(); const edges = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const [source, target] = line.trim().split(/\s+/);
    if (!source || !target || source === target) continue;
    edges.push({ source, target }); nodeIds.add(source); nodeIds.add(target);
    if (edges.length === edgeLimit) break;
  }
  if (edges.length < edgeLimit) throw new Error(`SNAP input contained only ${edges.length} usable edges; expected ${edgeLimit}.`);
  return {
    source: 'SNAP soc-Epinions1 deterministic prefix sample',
    nodes: [...nodeIds].map((id) => ({ id, category: String(Number(id) % 10) })), edges
  };
}

async function loadDataset({ edgeLimit = 150000 } = {}) {
  if (!Number.isInteger(edgeLimit) || edgeLimit < 100000 || edgeLimit > 300000) throw new Error('DATASET_EDGE_LIMIT must be an integer from 100000 to 300000.');
  const outputPath = path.join(DATA_DIR, `soc-epinions-${edgeLimit}.generated.json`);
  try { return JSON.parse(await fs.readFile(outputPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(DATA_DIR, { recursive: true });
  console.log(`Downloading SNAP soc-Epinions1 and preparing ${edgeLimit.toLocaleString()} relationships...`);
  const compressed = await download(SNAP_URL);
  const dataset = parseSnap(zlib.gunzipSync(compressed).toString('utf8'), edgeLimit);
  await fs.writeFile(outputPath, JSON.stringify(dataset));
  return dataset;
}

function createParameterSets(dataset, count) {
  // Evenly spread primary IDs rather than random selection, so every platform gets identical inputs.
  const candidates = dataset.nodes.filter((node) => node.id !== undefined);
  return Array.from({ length: count }, (_, index) => candidates[Math.floor(index * candidates.length / count) % candidates.length]);
}

if (require.main === module) loadDataset({ edgeLimit: Number(process.env.DATASET_EDGE_LIMIT || 150000) }).then((data) => console.log(`Ready: ${data.nodes.length} nodes, ${data.edges.length} relationships.`)).catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { loadDataset, createParameterSets, parseSnap };
