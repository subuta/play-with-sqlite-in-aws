#!/usr/bin/env bash

# Get log for service.
journalctl -u pwsia.service -f
