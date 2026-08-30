-- 生成自各 PostgreSQL 插件的建表语句，与代码保持一致。
-- DeepSeek Harness —— 应用所需的全部对象
-- 把 <schema> 换成该应用的 schema 名（由 deployment.appName 折叠而来：
-- order-svc -> order_svc）。每个应用一个 schema，不可共用。

CREATE SCHEMA IF NOT EXISTS <schema>;

-- ── 会话 ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS <schema>.session (
  id         text        PRIMARY KEY,
  meta       jsonb       NOT NULL,
  revision   bigint      NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS <schema>.session_event (
  session_id text    NOT NULL
    REFERENCES <schema>.session (id) ON DELETE CASCADE,
  seq        integer NOT NULL,
  event      jsonb   NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE INDEX IF NOT EXISTS session_created_at_idx
  ON <schema>.session (created_at);

-- ── 存储 ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS <schema>.kv_unit (
  unit    text    PRIMARY KEY,
  version integer NOT NULL
);

CREATE TABLE IF NOT EXISTS <schema>.kv_record (
  unit  text  NOT NULL,
  tbl   text  NOT NULL,
  key   text  NOT NULL,
  value jsonb NOT NULL,
  PRIMARY KEY (unit, tbl, key)
);

CREATE TABLE IF NOT EXISTS <schema>.kv_global (
  unit  text  PRIMARY KEY,
  value jsonb NOT NULL
);

-- ── 附件 ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS <schema>.attachment_object (
  sha256     text        PRIMARY KEY,
  media_type text        NOT NULL,
  bytes      integer     NOT NULL,
  width      integer     NOT NULL,
  height     integer     NOT NULL,
  data       bytea       NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── 应用角色：只给 DML，不给 DDL ──────────────────────────────────────────
GRANT USAGE ON SCHEMA <schema> TO <app_role>;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA <schema> TO <app_role>;
