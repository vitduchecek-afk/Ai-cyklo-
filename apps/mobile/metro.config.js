// Metro config for the pnpm monorepo (node-linker=hoisted).
// Workspace packages under ../../packages ship TypeScript sources via
// "main": "src/index.ts"; they are symlinked into the hoisted node_modules, so
// Metro resolves them once the packages directory is watched.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [...new Set([...(config.watchFolders ?? []), path.join(workspaceRoot, 'packages')])];
config.resolver.nodeModulesPaths = [
  path.join(projectRoot, 'node_modules'),
  path.join(workspaceRoot, 'node_modules'),
];
// sql.js WebAssembly binary (web SQLite).
if (!config.resolver.assetExts.includes('wasm')) config.resolver.assetExts.push('wasm');

module.exports = config;
