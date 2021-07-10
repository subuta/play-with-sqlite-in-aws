# play-with-sqlite-in-aws
Try deploy SQLite based WebApp to AWS env

## Prerequisites

- For building linux binary on macOS.
  - brew install FiloSottile/musl-cross/musl-cross
- macOS (Not tested with other OS)
- AWS CLI
  - `~/.aws/config` and `~/.aws/credentials` should be configured properly.
- Docker (for Development)

These tools needs to be installed when you run `make update` on your local machine

- jq

## How to develop (with Docker)

```bash
# COPY env file.
cp .env.example .env

# COPY Makefile
# Replace "AWS_PROFILE" of env.
vi .env

# Start s3 service
docker-compose up -d s3

# Create initial bucket
docker run --network play-with-sqlite-in-aws_default --rm --entrypoint bash minio/mc -c "mc alias set minio http://s3:9000 DUMMY_ROOT_USER DUMMY_ROOT_PASSWORD && mc mb minio/pwsia-example-bucket"

# Start others also
docker-compose up

# Open app
open http://localhost:3000

# Try query to local server.
while true; do curl http://localhost:3000/hb || break; done
while true; do curl 'http://localhost:3000/hb?delay=3s' || break; done

# Try update server
make update_dev
```

## How to deploy into AWS

```
# Run bootstrap (If prompted)
make bootstrap

# Get CDK diff (dry-run)
make diff

# Trigger deployment of AWS resources(includes ASG/ALB...).
make deploy

# Open production URL.
cat ./infrastructure/cdk-outputs.json | jq '.PWSIAVpcStack.PWSIAExampleALBURL' | read ALB_URL && bash -c "open \"http://${ALB_URL}\""

# Try query to production server. 
cat ./infrastructure/cdk-outputs.json | jq '.PWSIAVpcStack.PWSIAExampleALBURL' | read ALB_URL && bash -c "while true; do curl \"http://${ALB_URL}/hb\" || break; done"
cat ./infrastructure/cdk-outputs.json | jq '.PWSIAVpcStack.PWSIAExampleALBURL' | read ALB_URL && bash -c "while true; do curl \"http://${ALB_URL}/hb?delay=3s\" || break; done"

# Try update server
make update

# Remove all created resources
# CAUTION: S3 Buckets needs manual deletion after running "make destroy"
make destroy
```
