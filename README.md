# play-with-sqlite-in-aws
Try deploy SQLite based WebApp to AWS env

## Prerequisites

- For building linux binary on macOS.
  - brew install FiloSottile/musl-cross/musl-cross
- macOS (Not tested with other OS)

## How to develop (with Docker)

```bash
# COPY env file.
cp .env.example .env

# COPY Makefile
# Replace `--profile` argument to your AWS Account's profile name.
# Then you can use these handy make commands instead of manually constructing it.
cp Makefile.example Makefile
vi Makefile

# Start s3 service
docker-compose up -d s3

# Create initial bucket
docker run --network play-with-sqlite-in-aws_default --rm --entrypoint bash minio/mc -c "mc alias set minio http://s3:9000 DUMMY_ROOT_USER DUMMY_ROOT_PASSWORD && mc mb minio/pwsia-example-bucket"

# Start others also
docker-compose up

# Open app
open http://localhost:3000

# Try restore replica as local file by Litestream
docker-compose run ls restore -if-replica-exists -o /opt/work/db/restored-db.sqlite /opt/work/db/db.sqlite

# Try query to server.
while true; do curl http://localhost:3000/hb || break; done
while true; do curl 'http://localhost:3000/hb?delay=3s' || break; done

# Try update server
make update-d
```
