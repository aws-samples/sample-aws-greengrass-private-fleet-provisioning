// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as cdk from "aws-cdk-lib";
import { Names } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as iot from "aws-cdk-lib/aws-iot";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import * as crypto from "crypto";
import * as fs from "fs";
import * as forge from "node-forge";
import * as path from "path";
import { GreengrassFleetProvisioningInstallerBuild } from "./constructs/greengrass-fleetprovisioning-installer-build";

interface GreengrassFleetProvisioningResourceStackProps extends cdk.StackProps {
  /** Default Thing Group name for Greengrass devices when no group is specified during provisioning */
  defaultThingGroupName: string;

  /** FleetProvisioning template name */
  fleetProvisioningTemplateName?: string;

  /** Claim policy name */
  claimPolicyName?: string;

  /** Greengrass thing policy name */
  greengrassThingPolicyName?: string;

  /** Whether to configure the installer for private network deployment */
  deployPrivateNetwork?: boolean;

  /** Specify the version of Nucleus to deploy. If not specified, automatically fetches the latest version from GitHub. */
  nucleusDefaultVersion?: string;
}

/**
 * Stack that creates AWS IoT resources required for Greengrass Fleet Provisioning.
 *
 * This stack provisions:
 * - IoT Thing Group for organizing Greengrass devices
 * - IoT Policies for device permissions and fleet provisioning
 * - Fleet Provisioning Template for automated device registration
 * - Token Exchange Role and Role Alias for device authentication
 * - Claim certificate and private key for initial device authentication
 */
export class GreengrassFleetProvisioningResourceStack extends cdk.Stack {
  readonly claimPolicyName;
  readonly greengrassThingPolicyName;
  readonly csrPem: string;
  public readonly certificateId: string;
  public readonly claimPrivateKeySecret: secretsmanager.Secret;
  public readonly tokenExchangeRoleAlias: iot.CfnRoleAlias;
  public readonly fleetProvisioningTemplateName: string;
  private readonly defaultClaimPolicyNamePrefix =
    "GreengrassProvisioningClaimPolicy";
  private readonly defaultGreengrassThingPolicyNamePrefix =
    "FleetProvisioningGreengrassV2IoTThingPolicy";
  private readonly defaultTemplateNamePrefix = "GreengrassProvisionTemplate";

  constructor(
    scope: Construct,
    id: string,
    props: GreengrassFleetProvisioningResourceStackProps
  ) {
    super(scope, id, props);

    // Generate MD5 hash from unique ID for consistent short suffix
    const uniqueId = Names.uniqueId(this);
    const hashSuffix = crypto
      .createHash("md5")
      .update(uniqueId)
      .digest("hex")
      .substring(0, 8);

    // Generate unique names if not provided, with prefixes and length limits
    this.claimPolicyName =
      props.claimPolicyName ??
      `${this.defaultClaimPolicyNamePrefix}${hashSuffix}`.substring(0, 128);
    this.greengrassThingPolicyName =
      props.greengrassThingPolicyName ??
      `${this.defaultGreengrassThingPolicyNamePrefix}${hashSuffix}`.substring(
        0,
        128
      );
    this.fleetProvisioningTemplateName =
      props.fleetProvisioningTemplateName ??
      `${this.defaultTemplateNamePrefix}${hashSuffix}`.substring(0, 36);

    // Create token exchange role
    const tokenExchangeRole = new iam.Role(this, "TokenExchangeRole", {
      assumedBy: new iam.ServicePrincipal("credentials.iot.amazonaws.com"),
    });

    tokenExchangeRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "iot:DescribeCertificate",
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogStreams",
          "iot:Connect",
          "iot:Publish",
          "iot:Subscribe",
          "iot:Receive",
          "s3:GetBucketLocation",
          "s3:GetObject",
        ],
        resources: ["*"],
      })
    );

    // Create token exchange role alias
    this.tokenExchangeRoleAlias = new iot.CfnRoleAlias(
      this,
      "TokenExchangeRoleAlias",
      {
        roleArn: tokenExchangeRole.roleArn,
        roleAlias: `${tokenExchangeRole.roleName}Alias`,
      }
    );

    // Create IoT thing group
    new iot.CfnThingGroup(this, "DeviceGroup", {
      thingGroupName: props.defaultThingGroupName,
    });

    // Create IoT Policy for Fleet Provisioning
    const iotPolicy = new iot.CfnPolicy(this, "GreengrassDevicePolicy", {
      policyName: this.greengrassThingPolicyName,
      policyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: [
              "iot:Publish",
              "iot:Subscribe",
              "iot:Receive",
              "iot:Connect",
              "iot:GetThingShadow",
              "iot:UpdateThingShadow",
              "iot:DeleteThingShadow",
              "greengrass:*",
            ],
            Resource: "*",
          },
          {
            Effect: "Allow",
            Action: "iot:AssumeRoleWithCertificate",
            Resource: `arn:aws:iot:${cdk.Stack.of(this).region}:${
              cdk.Stack.of(this).account
            }:rolealias/${this.tokenExchangeRoleAlias.roleAlias}`,
          },
        ],
      },
    });

    // Create FleetProvisioningRole
    const fleetProvisioningRole = new iam.Role(this, "FleetProvisioningRole", {
      assumedBy: new iam.ServicePrincipal("iot.amazonaws.com"),
    });

    fleetProvisioningRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        "service-role/AWSIoTThingsRegistration"
      )
    );

    // Create ProvisioningTemplate
    const provisioningTemplate = new iot.CfnProvisioningTemplate(
      this,
      "GreengrassProvisioningTemplate",
      {
        templateName: this.fleetProvisioningTemplateName,
        provisioningRoleArn: fleetProvisioningRole.roleArn,
        enabled: true,
        templateBody: JSON.stringify({
          Parameters: {
            ThingName: {
              Type: "String",
            },
            ThingGroupName: {
              Type: "String",
            },
            "AWS::IoT::Certificate::Id": {
              Type: "String",
            },
          },
          Resources: {
            MyThing: {
              OverrideSettings: {
                AttributePayload: "REPLACE",
                ThingGroups: "REPLACE",
                ThingTypeName: "REPLACE",
              },
              Properties: {
                AttributePayload: {},
                ThingGroups: [
                  {
                    Ref: "ThingGroupName",
                  },
                ],
                ThingName: {
                  Ref: "ThingName",
                },
              },
              Type: "AWS::IoT::Thing",
            },
            MyPolicy: {
              Properties: {
                PolicyName: iotPolicy.policyName,
              },
              Type: "AWS::IoT::Policy",
            },
            MyCertificate: {
              Properties: {
                CertificateId: {
                  Ref: "AWS::IoT::Certificate::Id",
                },
                Status: "Active",
              },
              Type: "AWS::IoT::Certificate",
            },
          },
        }),
      }
    );

    const claimPrivateKeyPath = path.join(
      __dirname,
      "../claim-cert/claim.private.pem.key"
    );
    const claimCsrPath = path.join(__dirname, "../claim-cert/claim.csr.pem");

    if (!fs.existsSync(claimPrivateKeyPath) || !fs.existsSync(claimCsrPath)) {
      try {
        fs.mkdirSync(path.join(__dirname, "../claim-cert/"));
      } catch (e: any) {
        if (e.code == "EEXIST") {
          console.log("Directory already exists.");
        } else {
          throw e;
        }
      }
      // Create Private key
      const { privateKey, publicKey } = forge.pki.rsa.generateKeyPair(2048);
      const privateKeyPem = forge.pki.privateKeyToPem(privateKey);
      fs.writeFileSync(claimPrivateKeyPath, privateKeyPem);

      // Register claim private key in the Secret Manager.
      this.claimPrivateKeySecret = new secretsmanager.Secret(
        this,
        "ClaimPrivateKey",
        {
          secretStringValue: cdk.SecretValue.unsafePlainText(privateKeyPem),
        }
      );
      // Create CSR
      const csr = forge.pki.createCertificationRequest();
      csr.publicKey = publicKey;
      csr.setSubject([
        {
          name: "commonName",
          value: "example.com",
        },
      ]);
      csr.sign(privateKey);
      this.csrPem = forge.pki.certificationRequestToPem(csr);
      fs.writeFileSync(claimCsrPath, this.csrPem);
    } else {
      const privateKeyPem = fs.readFileSync(claimPrivateKeyPath, "utf8");
      this.claimPrivateKeySecret = new secretsmanager.Secret(
        this,
        "ClaimPrivateKey",
        {
          secretStringValue: cdk.SecretValue.unsafePlainText(privateKeyPem),
        }
      );
      this.csrPem = fs.readFileSync(claimCsrPath, "utf8");
    }

    // Create certificates from CSRs.
    const cert = new iot.CfnCertificate(this, "IoTDeviceCertificate", {
      certificateSigningRequest: this.csrPem,
      status: "ACTIVE",
    });

    // Attach IoT policies for provisioning to certificates.
    const provisioningIoTPolicy = new iot.CfnPolicy(
      this,
      "GreengrassProvisioningClaimPolicy",
      {
        policyName: this.claimPolicyName,
        policyDocument: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: "iot:Connect",
              Resource: "*",
            },
            {
              Effect: "Allow",
              Action: ["iot:Publish", "iot:Receive"],
              Resource: [
                `arn:aws:iot:${cdk.Stack.of(this).region}:${
                  cdk.Stack.of(this).account
                }:topic/$aws/certificates/create/*`,
                `arn:aws:iot:${cdk.Stack.of(this).region}:${
                  cdk.Stack.of(this).account
                }:topic/$aws/provisioning-templates/${
                  provisioningTemplate.templateName
                }/provision/*`,
              ],
            },
            {
              Effect: "Allow",
              Action: "iot:Subscribe",
              Resource: [
                `arn:aws:iot:${cdk.Stack.of(this).region}:${
                  cdk.Stack.of(this).account
                }:topicfilter/$aws/certificates/create/*`,
                `arn:aws:iot:${cdk.Stack.of(this).region}:${
                  cdk.Stack.of(this).account
                }:topicfilter/$aws/provisioning-templates/${
                  provisioningTemplate.templateName
                }/provision/*`,
              ],
            },
          ],
        },
      }
    );

    const policyprincipal = new iot.CfnPolicyPrincipalAttachment(
      this,
      "PolicyPrincipalAttachment",
      {
        policyName: this.claimPolicyName,
        principal: cert.attrArn,
      }
    );

    this.certificateId = cert.attrId;

    const installerBuild = new GreengrassFleetProvisioningInstallerBuild(
      this,
      "GreengrassInstaller",
      {
        claimCertificateId: this.certificateId,
        claimPrivateKeySecret: this.claimPrivateKeySecret,
        tokenExchangeRoleAliasName: this.tokenExchangeRoleAlias.roleAlias!,
        fleetProvisioningTemplateName: this.fleetProvisioningTemplateName,
        defaultThingGroupName: props.defaultThingGroupName,
        deployPrivateNetwork: props.deployPrivateNetwork,
      }
    );

    installerBuild.node.addDependency(policyprincipal);

    new cdk.CfnOutput(this, "DefaultThingGroup", {
      description: "Default thing group",
      value: props.defaultThingGroupName,
    });

    new cdk.CfnOutput(this, "TemplateName", {
      description: "FleetProvisioning template name",
      value: this.fleetProvisioningTemplateName,
    });

    new cdk.CfnOutput(this, "ClaimPolicyName", {
      description: "Claim policy name",
      value: this.claimPolicyName,
    });

    new cdk.CfnOutput(this, "GreengrassThingPolicyName", {
      description: "Greengrass thing policy name",
      value: this.greengrassThingPolicyName,
    });
  }
}
