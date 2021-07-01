package pwsia

import (
	"context"
	"fmt"
	"github.com/benbjohnson/litestream"
	lss3 "github.com/benbjohnson/litestream/s3"
	"log"
	"os"
)

// SEE: https://github.com/benbjohnson/litestream-library-example/blob/main/main.go

func Replicate(ctx context.Context, dsn string, bucket string) (*litestream.DB, error) {
	s3Endpoint := os.Getenv("S3_ENDPOINT")
	if len(s3Endpoint) == 0 {
		s3Endpoint = "s3:9000"
	}

	// Create Litestream DB reference for managing replication.
	lsdb := litestream.NewDB(dsn)

	// Build S3 replica and attach to database.
	client := lss3.NewReplicaClient()

	// Set bucket and path.
	client.Bucket = bucket

	// Set other s3 params if local(Minio).
	isLocal := os.Getenv("IS_LOCAL")
	if isLocal == "1" {
		client.Region = "us-east1"
		client.Endpoint = s3Endpoint
		client.ForcePathStyle = true
		client.SkipVerify = true
	}

	replica := litestream.NewReplica(lsdb, "s3")
	syncInterval := litestream.DefaultSyncInterval
	replica.Client = client

	// Automatically sync in default interval.
	replica.SyncInterval = syncInterval

	log.Print(fmt.Sprintf("[litestream] start replication from '%s' to '%s' on each '%v'", dsn, replica.Name(), syncInterval))
	lsdb.Replicas = append(lsdb.Replicas, replica)

	if err := Restore(ctx, replica); err != nil {
		return nil, err
	}

	// Initialize database.
	if err := lsdb.Open(); err != nil {
		return nil, err
	}

	return lsdb, nil
}

func Restore(ctx context.Context, replica *litestream.Replica) (err error) {
	fmt.Println("[litestream] try restore")

	// Skip restore if local database already exists.
	if _, err := os.Stat(replica.DB().Path()); err == nil {
		fmt.Println("[litestream] local database already exists, skipping restore")
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}

	// Configure restore to write out to DSN path.
	opt := litestream.NewRestoreOptions()
	opt.OutputPath = replica.DB().Path()
	opt.Logger = log.New(os.Stderr, "", log.LstdFlags|log.Lmicroseconds)

	log.Print(fmt.Sprintf("[litestream] try to restore into '%s'", opt.OutputPath))

	// Determine the latest generation to restore from.
	if opt.Generation, _, err = replica.CalcRestoreTarget(ctx, opt); err != nil {
		return err
	}

	// Only restore if there is a generation available on the replica.
	// Otherwise we'll let the application create a new database.
	if opt.Generation == "" {
		fmt.Println("[litestream] no generation found, creating new database")
		return nil
	}

	fmt.Printf("restoring replica for generation %s\n", opt.Generation)
	if err := replica.Restore(ctx, opt); err != nil {
		return err
	}
	fmt.Println("[litestream] restore complete")
	return nil
}
