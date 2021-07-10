# SEE: https://lithic.tech/blog/2020-05/makefile-dot-env
ifneq (,$(wildcard ./.env))
    include .env
    export
endif

run:
	go run .

build_dev:
	go build -o server

build:
	GOOS=linux GOARCH=amd64 CGO_ENABLED=1 CC=/usr/local/bin/x86_64-linux-musl-cc go build --ldflags='-linkmode external -extldflags "-static" -w -s' -o ./data/new_server .

# Deploy server to local
deploy_server_dev:
	docker-compose exec app bash -c "mv ./data/new_server ./server && /usr/local/bin/sv term pwsia"

# Upload server (to Prod S3 Bucket)
upload_server:
	aws s3 cp --profile $$AWS_PROFILE --no-progress ./data/new_server s3://pwsia-example-bucket/bin/new_server

# Deploy server (to Prod EC2)
deploy_server:
	pushd ./infrastructure/lambda/deploy-ec2 && AWS_PROFILE=$$AWS_PROFILE npm start && popd

update_dev: build deploy_server_dev

update: build upload_server deploy_server

bootstrap:
	pushd ./infrastructure && cdk bootstrap --profile $$AWS_PROFILE && popd

diff:
	pushd ./infrastructure && cdk diff "*Stack" --profile $$AWS_PROFILE && popd

deploy:
	pushd ./infrastructure && cdk deploy "*Stack" --profile $$AWS_PROFILE --outputs-file ./cdk-outputs.json && popd

synth:
	pushd ./infrastructure && cdk synth "*Stack" --profile $$AWS_PROFILE && popd

destroy:
	pushd ./infrastructure && cdk destroy "*Stack" --profile $$AWS_PROFILE && popd
