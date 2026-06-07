#!/usr/bin/env node
/**
 * Monet Installation Guide
 *
 * Usage: npx @team-monet/monet install
 *
 * This outputs installation instructions you can share with your AI agent.
 */

import path from 'node:path';
import os from 'node:os';

// Formatting
const MARKERS = {
  success: '✓',
  step: '▶',
  section: '━',
};

function log(message = '') {
  console.log(message);
}

function section(title) {
  log('');
  log(MARKERS.section.repeat(50));
  log(title);
  log(MARKERS.section.repeat(50));
  log('');
}

function step(num, title) {
  log(`${MARKERS.step} Step ${num}: ${title}`);
  log('');
}

function code(content) {
  log(content);
  log('');
}

// Get platform-specific paths
function getClaudeCodePath() {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function getCursorPath() {
  return path.join(process.cwd(), '.cursorrules');
}

function getHermesPath() {
  return path.join(os.homedir(), '.hermes', 'config.yaml');
}

// Generate configs
function getClaudeCodeConfig() {
  const monetPath = path.join(process.cwd(), 'node_modules', '@monet', 'local', 'dist', 'index.js');
  return JSON.stringify({
    mcpServers: {
      'monet': {
        command: 'node',
        args: [monetPath],
        env: { MONET_STORAGE_DIR: '.monet' },
      },
    },
  }, null, 2);
}

function getCursorConfig() {
  const monetPath = path.join(process.cwd(), 'node_modules', '@monet', 'local', 'dist', 'index.js');
  return JSON.stringify({
    mcp_servers: {
      Monet: {
        command: 'node',
        args: [monetPath],
        env: { MONET_STORAGE_DIR: '.monet' },
      },
    },
  }, null, 2);
}

function getHermesConfig() {
  const monetPath = path.join(process.cwd(), 'node_modules', '@monet', 'local', 'dist', 'index.js');
  return `mcp_servers:
  monet:
    command: node
    args:
      - ${monetPath.replace(/\\/g, '/')}
    env:
      MONET_STORAGE_DIR: .monet`;
}

// Main installation guide
function main() {
  section('MONET LOCAL - Installation Guide');

  log('Share the following instructions with your AI agent:');
  log();

  step(1, 'Install Dependencies');
  log('Run this command in your project directory:');
  code('npm install @team-monet/monet better-sqlite3');

  step(2, 'Configure MCP Server');
  log('Choose your AI coding agent and add the config below:');

  log(`${MARKERS.success} Claude Code (${getClaudeCodePath()}):`);
  code(getClaudeCodeConfig());

  log(`${MARKERS.success} Cursor (${getCursorPath()}):`);
  code(getCursorConfig());

  log(`${MARKERS.success} Hermes Agent (${getHermesPath()}):`);
  code(getHermesConfig());

  log(`${MARKERS.success} OpenClaw:`);
  code('openclaw skill install node_modules/@team-monet/monet/dist/index.js');

  log(`${MARKERS.success} Other MCP-compatible agents:`);
  log('Use this generic config:');
  code(JSON.stringify({
    command: 'node',
    args: ['node_modules/@team-monet/monet/dist/index.js'],
    env: { MONET_STORAGE_DIR: '.monet' },
  }, null, 2));

  step(3, 'Initialize Database');
  log('The database will be created automatically on first run at:');
  code('./.monet/monet.db');

  step(4, 'Restart Your Agent');
  log('Restart your AI coding agent to load the MCP server.');
  log();

  section('Verification');
  log('After restarting, try these prompts in your agent:');
  code('"Remember that I prefer TypeScript for type definitions"');
  code('"What do you remember about my preferences?"');
  log();

  section('Need Help?');
  log('Documentation: https://github.com/anthropics/monet/docs/local');
  log('Issues: https://github.com/anthropics/monet/issues');
  log();
  log('⭐ If Monet is helpful, please star us on GitHub!');
  log('   https://github.com/anthropics/monet');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { main };
