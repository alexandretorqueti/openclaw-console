/**
 * Initial migration – creates the core tables used by the OpenClaw Console.
 */
exports.up = (pgm) => {
  // sessions table (canonical record of a chat session)
  pgm.createTable("sessions", {
    key: { type: "text", primaryKey: true },
    agent_id: { type: "text", notNull: true },
    title: { type: "text", notNull: true },
    label: { type: "text" },
    kind: { type: "text", notNull: true, default: "direct" },
    group_id: { type: "text", references: "group_chats(id)" },
    state: { type: "text", notNull: true, default: "unknown" },
    archived: { type: "boolean", notNull: true, default: false },
    pinned: { type: "boolean", notNull: true, default: false },
    model: { type: "text" },
    context_tokens: { type: "integer" },
    total_tokens: { type: "integer" },
    last_message_preview: { type: "text" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    last_activity_at: { type: "timestamptz" },
    meta: { type: "jsonb", notNull: true, default: "{}" },
    project_id: { type: "text", notNull: true, default: "console" }
  });

  // messages table (single table for 1:1 and group chats)
  pgm.createTable("messages", {
    id: { type: "text", primaryKey: true },
    session_key: { type: "text", references: "sessions(key)" },
    group_id: { type: "text", references: "group_chats(id)" },
    role: { type: "text", notNull: true },
    content: { type: "text", notNull: true },
    thinking: { type: "text" },
    author: { type: "text" },
    run_id: { type: "text" },
    status: { type: "text" },
    stop_reason: { type: "text" },
    tool_name: { type: "text" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") }
  });

  // Ensure exactly one of session_key / group_id is set per message
  pgm.addConstraint("messages", "chk_one_parent", "CHECK ((session_key IS NOT NULL) <> (group_id IS NOT NULL))");

  pgm.createIndex("messages", ["session_key", "created_at"]);
  pgm.createIndex("messages", ["group_id", "created_at"]);

  // group related tables
  pgm.createTable("group_chats", {
    id: { type: "text", primaryKey: true },
    name: { type: "text", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    meta: { type: "jsonb", notNull: true, default: "{}" }
  });

  pgm.createTable("group_members", {
    group_id: { type: "text", references: "group_chats(id)", onDelete: "CASCADE", notNull: true },
    agent_id: { type: "text", notNull: true },
    primaryKey: ["group_id", "agent_id"]
  });
};

exports.down = (pgm) => {
  pgm.dropTable("group_members");
  pgm.dropTable("group_chats");
  pgm.dropTable("messages");
  pgm.dropTable("sessions");
};