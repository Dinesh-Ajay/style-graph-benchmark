'use strict';

const neo4j = require('neo4j-driver');
const { nowNs, elapsedMs, runLatencyWorkload } = require('../metrics');

const BATCH_SIZE = 1000;

class CypherPlatform {
  constructor({ name, uri, username, password, database, schemaMode = 'neo4j' }) {
    if (!uri || !username || !password) throw new Error(`${name} is not configured. Set its URI, username, and password in .env.`);
    this.name = name; this.database = database || undefined; this.schemaMode = schemaMode;
    this.driver = neo4j.driver(uri, neo4j.auth.basic(username, password), { connectionTimeout: Number(process.env.QUERY_TIMEOUT_MS || 30000) });
  }

  session(mode = neo4j.session.WRITE) { return this.driver.session({ database: this.database, defaultAccessMode: mode }); }
  async query(cypher, params = {}, mode = neo4j.session.READ) {
      const session = this.session(mode);
      try {
          const result = await session.run(cypher, params);

          // Give the server a tiny chance to finish sending data
          await new Promise(resolve => setTimeout(resolve, 50));

          return result;
      } finally {
          await session.close();
      }
  }
  async validateConnection() { await this.driver.verifyConnectivity(); }
  async close() { await this.driver.close(); }
  async reset() { await this.query('MATCH (n) DETACH DELETE n', {}, neo4j.session.WRITE); }

  async ensureSchema() {
    const statements = this.schemaMode === 'memgraph'
      ? ['CREATE INDEX ON :Person(id)', 'CREATE INDEX ON :Person(category)']
      : ['CREATE INDEX person_id IF NOT EXISTS FOR (n:Person) ON (n.id)', 'CREATE INDEX person_category IF NOT EXISTS FOR (n:Person) ON (n.category)'];
    for (const statement of statements) {
      try { await this.query(statement, {}, neo4j.session.WRITE); } catch (error) {
        // Some entry tiers provision indexes asynchronously or reject duplicate legacy syntax.
        if (!/already exists|equivalent|exists/i.test(error.message)) throw error;
      }
    }
  }

  async ingest(dataset) {
    const startedAt = nowNs();
    for (let index = 0; index < dataset.nodes.length; index += BATCH_SIZE) {
      await this.query('UNWIND $rows AS row CREATE (:Person {id: row.id, category: row.category})', { rows: dataset.nodes.slice(index, index + BATCH_SIZE) }, neo4j.session.WRITE);
    }
    for (let index = 0; index < dataset.edges.length; index += BATCH_SIZE) {
      await this.query('UNWIND $rows AS row MATCH (source:Person {id: row.source}) MATCH (target:Person {id: row.target}) CREATE (source)-[:FOLLOWS]->(target)', { rows: dataset.edges.slice(index, index + BATCH_SIZE) }, neo4j.session.WRITE);
    }
    const seconds = elapsedMs(startedAt) / 1000;
    return { seconds, nodeBatchSize: BATCH_SIZE, relationshipBatchSize: BATCH_SIZE, nodesPerSecond: dataset.nodes.length / seconds, relationshipsPerSecond: dataset.edges.length / seconds };
  }
  traversalQuery(depth, id) {

      if (depth === 1) {
          return this.query(`
              MATCH (start:Person {id: $id})-[:FOLLOWS]->(a)
              RETURN count(DISTINCT a) AS total
          `, { id });
      }

      if (depth === 2) {
          return this.query(`
              MATCH (start:Person {id: $id})-[:FOLLOWS]->(a)
              MATCH (a)-[:FOLLOWS]->(b)
              RETURN count(DISTINCT b) AS total
          `, { id });
      }

      return this.query(`
          MATCH (start:Person {id: $id})
          MATCH (start)-[:FOLLOWS]->(a)
          MATCH (a)-[:FOLLOWS]->(b)
          MATCH (b)-[:FOLLOWS]->(c)
          RETURN count(DISTINCT c) AS total
      `, { id });
  }
  pointLookup(id) { return this.query('MATCH (node:Person {id: $id}) RETURN node.id, node.category', { id }); }
  filteredLookup(category) { return this.query('MATCH (node:Person {category: $category}) RETURN node.id LIMIT 50', { category }); }
  aggregation() { return this.query('MATCH (node:Person) OPTIONAL MATCH (node)-[:FOLLOWS]->() RETURN node.category AS category, count(*) AS outgoingCount ORDER BY category', {}); }
  writeOperation(id) { return this.query('MERGE (node:BenchmarkWrite {id: $id}) ON CREATE SET node.createdAt = timestamp() RETURN node.id', { id }, neo4j.session.WRITE); }

  async mixedWorkload(ids, clients, operationsPerClient, writeRatio) {
    const startedAt = nowNs(); let operationCount = 0;
    await Promise.all(Array.from({ length: clients }, async (_, client) => {
      for (let index = 0; index < operationsPerClient; index += 1) {
        const id = ids[(client * operationsPerClient + index) % ids.length].id;
        const write = ((client * operationsPerClient + index) % 100) < Math.round(writeRatio * 100);
        if (write) await this.writeOperation(`mixed-${client}-${index}`); else await this.pointLookup(id);
        operationCount += 1;
      }
    }));
    const seconds = elapsedMs(startedAt) / 1000;
    return { operations: operationCount, seconds, qps: operationCount / seconds, clients, writeRatio };
  }

  async runBenchmark(dataset, options) {
    console.log("STEP 1");
    await this.validateConnection();

    console.log("STEP 2");
    if (options.resetDatabase) await this.reset();

    console.log("STEP 3");
    await this.ensureSchema();

    console.log("STEP 4");
    const ingestion = options.resetDatabase ? await this.ingest(dataset) : { skipped: true, reason: 'RESET_DATABASE=false' };
    const inputs = options.parameterSets;
    const workload = (operation, mapper = (node) => node.id) => runLatencyWorkload(operation, inputs.map(mapper), options.warmupIterations, options.measuredIterations);
    console.log("Running 1-hop...");
    const oneHop = await workload((id) => this.traversalQuery(1, id));

    console.log("Running 2-hop...");
    const twoHop = await workload((id) => this.traversalQuery(2, id));

    console.log("Running 3-hop...");
    const threeHop = await workload((id) => this.traversalQuery(3, id));    
    console.log("3-hop completed");
    console.log("Starting point lookup...");
    return {
        platform: this.name,
        generatedAt: new Date().toISOString(),
        dataset: {
            source: dataset.source,
            nodes: dataset.nodes.length,
            relationships: dataset.edges.length
        },
        ingestion,

        traversals: {
            oneHop,
            twoHop,
            threeHop
        },

        lookups: {
            point: await workload((id) => this.pointLookup(id)),
            filtered: await workload(
                (category) => this.filteredLookup(category),
                (node) => node.category
            )
        },

        aggregation: await workload(() => this.aggregation()),

        concurrent: await this.mixedWorkload(
            inputs,
            options.concurrentClients,
            options.concurrentOperationsPerClient,
            options.writeRatio
        ),

        resourceFootprint: {
            status: 'not observable',
            note: 'Managed free tiers do not expose a consistent per-database memory/storage metric through the driver.'
        },

        indexedProperties: ['Person.id', 'Person.category']
    };
  }
}
module.exports = { CypherPlatform, BATCH_SIZE };

