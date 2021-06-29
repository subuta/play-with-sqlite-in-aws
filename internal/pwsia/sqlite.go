package pwsia

import (
	"github.com/jmoiron/sqlx"
	"github.com/thoas/go-funk"
	"github.com/xo/dburl"
	"io/ioutil"
	"log"
	"os"
)

func OpenDB(dsn string) *sqlx.DB {
	// Connect to SQLite3 with WAL enabled.
	// SEE: https://github.com/mattn/go-sqlite3#connection-string
	// SEE: [go-sqlite3 with journal_mode=WAL gives 'database is locked' error - Stack Overflow](https://stackoverflow.com/questions/57118674/go-sqlite3-with-journal-mode-wal-gives-database-is-locked-error)
	// SEE: [Support vfs for Open by mattn · Pull Request #877 · mattn/go-sqlite3](https://github.com/mattn/go-sqlite3/pull/877)
	// SEE: https://stackoverflow.com/a/42492845/9998350, at [linux - Why does sqlite3 not work on Amazon Elastic File System? - Stack Overflow](https://stackoverflow.com/questions/42070214/why-does-sqlite3-not-work-on-amazon-elastic-file-system)
	u, err := dburl.Parse(dsn)
	if err != nil {
		return nil
	}

	db, err := sqlx.Open(u.Driver, u.DSN)
	if err != nil {
		return nil
	}

	var tableNames []string
	db.Select(&tableNames, "SELECT name FROM sqlite_master\nWHERE type='table'\nORDER BY name;")

	// Set busy_timeout for Litestream.
	// Litestream recommends "busy_timeout = 5000", but for NFS usage we need make timeout value much longer.
	db.MustExec("PRAGMA busy_timeout = 30000;")
	db.MustExec("PRAGMA synchronous = NORMAL;\n")

	initialDBSchemaPath := os.Getenv("INITIAL_DB_SCHEMA_PATH")
	if len(initialDBSchemaPath) == 0 {
		log.Print("INITIAL_DB_SCHEMA_PATH not specified")
		return db
	}

	isInitialized := funk.ContainsString(tableNames, "page_views")
	if !isInitialized {
		// Run initial migration
		file, err := ioutil.ReadFile(initialDBSchemaPath)
		if err != nil {
			log.Fatal(err)
			return nil
		}
		db.MustExec(string(file))
	}

	return db
}
