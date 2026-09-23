"""Make a consistent private SQLite backup, including committed WAL pages."""
import sqlite3, pathlib, sys, os
source = pathlib.Path(sys.argv[1]).resolve()
destination = pathlib.Path(sys.argv[2]).resolve()
if destination.exists() or source == destination:
    raise SystemExit('Destination must be a new scratch file')
os.umask(0o077)
destination.parent.mkdir(parents=True, exist_ok=True)
with sqlite3.connect(source.as_uri() + '?mode=ro', uri=True) as src:
    with sqlite3.connect(destination) as dst:
        src.backup(dst)
print(destination)
