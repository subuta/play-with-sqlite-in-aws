FROM golang:1.16.5-stretch AS build

WORKDIR /opt/work
RUN mkdir /opt/work/dist

COPY . .

# Build executable.
RUN GOOS=linux GOARCH=amd64 go build -ldflags="-w -s" -o /opt/work/dist/server .

# Copy utils.
RUN cp -r /opt/work/fixtures /opt/work/dist/fixtures && \
    cp /opt/work/bin/restart.sh /opt/work/dist && \
    cp /opt/work/bin/install-runit.sh /opt/work/dist && \
    mkdir /opt/work/dist/db

# For emulating EC2 instance.
FROM amazonlinux:2

# Fix Cerificate error for S3.
RUN yum update -y && yum group install -y "Development Tools" && yum install -y tar wget procps glibc-static ca-certificates sudo

# Copy our static executable.
COPY --from=build /opt/work/dist /opt/work

# Install runit
RUN /opt/work/install-runit.sh

WORKDIR /opt/work

# Put runit config for app
COPY ./bin/run-pwsia.sh /service/pwsia/run
COPY ./bin/log-pwsia.sh /service/pwsia/log/run

# Create log directory.
# SEE: [runit-quickstart](https://kchard.github.io/runit-quickstart/)
RUN mkdir -p /var/log/pwsia

# SEE: [Bypass runsvdir-start in order to preserve env by mattolson · Pull Request #6 · phusion/baseimage-docker](https://github.com/phusion/baseimage-docker/pull/6/files)
# Start with runit daemon.
CMD ["/command/runsvdir", "-P", "/service"]
