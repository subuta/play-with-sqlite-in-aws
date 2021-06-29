FROM golang:1.16.5-stretch AS build

WORKDIR /opt/work
RUN mkdir /opt/work/dist

COPY . .

# Build executable.
RUN GOOS=linux GOARCH=amd64 go build -ldflags="-w -s" -o /opt/work/dist/server .

#
RUN cp -r /opt/work/fixtures /opt/work/dist/fixtures && \
    cp /opt/work/Dockerfiles/wait-for-it.sh /opt/work/dist && \
    cp /opt/work/Dockerfiles/restart.sh /opt/work/dist && \
    cp /opt/work/Dockerfiles/logs.sh /opt/work/dist && \
    mkdir /opt/work/dist/db

# For emulating EC2 instance.
FROM amazonlinux:2

# Fix Cerificate error for S3.
RUN yum update -y && yum group install -y "Development Tools" && yum install -y tar wget procps glibc-static ca-certificates

# Install daemontools
RUN mkdir -p /package && \
    chmod 1755 /package && \
    cd /package && \
    wget http://smarden.org/runit/runit-2.1.2.tar.gz && \
    gunzip runit-2.1.2.tar.gz && \
    tar -xpf runit-2.1.2.tar && \
    cd admin/runit-2.1.2 && \
    ./package/install && \
    mkdir -p /service

# Copy our static executable.
COPY --from=build /opt/work/dist /opt/work

WORKDIR /opt/work

# Put runit config for app
COPY ./Dockerfiles/run-pwsia.sh /service/pwsia/run
COPY ./Dockerfiles/log-pwsia.sh /service/pwsia/log/run

# Create log directory.
# SEE: [runit-quickstart](https://kchard.github.io/runit-quickstart/)
RUN mkdir -p /var/log/pwsia

# SEE: [Bypass runsvdir-start in order to preserve env by mattolson · Pull Request #6 · phusion/baseimage-docker](https://github.com/phusion/baseimage-docker/pull/6/files)
# Start with runit daemon.
CMD ["/command/runsvdir", "-P", "/service"]
