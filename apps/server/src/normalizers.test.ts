import assert from "node:assert/strict";
import test from "node:test";
import { normalizeHistory, normalizeSessions } from "./normalizers.js";

test("derives context percentage and keeps each session model independent", () => {
  const result = normalizeSessions({ sessions: [
    { key: "agent:main:dashboard:a", model: "gpt-5.6-sol", modelProvider: "openai", totalTokens: 51_899, contextTokens: 372_000 },
    { key: "agent:main:dashboard:b", model: "gpt-oss:20b", modelProvider: "ollama", totalTokens: 67_447, contextTokens: 131_072 },
  ] });

  assert.deepEqual(result.sessions.map(({ model, modelProvider, contextPercent }) => ({ model, modelProvider, contextPercent })), [
    { model: "gpt-5.6-sol", modelProvider: "openai", contextPercent: 51_899 / 372_000 * 100 },
    { model: "gpt-oss:20b", modelProvider: "ollama", contextPercent: 67_447 / 131_072 * 100 },
  ]);
});

test("projects tool activity compactly and preserves available thinking", () => {
  const history = normalizeHistory({ messages: [
    { role: "assistant", content: [{ type: "thinking", thinking: "internal" }] },
    { role: "assistant", timestamp: 1, content: [{ type: "thinking", thinking: "internal" }, { type: "toolCall", name: "exec", arguments: { command: "pwd" } }] },
    { role: "toolResult", timestamp: 2, toolName: "exec", isError: false, content: [{ type: "text", text: "/app" }] },
    { role: "toolResult", timestamp: 3, toolName: "read", isError: true, content: [{ type: "text", text: "not found" }] },
    { role: "assistant", timestamp: 4, content: [{ type: "text", text: "Resposta final" }] },
  ] }, "agent:main:test");

  assert.deepEqual(history.messages.map(({ role, toolName, status, content, thinking }) => ({ role, toolName, status, content, thinking })), [
    { role: "assistant", toolName: undefined, status: undefined, content: "", thinking: "internal" },
    { role: "tool", toolName: "exec", status: "requested", content: "exec\n{\n  \"command\": \"pwd\"\n}", thinking: "internal" },
    { role: "tool", toolName: "exec", status: "completed", content: "/app", thinking: undefined },
    { role: "tool", toolName: "read", status: "error", content: "not found", thinking: undefined },
    { role: "assistant", toolName: undefined, status: undefined, content: "Resposta final", thinking: undefined },
  ]);
});

test("preserves cursor metadata for infinite session pagination", () => {
  const result = normalizeSessions({ sessions: [{ key: "agent:main:a" }], count: 1, totalCount: 73, hasMore: true, nextOffset: 10 });
  assert.deepEqual({ count: result.count, totalCount: result.totalCount, hasMore: result.hasMore, nextOffset: result.nextOffset }, { count: 1, totalCount: 73, hasMore: true, nextOffset: 10 });
});

test("prefers a supplied percentage and clamps it to the contract range", () => {
  const result = normalizeSessions({ sessions: [
    { key: "agent:main:dashboard:a", contextPercent: 125, totalTokens: 1, contextTokens: 100 },
  ] });
  assert.equal(result.sessions[0]?.contextPercent, 100);
});

test("new sessions start with zero context instead of an unknown percentage", () => {
  const result = normalizeSessions({ sessions: [{ key: "agent:main:dashboard:new" }] });
  assert.equal(result.sessions[0]?.contextPercent, 0);
});

test("session key is authoritative for the owning agent", () => {
  const result = normalizeSessions({ sessions: [{ key: "agent:programador-senior:subagent:abc", agentId: "main" }] });
  assert.equal(result.sessions[0]?.agentId, "programador-senior");
});
