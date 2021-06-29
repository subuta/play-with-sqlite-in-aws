#!/usr/bin/env bash

# Try restart server instance by sending TERM signal.
ps -ef  | grep -e [/]opt/work/server | head -n 1 | awk '{print $2}' | xargs kill -15
