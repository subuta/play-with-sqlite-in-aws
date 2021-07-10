#!/usr/bin/env bash

SHOULD_DELETE_DB=false
SQLITE_DB_DIR=/opt/work/db

# Loop through arguments, two at a time for key and value
while [[ $# -gt 0 ]]
do
    key="$1"

    case $key in
        -d|--delete-db)
            SHOULD_DELETE_DB=true
            shift # past argument
            ;;
    esac
    shift # past argument or value
done

# Clean "SQLITE_DB_DIR" for force Litestream to restore DB from S3 bucket.
if [ $SHOULD_DELETE_DB == true ]; then
  sudo rm -rf $SQLITE_DB_DIR
  mkdir -p $SQLITE_DB_DIR
  echo "Cleaned ${SQLITE_DB_DIR} dir."
fi

sudo aws s3 cp --no-progress s3://pwsia-example-bucket/bin/new_server /opt/work/server
sudo chmod +x /opt/work/server

# Start runit service only-if stopped.
# SEE: [systemd - The "proper" way to test if a service is running in a script - Unix & Linux Stack Exchange](https://unix.stackexchange.com/a/396638)
sudo bash -c "systemctl start runit"

attempt_counter=0
wait_seconds=5

# Waiting for runit to boot server (for initial startup)
until $(curl --output /dev/null --silent --fail http://localhost:3000/hb); do
    printf '.'
    attempt_counter=$(($attempt_counter+1))
    sleep $wait_seconds
done

echo "$((wait_seconds * attempt_counter)) seconds taken, until server startup"

# Try restart server instance by sending TERM signal.
sudo /usr/local/bin/sv term pwsia
