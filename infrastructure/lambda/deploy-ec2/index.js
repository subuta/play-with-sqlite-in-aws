const aws = require('aws-sdk')
const _ = require('lodash')
const Promise = require('bluebird')
const wait = require('waait')
const { performance } = require('perf_hooks')

const ssm = new aws.SSM({ apiVersion: '2014-11-06' })
const as = new aws.AutoScaling()

exports.handler = async (event, context) => {
  let MAX_RETRY = 15

  console.log('[start] deploy-ec2')

  // Check whether "CI / Local" env or Production(AWS)
  const prod = !process.env.CI

  console.log('Received event:', JSON.stringify(event, null, 2))

  const message = JSON.parse(_.get(event, ['Records', 0, 'Sns', 'Message']))
  console.log('Message:', JSON.stringify(message, null, 2))

  // true If event Triggered from WarmPool.
  const isWarmPoolEvent = message['Origin'] === 'WarmPool'
  const LifecycleActionToken = message['LifecycleActionToken']

  // Get SSM-managed instanceIds.
  const { InstanceInformationList } = await ssm.describeInstanceInformation().promise()
  let targetInstanceIds = _.map(InstanceInformationList, 'InstanceId')

  // Try set command target from lifecycle hook event message if exists.
  const ec2InstanceId = message['EC2InstanceId']
  if (ec2InstanceId) {
    targetInstanceIds = [ec2InstanceId]
  }

  const doCompleteLifecycleHook = async () => {
    if (!LifecycleActionToken) return
    console.log('[deploy-ec2] try notify "completeLifecycleAction"')
    // Notify EC2 Instance to complete lifecycle action.
    await Promise.each(targetInstanceIds, (InstanceId) =>
      as
        .completeLifecycleAction({
          InstanceId,
          LifecycleActionToken,
          AutoScalingGroupName: message['AutoScalingGroupName'],
          LifecycleActionResult: 'CONTINUE',
          LifecycleHookName: message['LifecycleHookName'],
        })
        .promise()
    )
    console.log('[deploy-ec2] done notify "completeLifecycleAction"')
  }

  // Ignore non warm-pool event for prod.
  if (prod && !isWarmPoolEvent) {
    await doCompleteLifecycleHook()
    console.log('[skip] Ignore non-lifecycle event or non-warm-pool event.')
    return true
  }

  // Wait for "60 second" and retry.
  if (prod) {
    await wait(1000 * 60)
  }

  let retryCount = 0
  let CommandId = ''
  let flag = ''

  // Always delete SQLiteDB before restart server to trigger Litestream restore at Production(AWS) .
  if (prod) {
    flag += ' --delete-db'
  }

  const command = `/opt/work/restart.sh${flag}`.trim()

  console.log(
    `[deploy-ec2] Try running command at these instances, command="${command}", instanceIds="${targetInstanceIds.join(
      ', '
    )}"`
  )

  while (true) {
    try {
      const { Command } = await ssm
        .sendCommand({
          DocumentName: 'AWS-RunShellScript',
          Comment: 'Run command at EC2 Instances of ASG',
          Parameters: {
            commands: [command],
          },
          InstanceIds: targetInstanceIds,
        })
        .promise()
      CommandId = Command.CommandId
      break
    } catch (err) {
      // Only log if unknown error returned.
      if (err.code !== 'InvalidInstanceId') {
        console.log(`[deploy-ec2] Got error at "sendCommand", err = `, err)
      }

      retryCount++
      // Wait for "30 second" and retry.
      await wait(1000 * 10)
      if (retryCount >= MAX_RETRY) {
        console.log(`[deploy-ec2] Abort execution, Got too many error at "sendCommand", lastError="${err.code}"`)
        await doCompleteLifecycleHook()
        throw err
      }
    }
  }

  console.log(`[deploy-ec2] Done sendCommand request`)

  // "waitFor" needs small pause before `waitFor` call :(
  // SEE: [amazon web services - Retrieving command invocation in AWS SSM - Stack Overflow](https://stackoverflow.com/questions/50067035/retrieving-command-invocation-in-aws-ssm)
  await wait(1000 * 3)
  console.log(`[deploy-ec2] Waiting for command execution`)

  retryCount = 0
  while (true) {
    try {
      // Await for command execution.
      const t1 = performance.now()
      await Promise.each(targetInstanceIds, (InstanceId) =>
        ssm
          .waitFor('commandExecuted', {
            CommandId,
            InstanceId,
          })
          .promise()
      )

      console.log(
        `[deploy-ec2] Done waiting for command execution, took ${_.round((performance.now() - t1) / 1000, 2)} seconds`
      )
      break
    } catch (err) {
      // Only log if unknown error returned.
      if (err.code !== 'ResourceNotReady') {
        console.log(`[deploy-ec2] Got error at "sendCommand", err = `, err)
      }

      retryCount++
      // Wait for "30 second" and retry.
      await wait(1000 * 10)
      if (retryCount >= MAX_RETRY) {
        console.log(
          `[deploy-ec2] Abort execution, Got too many error at "waitFor commandExecuted", lastError="${err.code}"`
        )
        await doCompleteLifecycleHook()
        throw err
      }
    }
  }

  // Fetch last command result.
  const { CommandInvocations } = await ssm
    .listCommandInvocations({
      CommandId,
      Details: true,
    })
    .promise()

  // Log command outputs.
  _.each(CommandInvocations, (CommandInvocation, i) => {
    const Output = _.get(CommandInvocation, ['CommandPlugins', 0, 'Output'], '')

    console.log(`[deploy-ec2] result of ${i}th command =====`)
    // Split by '\r' character and console out logs.
    _.each(Output.split('\r'), (row) => console.log(row))
    console.log(`[deploy-ec2] done result of ${i}th command =====`)
  })

  await doCompleteLifecycleHook()

  console.log('[end] deploy-ec2')

  return true
}
