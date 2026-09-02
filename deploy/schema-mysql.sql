-- DeepSeek Harness —— OceanBase（MySQL 模式）/ MySQL 建表脚本
--
-- 与各 MySQL 插件代码中的 CREATE TABLE 保持一致。生产环境的应用角色通常只有
-- DML 权限，插件启动时会先探测这些表；表齐全就跳过建表，缺表才尝试创建（并因
-- 无权限而明确失败）。所以这份脚本由 DBA 执行一次即可。
--
-- 与 PostgreSQL 版本的两点差异：
--   1. 所有表名统一带 dsh_ 前缀，避免与库中其它业务表重名。
--   2. MySQL 的 schema 就是 database，没有库内命名空间，因此“区分应用”不再靠
--      每个应用一个 schema，而是每张表的第一主键列 app。多个应用共用同一套表、
--      同一个连接池，互不覆盖；运维用 WHERE app = '...' 就能读某个应用的数据。
--
-- app 的取值来自应用的 deployment.appName（或 DSH_APP_NAME），原样存储，不做
-- 大小写或分隔符折叠：order-svc 和 Order Service 是两个应用。

CREATE DATABASE IF NOT EXISTS dsh DEFAULT CHARACTER SET utf8mb4;
USE dsh;

-- ── 会话 ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dsh_session (
  app        varchar(64)  NOT NULL,
  id         varchar(128) NOT NULL,
  meta       json         NOT NULL,
  revision   bigint       NOT NULL DEFAULT 0,
  created_at timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (app, id),
  KEY dsh_session_created_at_idx (app, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS dsh_session_event (
  app        varchar(64)  NOT NULL,
  session_id varchar(128) NOT NULL,
  seq        int          NOT NULL,
  event      json         NOT NULL,
  PRIMARY KEY (app, session_id, seq),
  CONSTRAINT dsh_session_event_session_fk FOREIGN KEY (app, session_id)
    REFERENCES dsh_session (app, id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── 存储（KV） ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dsh_kv_unit (
  app     varchar(64)  NOT NULL,
  unit    varchar(128) NOT NULL,
  version int          NOT NULL,
  PRIMARY KEY (app, unit)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- key 是 MySQL 保留字，列名用 key_name。
CREATE TABLE IF NOT EXISTS dsh_kv_record (
  app      varchar(64)  NOT NULL,
  unit     varchar(128) NOT NULL,
  tbl      varchar(128) NOT NULL,
  key_name varchar(255) NOT NULL,
  value    json         NOT NULL,
  PRIMARY KEY (app, unit, tbl, key_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS dsh_kv_global (
  app   varchar(64)  NOT NULL,
  unit  varchar(128) NOT NULL,
  value json         NOT NULL,
  PRIMARY KEY (app, unit)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── 附件 ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dsh_attachment_object (
  app        varchar(64)  NOT NULL,
  sha256     varchar(64)  NOT NULL,
  media_type varchar(64)  NOT NULL,
  bytes      int          NOT NULL,
  width      int          NOT NULL,
  height     int          NOT NULL,
  data       longblob     NOT NULL,
  created_at timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (app, sha256)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── 应用账号：只给 DML，不给 DDL ──────────────────────────────────────────
-- 把 <app_user> / <app_password> 换成实际值。OceanBase 的用户名在连接串里写作
-- user@tenant（例如 dsh@test），但 GRANT 语句里只写用户名本身。
--
-- CREATE USER IF NOT EXISTS '<app_user>' IDENTIFIED BY '<app_password>';
-- GRANT SELECT, INSERT, UPDATE, DELETE ON dsh.* TO '<app_user>';
