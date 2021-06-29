package main

import (
	"context"
	"flag"
	"fmt"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	_ "github.com/mattn/go-sqlite3"
	"github.com/rs/seamless"
	"github.com/xo/dburl"
	"io/ioutil"
	"log"
	"net/http"
	"os"
	"time"

	reuseport "github.com/kavu/go_reuseport"
)

var (
	listen          = flag.String("listen", "0.0.0.0:3000", "Listen address")
	pidFile         = flag.String("pid-file", "/tmp/reuseport.pid", "Seemless restart PID file")
	gracefulTimeout = flag.Duration("graceful-timeout", 60*time.Second, "Maximum duration to wait for in-flight requests")
)

type PageView struct {
	Id        int
	CreatedAt time.Time `db:"created_at"`
	UpdatedAt time.Time `db:"updated_at"`
}

func init() {
	flag.Parse()
	seamless.Init(*pidFile)
}

func openDB() *sqlx.DB {
	fileName := "/opt/work/db/db.sqlite"

	// Touch sqlite file if not exits.
	_, err := os.Stat(fileName)
	notExisted := os.IsNotExist(err)
	if notExisted {
		file, err := os.Create(fileName)
		if err != nil {
			log.Fatal(err)
		}
		defer file.Close()
	}

	// Connect to SQLite3 with WAL enabled.
	// SEE: https://github.com/mattn/go-sqlite3#connection-string
	// SEE: [go-sqlite3 with journal_mode=WAL gives 'database is locked' error - Stack Overflow](https://stackoverflow.com/questions/57118674/go-sqlite3-with-journal-mode-wal-gives-database-is-locked-error)
	// SEE: [Support vfs for Open by mattn · Pull Request #877 · mattn/go-sqlite3](https://github.com/mattn/go-sqlite3/pull/877)
	// SEE: https://stackoverflow.com/a/42492845/9998350, at [linux - Why does sqlite3 not work on Amazon Elastic File System? - Stack Overflow](https://stackoverflow.com/questions/42070214/why-does-sqlite3-not-work-on-amazon-elastic-file-system)
	u, err := dburl.Parse("file:" + fileName + "?cache=shared&mode=rwc&_journal_mode=WAL&vfs=unix")
	if err != nil {
		return nil
	}

	db, err := sqlx.Open(u.Driver, u.DSN)
	if err != nil {
		return nil
	}

	if notExisted {
		// Run initial migration
		file, err := ioutil.ReadFile("/opt/work/fixtures/initial_schema.sql")
		if err != nil {
			return nil
		}
		db.Exec(string(file))
	}

	// Set busy_timeout for Litestream.
	// Litestream recommends "busy_timeout = 5000", but for NFS usage we need make timeout value much longer.
	db.MustExec("PRAGMA busy_timeout = 30000;")
	db.MustExec("PRAGMA synchronous = NORMAL;\n")

	return db
}

// SEE: https://github.com/rs/seamless
func main() {
	serverName := os.Getenv("SERVER_NAME")
	if len(serverName) == 0 {
		serverName = "default"
	}

	sid, err := uuid.NewUUID()
	if err != nil {
		log.Fatal(err)
	}

	// Open SQLite DB.
	db := openDB()
	defer db.Close()

	// Use github.com/kavu/go_reuseport waiting for
	// https://github.com/golang/go/issues/9661 to be fixed.
	//
	// The idea of SO_REUSEPORT flag is that two processes can listen on the
	// same host:port. Using the capability, the new daemon can listen while
	// the old daemon is still bound, allowing seemless transition from one
	// process to the other.
	l, err := reuseport.Listen("tcp", *listen)
	if err != nil {
		log.Fatal(err)
	}

	r := chi.NewRouter()
	//r.Use(middleware.Logger)

	// Heartbeat routes.
	r.Get("/hb", func(w http.ResponseWriter, r *http.Request) {
		if d := r.URL.Query().Get("delay"); d != "" {
			if delay, err := time.ParseDuration(d); err == nil {
				time.Sleep(delay)
			}
		}

		db.MustExec("SELECT 1 + 1")

		w.WriteHeader(http.StatusOK)
		w.Write([]byte(fmt.Sprintf("%s: 💓, instanceUUID = %v\n", serverName, sid)))
	})

	r.Get("/", func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()

		insertPv := `INSERT INTO page_views DEFAULT VALUES`
		db.MustExec(insertPv)

		d1 := time.Since(start)
		start = time.Now()

		var count int
		db.Get(&count, "SELECT count(*) from page_views;")

		d2 := time.Since(start)

		w.WriteHeader(http.StatusOK)
		w.Write([]byte(fmt.Sprintf("Hello, World 👋!, serverName = %s, pv = %d, d1(time taken for INSERT) = %v, d2(time taken for SELECT) = %v", serverName, count, d1, d2)))
	})

	s := &http.Server{
		Addr: *listen,
		Handler: r,
	}

	seamless.OnShutdownRequest(func () {
		log.Print("Got Graceful shutdown request.")

		if delay, err := time.ParseDuration("3s"); err == nil {
			time.Sleep(delay)
		}
	})

	// Implement the graceful shutdown that will be triggered once the new process
	// successfully rebound the socket.
	seamless.OnShutdown(func() {
		log.Print("Try Graceful shutdown.")
		ctx, cancel := context.WithTimeout(context.Background(), *gracefulTimeout)
		defer func() {
			log.Print("Finished Graceful shutdown.")
			cancel()
		}()
		if err := s.Shutdown(ctx); err != nil {
			log.Print("Graceful shutdown timeout, force closing")
			s.Close()
		}
	})

	go func() {
		// Give the server a second to start
		time.Sleep(time.Second)
		if err == nil {
			// Signal seamless that the daemon is started and the socket is
			// bound successfully. If a pid file is found, seamless will send
			// a signal to the old process to start its graceful shutdown
			// sequence.
			log.Println(fmt.Printf("Serve listen on %s", *listen))
			seamless.Started()
		}
	}()

	err = s.Serve(l)
	if err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}

	log.Print("Waiting for OnShutdown")

	// Once graceful shutdown is initiated, the Serve method is return with a
	// http.ErrServerClosed error. We must not exit until the graceful shutdown
	// is completed. The seamless.Wait method blocks until the OnShutdown callback
	// has returned.
	seamless.Wait()

	log.Print("Done OnShutdown, Finishing server process.")
}
