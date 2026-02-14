#!/usr/bin/env npx tsx
// Smoke test: start → interact → finish a capture session via MCP stdio
// Usage: npx tsx test/smoke/capture-mcp-smoke.ts

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const TARGET_URL = 'https://httpbin.org';

async function main() {
  console.log('Starting MCP server via stdio...');
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['--import', 'tsx', 'src/mcp.ts'],
  });

  const client = new Client({ name: 'smoke-test', version: '1.0.0' });
  await client.connect(transport);

  // List tools
  const { tools } = await client.listTools();
  console.log(`Tools available: ${tools.map(t => t.name).join(', ')}`);

  // Step 1: Start capture session
  console.log(`\n--- Step 1: apitap_capture_start (${TARGET_URL}) ---`);
  const startResult = await client.callTool({
    name: 'apitap_capture_start',
    arguments: { url: TARGET_URL, headless: true },
  });
  const startData = JSON.parse((startResult.content as any)[0].text);
  const sessionId = startData.sessionId;
  console.log(`Session ID: ${sessionId}`);
  console.log(`Page title: ${startData.snapshot.title}`);
  console.log(`Elements: ${startData.snapshot.elements.length}`);
  console.log(`Endpoints captured: ${startData.snapshot.endpointsCaptured}`);
  console.log(`Sample elements:`, startData.snapshot.elements.slice(0, 5).map((e: any) => `${e.ref}: <${e.tag}> ${e.text || e.placeholder || e.href || ''}`));

  // Step 2: Get a snapshot
  console.log(`\n--- Step 2: apitap_capture_interact (snapshot) ---`);
  const snapResult = await client.callTool({
    name: 'apitap_capture_interact',
    arguments: { sessionId, action: 'snapshot' },
  });
  const snapData = JSON.parse((snapResult.content as any)[0].text);
  console.log(`Snapshot success: ${snapData.success}`);
  console.log(`Endpoints: ${snapData.snapshot.endpointsCaptured}`);

  // Step 3: Navigate to a page that triggers API calls
  console.log(`\n--- Step 3: apitap_capture_interact (navigate to /get) ---`);
  const navResult = await client.callTool({
    name: 'apitap_capture_interact',
    arguments: { sessionId, action: 'navigate', url: `${TARGET_URL}/get?foo=bar&test=123` },
  });
  const navData = JSON.parse((navResult.content as any)[0].text);
  console.log(`Navigate success: ${navData.success}`);
  console.log(`URL: ${navData.snapshot.url}`);
  console.log(`Endpoints captured: ${navData.snapshot.endpointsCaptured}`);
  console.log(`Recent endpoints: ${navData.snapshot.recentEndpoints}`);

  // Step 4: Navigate to another endpoint
  console.log(`\n--- Step 4: apitap_capture_interact (navigate to /headers) ---`);
  const nav2Result = await client.callTool({
    name: 'apitap_capture_interact',
    arguments: { sessionId, action: 'navigate', url: `${TARGET_URL}/headers` },
  });
  const nav2Data = JSON.parse((nav2Result.content as any)[0].text);
  console.log(`Navigate success: ${nav2Data.success}`);
  console.log(`Endpoints captured: ${nav2Data.snapshot.endpointsCaptured}`);
  console.log(`Recent endpoints: ${nav2Data.snapshot.recentEndpoints}`);

  // Step 5: Scroll
  console.log(`\n--- Step 5: apitap_capture_interact (scroll down) ---`);
  const scrollResult = await client.callTool({
    name: 'apitap_capture_interact',
    arguments: { sessionId, action: 'scroll', direction: 'down' },
  });
  const scrollData = JSON.parse((scrollResult.content as any)[0].text);
  console.log(`Scroll success: ${scrollData.success}`);

  // Step 6: Wait
  console.log(`\n--- Step 6: apitap_capture_interact (wait 2s) ---`);
  const waitResult = await client.callTool({
    name: 'apitap_capture_interact',
    arguments: { sessionId, action: 'wait', seconds: 2 },
  });
  const waitData = JSON.parse((waitResult.content as any)[0].text);
  console.log(`Wait success: ${waitData.success}`);
  console.log(`Endpoints after wait: ${waitData.snapshot.endpointsCaptured}`);

  // Step 7: Finish — save skill files
  console.log(`\n--- Step 7: apitap_capture_finish ---`);
  const finishResult = await client.callTool({
    name: 'apitap_capture_finish',
    arguments: { sessionId },
  });
  const finishData = JSON.parse((finishResult.content as any)[0].text);
  console.log(`Aborted: ${finishData.aborted}`);
  console.log(`Domains: ${finishData.domains.length}`);
  for (const d of finishData.domains) {
    console.log(`  ${d.domain}: ${d.endpointCount} endpoints, tiers: ${JSON.stringify(d.tiers)}, file: ${d.skillFile}`);
  }

  // Done
  console.log(`\n=== Smoke test complete ===`);
  console.log(`Captured ${finishData.domains.reduce((n: number, d: any) => n + d.endpointCount, 0)} endpoints across ${finishData.domains.length} domain(s)`);

  await client.close();
  process.exit(0);
}

main().catch(err => {
  console.error('Smoke test failed:', err);
  process.exit(1);
});
