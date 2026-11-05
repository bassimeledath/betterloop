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
def identifier(name):
    return '"' + name.replace('"', '""') + '"'

inserts = []
for name in ordered:
    columns = [row[1] for row in connection.execute('PRAGMA table_info(' + identifier(name) + ')')]
    for row in connection.execute('SELECT rowid,* FROM ' + identifier(name)):
        rid, values = row[0], row[1:]
        literals, large = [], []
        for column, value in zip(columns, values):
            if isinstance(value, bytes) and len(value) > 12000:
                literals.append('zeroblob(' + str(len(value)) + ')')
                large.append((column, value))
            else:
                literals.append(connection.execute('SELECT quote(?)', (value,)).fetchone()[0])
        inserts.append('INSERT INTO ' + identifier(name) + '(rowid,' + ','.join(map(identifier, columns)) + ') VALUES(' + str(rid) + ',' + ','.join(literals) + ');')
        for column, value in large:
            quoted = identifier(column)
            for offset in range(0, len(value), 12000):
                chunk = value[offset:offset + 12000]
                inserts.append('UPDATE ' + identifier(name) + ' SET ' + quoted + '=CAST(substr(' + quoted + ',1,' + str(offset) + ")||X'" + chunk.hex() + "'||substr(" + quoted + ',' + str(offset + len(chunk) + 1) + ') AS BLOB) WHERE rowid=' + str(rid) + ';')
other = [statement for statement in statements
         if statement.startswith(('CREATE INDEX', 'CREATE UNIQUE INDEX', 'CREATE TRIGGER'))]
with open(sys.argv[2], 'w') as output:
    output.write('\n'.join(ddl + inserts + other) + '\n')
