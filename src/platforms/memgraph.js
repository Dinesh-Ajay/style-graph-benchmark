'use strict';
const { CypherPlatform } = require('./base-cypher');
module.exports = () => new CypherPlatform({ name: 'Memgraph Cloud', uri: process.env.MEMGRAPH_URI, username: process.env.MEMGRAPH_USERNAME, password: process.env.MEMGRAPH_PASSWORD, database: process.env.MEMGRAPH_DATABASE, schemaMode: 'memgraph' });
