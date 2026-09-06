-- DeepSeek Harness —— OceanBase（MySQL 模式）/ MySQL 建表脚本
--
-- 与各 MySQL 插件代码中的 CREATE TABLE 保持一致。生产环境的应用角色通常只有
-- DML 权限，插件启动时会先探测这些表；表齐全就跳过建表，缺表才尝试创建（并因
-- 无权限而明确失败）。所以这份脚本由 DBA 执行一次即可。
--
-- 每张表使用应用生成的 bigint 雪花主键和统一审计列；原业务键由唯一索引约束。
-- app 区分应用，user_id 区分会话/附件的用户。没有用户信息时使用 '-'。
-- 标识符按 utf8mb4_bin 比较，不合并大小写不同的应用或用户。
-- 本脚本用于新库。已有旧表不会自动升级，应用会拒绝不兼容的表结构。
--
-- app 的取值来自应用的 deployment.appName（或 DSH_APP_NAME），原样存储，不做
-- 大小写或分隔符折叠：order-svc 和 Order Service 是两个应用。

CREATE DATABASE IF NOT EXISTS dsh DEFAULT CHARACTER SET utf8mb4;
USE dsh;

-- ── 会话 ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dsh_session (
  id           bigint      NOT NULL COMMENT '雪花主键',
  is_deleted   char(1)     NOT NULL DEFAULT 'N' COMMENT '是否删除，默认N',
  creator      varchar(32) NOT NULL COMMENT '创建者',
  gmt_created  datetime    NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  modifier     varchar(32) NOT NULL COMMENT '更新者',
  gmt_modified datetime    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '修改时间',
  app        varchar(64)  NOT NULL,
  session_id varchar(128) NOT NULL,
  user_id    varchar(32)  NOT NULL DEFAULT '-' COMMENT '所属用户',
  meta       json         NOT NULL,
  revision   bigint       NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY dsh_session_identity_uk (app, session_id),
  KEY dsh_session_owner_idx (app, user_id, is_deleted, gmt_created)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS dsh_session_event (
  id           bigint      NOT NULL COMMENT '雪花主键',
  is_deleted   char(1)     NOT NULL DEFAULT 'N' COMMENT '是否删除，默认N',
  creator      varchar(32) NOT NULL COMMENT '创建者',
  gmt_created  datetime    NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  modifier     varchar(32) NOT NULL COMMENT '更新者',
  gmt_modified datetime    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '修改时间',
  app        varchar(64)  NOT NULL,
  session_id varchar(128) NOT NULL,
  user_id    varchar(32)  NOT NULL DEFAULT '-' COMMENT '所属用户',
  seq        int          NOT NULL,
  event      json         NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY dsh_session_event_sequence_uk (app, session_id, seq),
  CONSTRAINT dsh_session_event_session_fk FOREIGN KEY (app, session_id)
    REFERENCES dsh_session (app, session_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ── 存储（KV） ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dsh_kv_unit (
  id           bigint      NOT NULL COMMENT '雪花主键',
  is_deleted   char(1)     NOT NULL DEFAULT 'N' COMMENT '是否删除，默认N',
  creator      varchar(32) NOT NULL COMMENT '创建者',
  gmt_created  datetime    NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  modifier     varchar(32) NOT NULL COMMENT '更新者',
  gmt_modified datetime    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '修改时间',
  app     varchar(64)  NOT NULL,
  unit    varchar(128) NOT NULL,
  version int          NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY dsh_kv_unit_identity_uk (app, unit)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- key 是 MySQL 保留字，列名用 key_name。
CREATE TABLE IF NOT EXISTS dsh_kv_record (
  id           bigint      NOT NULL COMMENT '雪花主键',
  is_deleted   char(1)     NOT NULL DEFAULT 'N' COMMENT '是否删除，默认N',
  creator      varchar(32) NOT NULL COMMENT '创建者',
  gmt_created  datetime    NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  modifier     varchar(32) NOT NULL COMMENT '更新者',
  gmt_modified datetime    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '修改时间',
  app      varchar(64)  NOT NULL,
  unit     varchar(128) NOT NULL,
  tbl      varchar(128) NOT NULL,
  key_name varchar(255) NOT NULL,
  value    json         NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY dsh_kv_record_identity_uk (app, unit, tbl, key_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS dsh_kv_global (
  id           bigint      NOT NULL COMMENT '雪花主键',
  is_deleted   char(1)     NOT NULL DEFAULT 'N' COMMENT '是否删除，默认N',
  creator      varchar(32) NOT NULL COMMENT '创建者',
  gmt_created  datetime    NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  modifier     varchar(32) NOT NULL COMMENT '更新者',
  gmt_modified datetime    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '修改时间',
  app   varchar(64)  NOT NULL,
  unit  varchar(128) NOT NULL,
  value json         NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY dsh_kv_global_identity_uk (app, unit)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ── 附件 ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dsh_attachment_object (
  id           bigint      NOT NULL COMMENT '雪花主键',
  is_deleted   char(1)     NOT NULL DEFAULT 'N' COMMENT '是否删除，默认N',
  creator      varchar(32) NOT NULL COMMENT '创建者',
  gmt_created  datetime    NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  modifier     varchar(32) NOT NULL COMMENT '更新者',
  gmt_modified datetime    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '修改时间',
  app        varchar(64)  NOT NULL,
  user_id    varchar(32)  NOT NULL DEFAULT '-' COMMENT '所属用户',
  sha256     varchar(64)  NOT NULL,
  media_type varchar(64)  NOT NULL,
  bytes      int          NOT NULL,
  width      int          NOT NULL,
  height     int          NOT NULL,
  data       longblob     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY dsh_attachment_object_identity_uk (app, user_id, sha256)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ── 应用账号：只给 DML，不给 DDL ──────────────────────────────────────────
-- 把 <app_user> / <app_password> 换成实际值。OceanBase 的用户名在连接串里写作
-- user@tenant（例如 dsh@test），但 GRANT 语句里只写用户名本身。
--
-- CREATE USER IF NOT EXISTS '<app_user>' IDENTIFIED BY '<app_password>';
-- GRANT SELECT, INSERT, UPDATE, DELETE ON dsh.* TO '<app_user>';
