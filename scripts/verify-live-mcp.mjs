import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const client = new Client({ name: 'local-integration-check', version: '1.0.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:8787/mcp')));
  const tools = await client.listTools();
  const projects = await client.callTool({ name: 'workbuddy_list_projects', arguments: {} });
  if (projects.isError) throw new Error('WorkBuddy project query failed');
  console.log(JSON.stringify({ toolCount: tools.tools.length, projectCount: projects.structuredContent?.data?.length }));
  const deadline = Date.now() + 120000;
  let idle = false;
  while (Date.now() < deadline) {
    const health = await (await fetch('http://127.0.0.1:8787/health')).json();
    if (health.deviceState === 'idle') { idle = true; break; }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  if (!idle) throw new Error('Device remained busy; speech test skipped');
  const speech = await client.callTool({ name: 'xiaozhi_speak', arguments: { text: 'MCP 主动播报测试完成。' } });
  const accepted = speech.structuredContent?.data?.accepted;
  console.log(JSON.stringify({ mcpSpeechAccepted: accepted, isError: Boolean(speech.isError) }));
  if (speech.isError || accepted !== true) process.exitCode = 1;
} finally {
  await client.close();
}
