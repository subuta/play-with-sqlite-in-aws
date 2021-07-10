package pwsia

import (
	"fmt"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"log"
	"net/http"
	"os"
	"time"
)

func GetRouter(db *sqlx.DB) *chi.Mux {
	serverName := os.Getenv("SERVER_NAME")
	if len(serverName) == 0 {
		serverName = "default"
	}

	sid, err := uuid.NewUUID()
	if err != nil {
		log.Fatal(err)
	}

	r := chi.NewRouter()
	r.Use(middleware.Logger)

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

	// Main route.
	r.Get("/", func(w http.ResponseWriter, r *http.Request) {
		if d := r.URL.Query().Get("delay"); d != "" {
			if delay, err := time.ParseDuration(d); err == nil {
				time.Sleep(delay)
			}
		}

		// Start a transaction.
		tx := db.MustBegin()
		defer tx.Rollback()

		start := time.Now()

		insertPv := `INSERT INTO page_views DEFAULT VALUES`
		tx.MustExecContext(r.Context(), insertPv)

		d1 := time.Since(start)
		start = time.Now()

		var count int
		tx.GetContext(r.Context(), &count, "SELECT count(*) from page_views;")

		if err := tx.Commit(); err != nil {
			log.Fatal(err)
			return
		}

		d2 := time.Since(start)

		w.WriteHeader(http.StatusOK)
		w.Write([]byte(fmt.Sprintf("Hello World 👋!, serverName = %s, pv = %d, d1(time taken for INSERT) = %v, d2(time taken for SELECT) = %v", serverName, count, d1, d2)))
	})

	return r
}
