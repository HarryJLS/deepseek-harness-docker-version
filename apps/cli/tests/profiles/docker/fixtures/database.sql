-- Disposable test-tenant credentials; application processes receive no DDL grants.
CREATE USER IF NOT EXISTS 'dsh_test' IDENTIFIED BY 'dsh-test-only';
GRANT SELECT, INSERT, UPDATE, DELETE ON dsh.* TO 'dsh_test';

USE dsh;
INSERT INTO dsh_session (id, is_deleted, creator, gmt_created, modifier, gmt_modified, app, session_id, user_id, meta, revision)
VALUES (1, 'N', 'fixture', CURRENT_TIMESTAMP, 'fixture', CURRENT_TIMESTAMP, 'archive-v0', 'retained-session', 'alice',
  '{"version":0,"id":"retained-session","userId":"alice","createdAt":1,"delegationDepth":0}', 1);
INSERT INTO dsh_session_event (id, is_deleted, creator, gmt_created, modifier, gmt_modified, app, session_id, user_id, seq, event)
VALUES (2, 'N', 'fixture', CURRENT_TIMESTAMP, 'fixture', CURRENT_TIMESTAMP, 'archive-v0', 'retained-session', 'alice', 0,
  '{"type":"turn/start","seq":0,"time":1,"data":{"turn":1}}');
INSERT INTO dsh_kv_global (id, is_deleted, creator, gmt_created, modifier, gmt_modified, app, unit, value)
VALUES (3, 'N', 'fixture', CURRENT_TIMESTAMP, 'fixture', CURRENT_TIMESTAMP, 'archive-v0', 'retained_settings', '{"retained":true}');
