"""Disable credentials, public join capabilities, mail and temporary jobs in an offline restore."""
import sqlite3
import sys

connection = sqlite3.connect(sys.argv[1])
tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
with connection:
    for table in ("sessions", "login_tokens", "email_changes", "captured_emails", "join_signups"):
        if table in tables:
            connection.execute('DELETE FROM "' + table + '"')
    connection.execute("UPDATE groups SET paused=1")
    connection.execute("UPDATE email_outbox SET state='skipped',payload=NULL,error_code='isolated_restore'")
    if "group_join_links" in tables:
        connection.execute("UPDATE group_join_links SET enabled=0,token_ciphertext=NULL")
    if "exports" in tables:
        connection.execute("UPDATE exports SET state='expired',expires_at=0")
    assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
    assert connection.execute("SELECT COUNT(*) FROM email_outbox WHERE state IN ('queued','sending')").fetchone()[0] == 0
connection.close()
