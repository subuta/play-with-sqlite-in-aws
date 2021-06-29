#!/bin/sh -e
# SEE: [phusion/baseimage-docker: A minimal Ubuntu base image modified for Docker-friendliness](https://github.com/phusion/baseimage-docker)
# `/sbin/setuser memcache` runs the given command as the user `memcache`.
# If you omit that part, the command will be run as root.

# Run server binary.
exec 2>&1

cd /opt/work
exec ./server
