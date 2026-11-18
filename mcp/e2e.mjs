// End-to-end: plays the agent. Spawns the bundled MCP server over stdio and drives a live page.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "e2e", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [new URL("../claude-plugin/server/typemark-mcp.mjs", import.meta.url).pathname] }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  console.log(`\n=== ${name}${r.isError ? " (ERROR)" : ""}\n${text.slice(0, 700)}`);
  return { r, text };
};
const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));
for (let i = 0; i < 20; i++) {
  const { text } = await call("list_documents");
  if (text.includes('"doc_id"')) break;
  await new Promise((r) => setTimeout(r, 1000));
}
await call("read_document");
await call("suggest_edit", { quote: "There are no formatting buttons, because you never need them.", replacement: "There are no formatting buttons: you never need them.", reason: "Tighter (e2e)." });
await call("add_note", { quote: "plain markdown", kind: "question", body: "Is **GFM** the dialect? (e2e)" });
await call("set_marks", { source: "e2e", marks: [{ quote: "seamless", severity: "style", message: "e2e mark" }] });
await call("get_thread", { quote: "plain markdown" });
await call("add_note", { quote: "definitely not in the document", kind: "info", body: "x" });
await call("wait_for_activity", { timeout_seconds: 1 }); // drain "connected"
console.log("\n>>> waiting for writer activity (type in the page now)");
const { text } = await call("wait_for_activity", { timeout_seconds: 60 });
const unitId = text.match(/"id": "(b\d+)"/)?.[1];
if (unitId) await call("reply_in_thread", { unit_id: unitId, body: "Reviewed your new block (e2e)." });
await client.close();
