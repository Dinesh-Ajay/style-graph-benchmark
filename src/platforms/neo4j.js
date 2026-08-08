'use strict';
const { CypherPlatform } = require('./base-cypher');
module.exports = () => new CypherPlatform({ name: 'Neo4j AuraDB', uri: process.env.NEO4J_URI, username: process.env.NEO4J_USERNAME, password: process.env.NEO4J_PASSWORD, database: process.env.NEO4J_DATABASE, schemaMode: 'neo4j' });

