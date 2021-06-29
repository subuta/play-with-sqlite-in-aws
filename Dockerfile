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
RUN yum update -y && yum install -y wget procps systemd-sysv ca-certificates

# Copy our static executable.
COPY --from=build /opt/work/dist /opt/work

WORKDIR /opt/work

# Put systemd(systemctl) config for app
COPY ./Dockerfiles/pwsia.service /etc/systemd/system/pwsia.service

# Enable app for systemd.
RUN systemctl enable pwsia

# Start systemd.
CMD ["/sbin/init"]
