import assert from "node:assert/strict";
import test from "node:test";
import { normalizeChatEvent, normalizeHistory, normalizeMessage, normalizeSessions, record } from "./normalizers.js";

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
    { id: "message-1", role: "assistant", content: [{ type: "thinking", thinking: "internal" }] },
    { id: "message-2", role: "assistant", timestamp: 1, content: [{ type: "thinking", thinking: "internal" }, { type: "toolCall", name: "exec", arguments: { command: "pwd" } }] },
    { id: "message-3", role: "toolResult", timestamp: 2, toolName: "exec", isError: false, content: [{ type: "text", text: "/app" }] },
    { id: "message-4", role: "toolResult", timestamp: 3, toolName: "read", isError: true, content: [{ type: "text", text: "not found" }] },
    { id: "message-5", role: "assistant", timestamp: 4, content: [{ type: "text", text: "Resposta final" }] },
  ] }, "agent:main:test");

  assert.deepEqual(history.messages.map(({ role, toolName, status, content, thinking }) => ({ role, toolName, status, content, thinking })), [
    { role: "assistant", toolName: undefined, status: undefined, content: "", thinking: "internal" },
    { role: "tool", toolName: "exec", status: "requested", content: "exec\n{\n  \"command\": \"pwd\"\n}", thinking: "internal" },
    { role: "tool", toolName: "exec", status: "completed", content: "/app", thinking: undefined },
    { role: "tool", toolName: "read", status: "error", content: "not found", thinking: undefined },
    { role: "assistant", toolName: undefined, status: undefined, content: "Resposta final", thinking: undefined },
  ]);
});

test("preserves the Gateway message id used to retrieve truncated history entries", () => {
  const sessionKey = "agent:main:test";
  const history = normalizeHistory({ messages: [
    { id: "gateway-message-123", role: "assistant", content: "...(truncated)..." },
  ] }, sessionKey);

  assert.equal(history.messages[0]?.id, "gateway-message-123");
});

test("accepts every Gateway message-id shape without synthesizing a replacement", () => {
  const sessionKey = "agent:main:test";
  const cases = [
    [{ id: "row-id", role: "assistant", content: "a" }, "row-id"],
    [{ messageId: "row-message-id", role: "assistant", content: "a" }, "row-message-id"],
    [{ message_id: "row-message-id-snake", role: "assistant", content: "a" }, "row-message-id-snake"],
    [{ message: { id: "nested-id", role: "assistant", content: "a" } }, "nested-id"],
    [{ message: { messageId: "nested-message-id", role: "assistant", content: "a" } }, "nested-message-id"],
  ] as const;

  for (const [payload, expectedId] of cases) {
    assert.equal(normalizeHistory({ messages: [payload] }, sessionKey).messages[0]?.id, expectedId);
  }
  assert.deepEqual(normalizeHistory({ messages: [{ role: "assistant", content: "a" }] }, sessionKey).messages, []);
});

test("uses the same Gateway id for history and full-message responses", () => {
  const sessionKey = "agent:main:test";
  const history = normalizeHistory({ messages: [
    { message_id: "gateway-message-123", role: "assistant", content: "...(truncated)..." },
  ] }, sessionKey);
  const complete = normalizeMessage({ message: {
    messageId: "gateway-message-123", role: "assistant", content: "A mensagem integral retornada pelo Gateway.",
  } });

  assert.equal(history.messages[0]?.id, "gateway-message-123");
  assert.equal(complete?.id, history.messages[0]?.id);
  assert.equal(complete?.content, "A mensagem integral retornada pelo Gateway.");
});

test("Gateway history ids retrieve the matching complete message", async () => {
  const sessionKey = "agent:main:test";
  let requestedMessageId: string | undefined;
  const rpc = async (method: string, params: Record<string, unknown>) => {
    if (method === "chat.history") {
      assert.equal(params.sessionKey, sessionKey);
      return { messages: [{ messageId: "gateway-message-123", role: "assistant", content: "...(truncated)..." }] };
    }
    assert.equal(method, "chat.message.get");
    assert.equal(params.sessionKey, sessionKey);
    requestedMessageId = typeof params.messageId === "string" ? params.messageId : undefined;
    return { ok: true, message: { id: "gateway-message-123", role: "assistant", content: "A mensagem integral retornada pelo Gateway." } };
  };

  const history = normalizeHistory(await rpc("chat.history", { sessionKey }), sessionKey);
  const messageId = history.messages[0]?.id;
  assert.equal(messageId, "gateway-message-123");
  const detail = record(await rpc("chat.message.get", { sessionKey, messageId }));
  const complete = normalizeMessage(detail.message);

  assert.equal(requestedMessageId, messageId);
  assert.equal(complete?.id, messageId);
  assert.equal(complete?.content, "A mensagem integral retornada pelo Gateway.");
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

test("SSE chat events preserve the run lifecycle fields required by the motor", () => {
  const final = normalizeChatEvent({
    type: "event",
    event: "chat",
    seq: 12,
    payload: {
      state: "final",
      runId: "run-final",
      sessionKey: "agent:main:motor",
      stopReason: "completed",
      message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
    },
  });
  assert.equal(final?.state, "final");
  assert.deepEqual(final && final.state === "final" && { state: final.state, runId: final.runId, sessionKey: final.sessionKey, stopReason: final.stopReason }, {
    state: "final",
    runId: "run-final",
    sessionKey: "agent:main:motor",
    stopReason: "completed",
  });

  const error = normalizeChatEvent({
    type: "event",
    event: "chat",
    payload: {
      state: "error",
      runId: "run-error",
      sessionKey: "agent:main:motor",
      stopReason: "failed",
      errorMessage: "model unavailable",
    },
  });
  assert.equal(error?.state, "error");
  assert.deepEqual(error && error.state === "error" && { state: error.state, runId: error.runId, sessionKey: error.sessionKey, stopReason: error.stopReason, errorMessage: error.errorMessage }, {
    state: "error",
    runId: "run-error",
    sessionKey: "agent:main:motor",
    stopReason: "failed",
    errorMessage: "model unavailable",
  });
});
