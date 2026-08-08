'use strict';
const { CypherPlatform } = require('./base-cypher');
module.exports = () => new CypherPlatform({ name: 'CognoDB Cloud', uri: process.env.COGNODB_URI, username: process.env.COGNODB_USERNAME, password: process.env.COGNODB_PASSWORD, database: process.env.COGNODB_DATABASE, schemaMode: 'neo4j' });

