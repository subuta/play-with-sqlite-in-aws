#!/usr/bin/env bash

VERBOSE=false
AWS_PROFILE=""
RUN_COMMAND=""

# Check requirements
function require() {
    command -v "$1" > /dev/null 2>&1 || {
        echo "Some of the required software is not installed:"
        echo "    please install $1" >&2;
        exit 4;
    }
}

set -e

# Check for AWS, AWS Command Line Interface and Docker command.
require aws

# Loop through arguments, two at a time for key and value
while [[ $# -gt 0 ]]
do
    key="$1"

    case $key in
        -p|--profile)
            AWS_PROFILE="$2"
            shift # past argument
            ;;
        -v|--verbose)
            VERBOSE=true
            ;;
    esac
    shift # past argument or value
done

if [ $VERBOSE == true ]; then
    set -x
fi

printf "[start] deploy-ec2.sh \n"

echo "====== args [start] ======"
echo "AWS_PROFILE = '${AWS_PROFILE}'"
printf "====== args [end] ======\n\n"

# Upload latest "server" binary to S3 bucket.
aws s3 --profile ${AWS_PROFILE} cp ./data/new_server s3://pwsia-example-bucket/bin/new_server

instanceIds=$(aws ssm --profile ${AWS_PROFILE} describe-instance-information --query "InstanceInformationList[*]" | jq -c '[.[].InstanceId]')
printf "instanceIds = ${instanceIds}\n"

commandId=$(aws ssm --profile ${AWS_PROFILE} send-command --instance-ids "${instanceIds}" --document-name "AWS-RunShellScript" --comment "Run command at EC2 Instances of ASG" --parameters commands="/opt/work/restart.sh" | jq -c '.Command.CommandId' | jq -r @sh | tr -d \')
printf "commandId = ${commandId}\n\n"

for row in $(echo "${instanceIds}" | jq -r '.[]'); do
   echo "Waiting for '${row}' instance's command status."
   aws ssm wait --profile ${AWS_PROFILE} command-executed --command-id ${commandId} --instance-id ${row}
   echo "Done waiting for '${row}' instance's command success."
done
printf "\n"

results=$(aws ssm --profile ${AWS_PROFILE} list-command-invocations --command-id ${commandId} --details | jq -c '[.CommandInvocations[].CommandPlugins[].Output]')
echo "results = -----"
for row in $(echo "${results}" | jq -r '.[]'); do
  echo "${row}"
  printf "\n"
done
echo "---------------"
printf "\n"

printf "[end]   deploy-ec2.sh \n\n"
