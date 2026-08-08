'use strict';

const { CypherPlatform } = require('./base-cypher');

/** Neptune Database's unauthenticated/open endpoint protocol. IAM-authenticated
 * endpoints require a SigV4-capable proxy; use a FalkorDB Bolt endpoint or that
 * proxy URL as NEPTUNE_QUERY_URL. No secrets are ever embedded in code. */
class NeptuneHttpPlatform extends CypherPlatform {
  constructor() {
    super({ name: 'Amazon Neptune', uri: 'bolt://placeholder:7687', username: 'placeholder', password: 'placeholder', database: process.env.NEPTUNE_DATABASE, schemaMode: 'neo4j' });
    this.driver = null;
    this.url = process.env.NEPTUNE_QUERY_URL;
    if (!this.url) throw new Error('Set NEPTUNE_QUERY_URL to the Neptune /openCypher endpoint.');
    try { this.headers = JSON.parse(process.env.NEPTUNE_HEADERS_JSON || '{}'); } catch { throw new Error('NEPTUNE_HEADERS_JSON must be valid JSON.'); }
  }
  async validateConnection() {
    await this.query('RETURN 1 AS ok');
  }
  async close() { }
  async query(cypher, params = {}) {
    const body = new URLSearchParams({ query: cypher, parameters: JSON.stringify(params) });
    const response = await fetch(this.url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...this.headers }, body, signal: AbortSignal.timeout(Number(process.env.QUERY_TIMEOUT_MS || 30000)) });
    if (!response.ok) throw new Error(`Neptune openCypher query failed: HTTP ${response.status} ${await response.text()}`);
    return response.json();
  }
}

module.exports = () => {
  if ((process.env.NEPTUNE_MODE || 'http').toLowerCase() === 'bolt') {
    return new CypherPlatform({ name: 'FalkorDB / RedisGraph', uri: process.env.NEPTUNE_URI, username: process.env.NEPTUNE_USERNAME || 'default', password: process.env.NEPTUNE_PASSWORD, database: process.env.NEPTUNE_DATABASE, schemaMode: 'neo4j' });
  }
  return new NeptuneHttpPlatform();
};
