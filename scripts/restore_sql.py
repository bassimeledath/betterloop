"""Write sanitized SQLite recovery data in D1 foreign-key dependency order."""
import sqlite3
import sys

connection = sqlite3.connect(sys.argv[1])
statements = list(connection.iterdump())
tables = [row[0] for row in connection.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
)]
remaining = set(tables)
ordered = []
while remaining:
    ready = sorted(name for name in remaining if not {
        row[2] for row in connection.execute(
            'PRAGMA foreign_key_list("' + name.replace('"', '""') + '")'
        ) if row[2] != name
    }.intersection(remaining))
    if not ready:
        raise RuntimeError("Recovery schema contains a foreign-key cycle")
    ordered.extend(ready)
    remaining.difference_update(ready)

ddl = [statement for statement in statements if statement.startswith('CREATE TABLE')]
inserts = [statement for name in ordered for statement in statements
           if statement.startswith('INSERT INTO "' + name + '"')]
other = [statement for statement in statements
         if statement.startswith(('CREATE INDEX', 'CREATE UNIQUE INDEX', 'CREATE TRIGGER'))]
with open(sys.argv[2], 'w') as output:
    output.write('\n'.join(ddl + inserts + other) + '\n')
