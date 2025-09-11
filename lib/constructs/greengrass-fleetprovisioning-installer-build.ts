// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as cdk from "aws-cdk-lib";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as custom_resources from "aws-cdk-lib/custom-resources";
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
} from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

interface FleetProvisioningInstallerBuildProps {
  /** Certificate ID of the claim certificate used for fleet provisioning authentication */
  claimCertificateId: string;

  /** Secret containing the private key for the claim certificate */
  claimPrivateKeySecret: secretsmanager.Secret;

  /** Name of the IoT role alias for token exchange during Greengrass authentication */
  tokenExchangeRoleAliasName: string;

  /** Name of the fleet provisioning template used to provision Greengrass devices */
  fleetProvisioningTemplateName: string;

  /** Default Thing Group name for devices when no group is specified during installation */
  defaultThingGroupName: string;

  /** Whether to configure the installer for private network deployment */
  deployPrivateNetwork?: boolean;

  /** Specify the version of Nucleus to deploy. If not specified, automatically fetches the latest version from GitHub. */
  nucleusDefaultVersion?: string;
}

/**
 * Construct that builds and packages a Greengrass installer with Fleet Provisioning capabilities.
 *
 * This construct creates:
 * - CodeBuild project to generate the Greengrass installer
 * - S3 bucket for storing build artifacts and the final installer package
 * - Custom resources to retrieve IoT endpoints (data and credential endpoints)
 * - Lambda functions for build execution and endpoint discovery
 * - Password-protected ZIP package containing the installer scripts
 *
 * The generated installer enables automatic Greengrass device provisioning using
 * Fleet Provisioning templates and claim certificates.
 */
export class GreengrassFleetProvisioningInstallerBuild extends Construct {
  constructor(
    scope: Construct,
    id: string,
    props: FleetProvisioningInstallerBuildProps
  ) {
    super(scope, id);

    // Get the Data endpoint of the IoT Core.
    const iotDataEndpointResource = new AwsCustomResource(
      this,
      "IoTDataEndpointResource",
      {
        onCreate: {
          service: "Iot",
          action: "describeEndpoint",
          parameters: {
            endpointType: "iot:Data-ATS",
          },
          physicalResourceId: PhysicalResourceId.of("IoTEndpoint"),
        },
        policy: AwsCustomResourcePolicy.fromSdkCalls({
          resources: AwsCustomResourcePolicy.ANY_RESOURCE,
        }),
      }
    );

    const iotDataEndpoint =
      iotDataEndpointResource.getResponseField("endpointAddress");

    // Get the Credential endpoint of the IoT Core
    const iotCredEndpointResource = new AwsCustomResource(
      this,
      "IoTCredEndpointResource",
      {
        onCreate: {
          service: "Iot",
          action: "describeEndpoint",
          parameters: {
            endpointType: "iot:CredentialProvider",
          },
          physicalResourceId: PhysicalResourceId.of("IoTEndpoint"),
        },
        policy: AwsCustomResourcePolicy.fromSdkCalls({
          resources: AwsCustomResourcePolicy.ANY_RESOURCE,
        }),
      }
    );

    const iotCredentialEndpoint =
      iotCredEndpointResource.getResponseField("endpointAddress");

    // Create a secret for ZIP compression in Secrets Manager.
    const zipSecret = new secretsmanager.Secret(this, "ZipSecret", {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: "password",
        excludePunctuation: true,
      },
    });

    // Creating a script upload bucket.
    const buildBucket = new s3.Bucket(this, "CodeBuildBucket", {
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Buckets are also deleted when the stack is deleted.
      autoDeleteObjects: true, // Objects are also deleted when buckets are deleted.
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
    });

    // Upload build-related files.
    const buildSrcPrefix = "source/";
    const s3upload = new s3deploy.BucketDeployment(this, "BuildFiles", {
      sources: [
        s3deploy.Source.asset(path.join(__dirname, "../../build_shell/")),
      ],
      destinationBucket: buildBucket,
      destinationKeyPrefix: buildSrcPrefix,
    });

    const project = new codebuild.Project(this, "CodeBuildProject", {
      source: codebuild.Source.s3({
        bucket: buildBucket,
        path: buildSrcPrefix,
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
      },
      environmentVariables: {
        PROVISIONING_TEMPLATE_NAME: {
          value: props.fleetProvisioningTemplateName,
        },
        CLAIM_CERTIFICATE_ID: {
          value: props.claimCertificateId,
        },
        CLAIM_PRIVATE_PEM_CRT_SECRET_ID: {
          value: props.claimPrivateKeySecret.secretArn,
        },
        TES_ROLE_ALIAS_NAME: {
          value: props.tokenExchangeRoleAliasName,
        },
        IOT_DATA_ENDPOINT: {
          value: iotDataEndpoint,
        },
        IOT_CRED_ENDPOINT: {
          value: iotCredentialEndpoint,
        },
        AWS_REGION: {
          value: cdk.Stack.of(this).region,
        },
        DEFAULT_THING_GROUP_NAME: {
          value: props.defaultThingGroupName,
        },
        NUCLEUS_DEFAULT_VERSION: {
          value: props.nucleusDefaultVersion ?? "",
        },
        ZIP_SECRET_NAME: {
          value: zipSecret.secretName,
        },
        INSTALL_PRIVATE_NETWORK: {
          value: props.deployPrivateNetwork ?? false ? "true" : "false",
        },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: "0.2",
        phases: {
          pre_build: {
            commands: ["echo pre_build.."],
          },
          build: {
            commands: [
              "echo Build started on `date`",
              "echo Build Greengrass installer...",
              "chmod +x build.sh",
              "./build.sh",
            ],
          },
          post_build: {
            commands: [
              `aws s3 cp ./greengrass-fleetprovisioning-installer.zip s3://${buildBucket.bucketName}/build/`,
            ],
          },
        },
        artifacts: {
          files: ["**/*"],
        },
      }),
    });

    project.node.addDependency(s3upload);

    buildBucket.grantReadWrite(project);

    project.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iot:DescribeCertificate"],
        resources: [
          `arn:aws:iot:${cdk.Stack.of(this).region}:${
            cdk.Stack.of(this).account
          }:cert/${props.claimCertificateId}`,
        ],
      })
    );

    project.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["secretsmanager:GetSecretValue"],
        resources: [props.claimPrivateKeySecret.secretArn, zipSecret.secretArn],
      })
    );

    // Creating Lambda functions for CodeBuild execution.
    const lambdaFunction = new lambda.Function(this, "CodeBuildExecLambda", {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: "lambda_function.lambda_handler",
      code: lambda.Code.fromAsset(
        path.join(__dirname, "../../lambda/code_build/")
      ),
      timeout: cdk.Duration.minutes(10),
      environment: {
        PROJECT_NAME: project.projectName,
      },
    });
    // Grant the necessary permissions to Lambda functions.
    lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["codebuild:StartBuild", "codebuild:BatchGetBuilds"],
        resources: [project.projectArn],
      })
    );

    // Set up custom resource providers to run Lambda functions.
    const provider = new custom_resources.Provider(this, "BuildExecProvider", {
      onEventHandler: lambdaFunction,
    });

    // Creating CodeBuild execution custom resources.
    // Get directory hash values to re-run custom resources if the build shell file has changed.
    const hash = this.getDirectoryHashSync(
      path.join(__dirname, "../../build_shell/")
    );
    const exec = new cdk.CustomResource(this, `BuildExecCustomResource`, {
      serviceToken: provider.serviceToken,
      properties: {
        // NOTE: When this hash value is updated, an UPDATE is triggered.
        hash: hash,
      },
    });

    new cdk.CfnOutput(this, "GreengrassInstallerPath", {
      value: `s3://${buildBucket.bucketName}/build/greengrass-fleetprovisioning-installer.zip`,
    });

    new cdk.CfnOutput(this, "ZipPasswordSecretArn", {
      value: zipSecret.secretArn,
    });
  }

  // Scan the entire file in the specified directory and calculates the hash value
  getDirectoryHashSync(directory: string): string {
    const hash = crypto.createHash("sha256");
    const files = fs.readdirSync(directory);

    for (const file of files.sort()) {
      const filePath = path.join(directory, file);
      const fileStats = fs.statSync(filePath);

      if (fileStats.isFile()) {
        const fileBuffer = fs.readFileSync(filePath);
        hash.update(fileBuffer);
      } else if (fileStats.isDirectory()) {
        hash.update(this.getDirectoryHashSync(filePath));
      }
    }

    return hash.digest("hex");
  }
}
