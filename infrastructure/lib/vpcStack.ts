import * as cdk from '@aws-cdk/core'
import * as ec2 from '@aws-cdk/aws-ec2'
import * as iam from '@aws-cdk/aws-iam'
import * as lambda from '@aws-cdk/aws-lambda'
import * as awsasg from '@aws-cdk/aws-autoscaling'
import * as hooks from '@aws-cdk/aws-autoscaling-hooktargets'
import * as s3 from '@aws-cdk/aws-s3'
import * as s3deploy from '@aws-cdk/aws-s3-deployment'
import * as elbv2 from '@aws-cdk/aws-elasticloadbalancingv2'

import * as path from 'path'
import { source } from 'common-tags'
import { HealthCheck } from '@aws-cdk/aws-autoscaling/lib/auto-scaling-group'
import * as logs from '@aws-cdk/aws-logs'

type VpcStackProps = cdk.StackProps | {}

const ROOT_DIR = path.resolve(__dirname, '../../')
const LAMBDA_DIR = path.resolve(ROOT_DIR, './infrastructure/lambda')

export class VpcStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: VpcStackProps) {
    super(scope, id, props)

    // Add VPC resources.
    const vpc = new ec2.Vpc(this, 'PWSIAExampleVpc', {
      natGateways: 1,
      maxAzs: 2,
      subnetConfiguration: [
        {
          name: 'pwsia-example-public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          name: 'pwsia-example-private',
          subnetType: ec2.SubnetType.PRIVATE,
        },
        {
          name: 'pwsia-example-isolated',
          subnetType: ec2.SubnetType.ISOLATED,
        },
      ],
    })

    const bucket = new s3.Bucket(this, 'PWSIAExampleBucket', {
      bucketName: 'pwsia-example-bucket',
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      cors: [
        {
          // Create common bucket for our service.
          // !CAUTION! Set appropriate CORS origin/headers in production.
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          allowedMethods: [
            s3.HttpMethods.GET,
            s3.HttpMethods.HEAD,
            s3.HttpMethods.POST,
            s3.HttpMethods.DELETE,
            s3.HttpMethods.PUT,
          ],
          maxAge: 3000,
        },
      ],
    })

    // Put latest `server` binary into S3.
    new s3deploy.BucketDeployment(this, 'PWSIAExampleBucketDeployment', {
      sources: [s3deploy.Source.asset(path.resolve(ROOT_DIR, './data'), { exclude: ['**', '!new_server'] })],
      destinationBucket: bucket,
      destinationKeyPrefix: 'bin',
      retainOnDelete: false,
    })

    // SEE: https://github.com/awslabs/aws-cloudformation-templates/blob/master/aws/services/AutoScaling/AutoScalingRollingUpdates.yaml
    const setupCommands = ec2.UserData.forLinux({
      shebang: '#!/bin/bash -xe',
    })

    // Do install necessary packages.
    setupCommands.addCommands(
      'sudo yum install -y aws-cfn-bootstrap',
      'sudo yum group install -y "Development Tools"',
      // Log current date to log.
      "sudo test -f /opt/work/server && echo \"'UserData' called from 'warmed' instance.\""
    )

    const multipartUserData = new ec2.MultipartUserData()
    // Set as default user data.
    multipartUserData.addUserDataPart(setupCommands)

    const initFileOptionsForExecutable = { mode: '000755' }

    // SEE: https://gist.github.com/brettswift/6e48a70d808a28614438520682459f0c
    // SEE: https://github.com/aws/aws-cdk/blob/master/packages/@aws-cdk/aws-ec2/lib/user-data.ts#L173
    // SEE: https://github.com/awslabs/aws-cloudformation-templates/blob/master/aws/services/AutoScaling/AutoScalingRollingUpdates.yaml
    const cfnInitConfig = ec2.CloudFormationInit.fromConfigSets({
      configSets: {
        'init-all': ['yum-pre-install', 'put-assets', 'enable-runit-daemon'],
      },
      configs: {
        // Install these packages by yum.
        'yum-pre-install': new ec2.InitConfig([
          ec2.InitPackage.yum('jq'),
          ec2.InitPackage.yum('wget'),
          ec2.InitPackage.yum('glibc-static'),
          ec2.InitPackage.yum('ca-certificates'),
        ]),
        // Try install runit script.
        'put-assets': new ec2.InitConfig([
          // Environment variables for server.
          ec2.InitFile.fromString(
            '/opt/work/.env',
            source`
              DATABASE_URL=file:./db/db.sqlite?cache=shared&mode=rwc&_journal_mode=WAL&vfs=unix
              INITIAL_DB_SCHEMA_PATH=./fixtures/initial_schema.sql
            `
          ),

          // Script for installing runit.
          ec2.InitFile.fromFileInline(
            '/opt/work/install-runit',
            path.resolve(ROOT_DIR, './bin/install-runit.sh'),
            initFileOptionsForExecutable
          ),

          // Put initial schema file.
          ec2.InitFile.fromFileInline(
            '/opt/work/fixtures/initial_schema.sql',
            path.resolve(ROOT_DIR, './fixtures/initial_schema.sql')
          ),

          // Put runit service file.
          ec2.InitFile.fromFileInline(
            '/service/pwsia/run',
            path.resolve(ROOT_DIR, './bin/run-pwsia.sh'),
            initFileOptionsForExecutable
          ),

          // Put runit service file's log file
          ec2.InitFile.fromFileInline(
            '/service/pwsia/log/run',
            path.resolve(ROOT_DIR, './bin/log-pwsia.sh'),
            initFileOptionsForExecutable
          ),

          // Put restart utility script.
          ec2.InitFile.fromFileInline(
            '/opt/work/restart.sh',
            path.resolve(ROOT_DIR, './bin/restart.sh'),
            initFileOptionsForExecutable
          ),

          // Pass runit's service file to systemd(AmazonLinux2's default service manager)
          ec2.InitFile.fromFileInline(
            '/etc/systemd/system/runit.service',
            path.resolve(ROOT_DIR, './infrastructure/conf/runit.service'),
            initFileOptionsForExecutable
          ),
        ]),

        // Enable & Start runit.
        'enable-runit-daemon': new ec2.InitConfig([
          ec2.InitCommand.shellCommand('mkdir -p /var/log/pwsia', { key: '01_create_pwsia_log_directory' }),
          ec2.InitCommand.shellCommand('mkdir -p /opt/work/db', { key: '02_create_db_directory' }),
          ec2.InitCommand.shellCommand('/opt/work/install-runit', { key: '03_run_install_runit' }),
          ec2.InitCommand.shellCommand('systemctl enable runit', { key: '04_enable_runit_at_systemd' }),
          ec2.InitCommand.shellCommand('/opt/work/restart.sh', { key: '05_start_server' }),
        ]),
      },
    })

    // How many EC2 Instance should be ready.
    const desiredCapacity = 1

    const asg = new awsasg.AutoScalingGroup(this, 'PWSIAExampleASG', {
      vpc,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
      machineImage: new ec2.AmazonLinuxImage({
        generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2,
      }),
      blockDevices: [
        {
          // Set as root volume.
          deviceName: '/dev/xvda',
          // Set root volume size.
          volume: awsasg.BlockDeviceVolume.ebs(20, {
            // Change volumeType if needed(eg: Needs more throughput)
            // volumeType: awsasg.EbsDeviceVolumeType.GP2,
          }),
        },
      ],
      desiredCapacity,
      minCapacity: desiredCapacity,
      userData: multipartUserData,
      signals: awsasg.Signals.waitForCount(desiredCapacity, {
        timeout: cdk.Duration.minutes(10),
      }),
      // SEE: [Health checks for Auto Scaling instances - Amazon EC2 Auto Scaling](https://docs.aws.amazon.com/autoscaling/ec2/userguide/healthcheck.html)
      // ここをEC2でgrace period = 0とした時に、最短
      healthCheck: HealthCheck.elb({ grace: cdk.Duration.seconds(120) }),
      // Minimize cool-down latency for better HA behavior.
      // SEE: [Scaling cooldowns for Amazon EC2 Auto Scaling - Amazon EC2 Auto Scaling](https://docs.aws.amazon.com/autoscaling/ec2/userguide/Cooldown.html)
      // Wait for 3 minutes.
      cooldown: cdk.Duration.seconds(60),
    })

    // WarmPool configuration for reduce down time. (Around 6 minutes taken without WarmPool)
    const asgCfn = asg.node.defaultChild as awsasg.CfnAutoScalingGroup

    // SEE: https://github.com/aws-samples/amazon-ec2-auto-scaling-group-examples/blob/main/features/lifecycle-hooks/userdata-managed-linux/template.yaml
    // SEE: https://aws.amazon.com/jp/blogs/compute/scaling-your-applications-faster-with-ec2-auto-scaling-warm-pools/
    new awsasg.CfnWarmPool(this, 'PWSIAExampleASGWarmPool', {
      autoScalingGroupName: asgCfn.ref,
      minSize: 1,

      // SEE: [Warm pools for Amazon EC2 Auto Scaling - Amazon EC2 Auto Scaling](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-warm-pools.html#warm-pool-configuration-ex2)
      // Use "Running" warm pool for minimize service down-time. but you need to pay for that instance.
      poolState: 'Stopped',
      // poolState: 'Running',
    })

    // Try sending `cfn-signal` after setup.
    // SEE: https://github.com/aws/aws-cdk/blob/master/packages/@aws-cdk/aws-ec2/lib/user-data.ts#L173
    setupCommands.addSignalOnExitCommand(asg)

    asg.applyCloudFormationInit(cfnInitConfig, {
      // `cfn-init` script call are added automatically by AWS CDK.
      // Which configSets to run.
      configSets: ['init-all'],
      // Uncomment here for debugging.
      // ignoreFailures: true
    })

    // Add SSM related role to Instance.
    asg.role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'))

    // Add Bucket permission to Instance.
    bucket.grantReadWrite(asg.role)
    asg.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['s3:ListBucket', 's3:GetBucketLocation'],
        resources: [bucket.bucketArn],
      })
    )

    const deployEc2Fn = new lambda.Function(this, 'PWSIAExampleDeployEc2', {
      functionName: 'pwsia-deploy-ec2',
      code: lambda.Code.fromAsset(path.join(LAMBDA_DIR, './deploy-ec2')),
      runtime: lambda.Runtime.NODEJS_12_X,
      handler: 'index.handler',
      memorySize: 512,
      timeout: cdk.Duration.minutes(5),
      logRetention: logs.RetentionDays.TWO_WEEKS,
    })

    // Allow SSM related action from Lambda.
    deployEc2Fn.role?.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        resources: ['*'],
        actions: [
          'ssm:*',
          'autoscaling:CompleteLifecycleAction',
          'autoscaling:setInstanceHealth',
          'autoscaling:DescribeAutoScalingGroups',
          'cloudwatch:ListMetrics',
          'cloudwatch:GetMetricStatistics',
        ],
      })
    )

    if (deployEc2Fn.role) {
      bucket.grantReadWrite(deployEc2Fn.role)
    }

    // Trigger Lambda function on WarmPool event.
    asg.addLifecycleHook('PWSIAExampleAsgHook', {
      lifecycleTransition: awsasg.LifecycleTransition.INSTANCE_LAUNCHING,
      notificationTarget: new hooks.FunctionHook(deployEc2Fn),
    })

    // Add ALB resources.
    const alb = new elbv2.ApplicationLoadBalancer(this, 'PWSIAExampleALB', {
      vpc,
      loadBalancerName: 'pwsia-example-alb',
      internetFacing: true,
    })

    const listener = alb.addListener('Listener', {
      port: 80,

      // 'open: true' is the default, you can leave it out if you want. Set it
      // to 'false' and use `listener.connections` if you want to be selective
      // about who can access the load balancer.
      open: true,
    })

    const tg = listener.addTargets('PWSIAExampleALBTarget', {
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [asg],
    })

    // Set HealthCheck rule.
    tg.configureHealthCheck({
      path: '/hb',
      port: '3000',
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 2,
      interval: cdk.Duration.seconds(5),
      timeout: cdk.Duration.seconds(2),
    })

    // Log public URL of ALB.
    new cdk.CfnOutput(this, 'PWSIAExampleALBURL', {
      value: alb.loadBalancerDnsName,
    })

    // Log public URL of ALB.
    listener.connections.allowDefaultPortFromAnyIpv4('Open to the world')
  }
}
