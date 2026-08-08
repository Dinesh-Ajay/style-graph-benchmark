'use strict';

const { Database } = require('arangojs');
const { nowNs, elapsedMs, runLatencyWorkload } = require('../metrics');
const { BATCH_SIZE } = require('./base-cypher');

class ArangoPlatform {
  constructor() {
    this.name = 'ArangoDB Cloud';
    if (!process.env.ARANGODB_URL || !process.env.ARANGODB_USERNAME || !process.env.ARANGODB_PASSWORD) throw new Error('ArangoDB Cloud is not configured. Set ARANGODB_URL, ARANGODB_USERNAME, and ARANGODB_PASSWORD.');
    this.db = new Database({ url: process.env.ARANGODB_URL, databaseName: process.env.ARANGODB_DATABASE || 'benchmark', auth: { username: process.env.ARANGODB_USERNAME, password: process.env.ARANGODB_PASSWORD } });
    this.people = this.db.collection('people'); this.follows = this.db.collection('follows');
  }
  async validateConnection() { await this.db.version(); }
  async close() { /* arangojs uses HTTP keep-alive; no explicit close is required. */ }
  async reset() {
    if (await this.people.exists()) await this.people.drop();
    if (await this.follows.exists()) await this.follows.drop();
    const writes = this.db.collection('benchmark_writes');
    if (await writes.exists()) await writes.drop();
  }
  async ensureSchema() {
    if (!await this.people.exists()) await this.people.create();
    if (!await this.follows.exists()) await this.follows.create({ type: 3 });
    if (!await this.db.collection('benchmark_writes').exists()) await this.db.collection('benchmark_writes').create();
    const indexes = await this.people.indexes();
    for (const field of ['id', 'category']) if (!indexes.some((index) => index.type === 'persistent' && index.fields.length === 1 && index.fields[0] === field)) await this.people.ensureIndex({ type: 'persistent', fields: [field], unique: field === 'id', name: `idx_people_${field}` });
  }
  async aql(query, bindVars = {}) { return this.db.query(query, bindVars, { timeout: Number(process.env.QUERY_TIMEOUT_MS || 30000) }); }
  async ingest(dataset) {
    const startedAt = nowNs();
    for (let index = 0; index < dataset.nodes.length; index += BATCH_SIZE) await this.people.import(dataset.nodes.slice(index, index + BATCH_SIZE).map((node) => ({ _key: node.id, ...node })), { onDuplicate: 'error' });
    for (let index = 0; index < dataset.edges.length; index += BATCH_SIZE) await this.follows.import(dataset.edges.slice(index, index + BATCH_SIZE).map((edge) => ({ _from: `people/${edge.source}`, _to: `people/${edge.target}` })), { onDuplicate: 'ignore' });
    const seconds = elapsedMs(startedAt) / 1000;
    return { seconds, nodeBatchSize: BATCH_SIZE, relationshipBatchSize: BATCH_SIZE, nodesPerSecond: dataset.nodes.length / seconds, relationshipsPerSecond: dataset.edges.length / seconds };
  }
  async traversal(depth, id) { await this.aql(`FOR start IN people FILTER start.id == @id FOR vertex, edge, path IN 1..${depth} OUTBOUND start follows OPTIONS { bfs: true, uniqueVertices: 'global' } COLLECT target = vertex.id WITH COUNT INTO total RETURN total`, { id }); }
  async point(id) { await this.aql('FOR node IN people FILTER node.id == @id RETURN { id: node.id, category: node.category }', { id }); }
  async filtered(category) { await this.aql('FOR node IN people FILTER node.category == @category LIMIT 50 RETURN node.id', { category }); }
  async aggregate() { await this.aql('FOR node IN people LET outgoing = LENGTH(FOR edge IN follows FILTER edge._from == node._id RETURN 1) COLLECT category = node.category AGGREGATE averageOutDegree = AVG(outgoing) RETURN { category, averageOutDegree }'); }
  async write(id) { await this.aql('UPSERT { _key: @id } INSERT { _key: @id, createdAt: DATE_NOW() } UPDATE {} IN benchmark_writes RETURN NEW._key', { id }); }
  async mixedWorkload(ids, clients, operationsPerClient, writeRatio) {
    const startedAt = nowNs(); let operations = 0;
    await Promise.all(Array.from({ length: clients }, async (_, client) => {
      for (let index = 0; index < operationsPerClient; index += 1) {
        const write = ((client * operationsPerClient + index) % 100) < Math.round(writeRatio * 100);
        if (write) await this.write(`mixed-${client}-${index}`); else await this.point(ids[(client * operationsPerClient + index) % ids.length].id);
        operations += 1;
      }
    }));
    const seconds = elapsedMs(startedAt) / 1000; return { operations, seconds, qps: operations / seconds, clients, writeRatio };
  }
  async runBenchmark(dataset, options) {
    await this.validateConnection(); if (options.resetDatabase) await this.reset(); await this.ensureSchema();
    const ingestion = options.resetDatabase ? await this.ingest(dataset) : { skipped: true, reason: 'RESET_DATABASE=false' };
    const values = options.parameterSets;
    const workload = (operation, mapper = (node) => node.id) => runLatencyWorkload(operation, values.map(mapper), options.warmupIterations, options.measuredIterations);
    return { platform: this.name, generatedAt: new Date().toISOString(), dataset: { source: dataset.source, nodes: dataset.nodes.length, relationships: dataset.edges.length }, ingestion,
      traversals: { oneHop: await workload((id) => this.traversal(1, id)), twoHop: await workload((id) => this.traversal(2, id)), threeHop: await workload((id) => this.traversal(3, id)) },
      lookups: { point: await workload((id) => this.point(id)), filtered: await workload((category) => this.filtered(category), (node) => node.category) }, aggregation: await workload(() => this.aggregate()),
      concurrent: await this.mixedWorkload(values, options.concurrentClients, options.concurrentOperationsPerClient, options.writeRatio),
      resourceFootprint: { status: 'not observable', note: 'Not consistently exposed by ArangoDB Cloud free tiers.' }, indexedProperties: ['people.id', 'people.category'] };
  }
}
module.exports = () => new ArangoPlatform();
