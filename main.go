package main

import (
	"context"
	"flag"
	"fmt"
	"github.com/benbjohnson/litestream"
	reuseport "github.com/kavu/go_reuseport"
	_ "github.com/mattn/go-sqlite3"
	"github.com/rs/seamless"
	"github.com/subuta/play-with-sqlite-in-aws/internal/pwsia"
	"github.com/xo/dburl"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
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

// SEE: https://github.com/rs/seamless
func main() {
	log.Print("[main] started")

	serverName := os.Getenv("SERVER_NAME")
	if len(serverName) == 0 {
		serverName = "default"
	}

	databaseUrl := os.Getenv("DATABASE_URL")
	if len(databaseUrl) == 0 {
		log.Print("DATABASE_URL not specified")
		return
	}

	skipLs := os.Getenv("SKIP_LS")
	shouldSkipLs := skipLs == "1"

	var lsdb *litestream.DB
	if !shouldSkipLs {
		var err error

		lsCtx, stopLs := signal.NotifyContext(context.Background(), syscall.SIGTERM)
		defer stopLs()

		bucket := "pwsia-example-bucket"

		// Create a Litestream DB and attached replica to manage background replication.
		log.Print(fmt.Sprintf("[main] try start replicating '%s' into S3 '%s' Bucket", databaseUrl, bucket))

		u, err := dburl.Parse(databaseUrl)
		if err != nil {
			log.Fatal(err)
			return
		}

		// Extract only File Path.
		onlyFileName := u.URL.Opaque
		lsdb, err = pwsia.Replicate(lsCtx, onlyFileName, bucket)
		if err != nil {
			log.Fatal(err)
			return
		}
		defer lsdb.SoftClose()
		log.Print(fmt.Sprintf("[main] replication started"))
	} else {
		log.Print("[main] skipped Litestream replication")
	}

	// Open SQLite DB for App.
	log.Print(fmt.Sprintf("[main] try opening '%s' database", databaseUrl))
	db := pwsia.OpenDB(databaseUrl)
	defer db.Close()
	log.Print(fmt.Sprintf("[main] opened '%s' database successfully", databaseUrl))

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

	s := &http.Server{
		Addr:    *listen,
		Handler: pwsia.GetRouter(db),
	}

	seamless.OnShutdownRequest(func() {
		log.Print("[main] Got Graceful shutdown request")

		// Do nothing if Litestream are totally "skipped".
		if shouldSkipLs {
			return
		}

		log.Print("[main] Try closing Litestream replication")
		if err := lsdb.SoftClose(); err != nil {
			log.Fatal(err)
			return
		}
		log.Print("[main] Done closing Litestream replication successfully")
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

	log.Print(fmt.Sprintf("[main] start HTTP server on '%v'", &listen))
	err = s.Serve(l)
	if err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}

	log.Print("[main] Waiting for OnShutdown")

	// Once graceful shutdown is initiated, the Serve method is return with a
	// http.ErrServerClosed error. We must not exit until the graceful shutdown
	// is completed. The seamless.Wait method blocks until the OnShutdown callback
	// has returned.
	seamless.Wait()

	log.Print("[main] Done OnShutdown, Finishing server process.")
}
