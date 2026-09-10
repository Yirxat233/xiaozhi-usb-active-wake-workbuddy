const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write("2.test.0\n");
  process.exit(0);
}

const resumedAt = args.indexOf("--resume");
const sessionId = resumedAt >= 0 ? args[resumedAt + 1] : "fake-session-1";
const prompt = args.at(-1);
const result = resumedAt >= 0
  ? `FAKE-RESUMED:${sessionId}:${prompt}`
  : prompt === "ASK_FOR_INPUT" ? "请选择数字 1 或 2，请回复 1 或 2。" : `FAKE:${prompt}`;

process.stdout.write(`${JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: sessionId,
  cwd: process.cwd(),
})}\n`);

setTimeout(() => {
  process.stdout.write(`${JSON.stringify({
    type: "assistant",
    session_id: sessionId,
    message: { content: [{ type: "text", text: result }] },
  })}\n`);
  process.stdout.write(`${JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result,
    session_id: sessionId,
  })}\n`);
}, 15);
