#!/usr/bin/env node

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { GreengrassFleetProvisioningResourceStack } from "../lib/greengrass-fleetprovisioning-resource-stack";
import { GreengrassPrivateNetworkStack } from "../lib/greengrass-private-network-stack";
import { config } from "../config";
// import { AwsSolutionsChecks } from "cdk-nag";
// import { Aspects } from "aws-cdk-lib";

const app = new cdk.App();
// Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

// Common environment configuration for all stacks
const env = {
  account: process.env.CDK_DEPLOY_ACCOUNT || process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEPLOY_REGION || process.env.CDK_DEFAULT_REGION,
};

// Create a cloud resource for FleetProvisioning in Greengrass
const ggResouece = new GreengrassFleetProvisioningResourceStack(
  app,
  "GreengrassFleetprovisioningResourceStack",
  {
    env,
    defaultThingGroupName: config.defaultThingGroupName,
    deployPrivateNetwork: config.deployPrivateNetwork,
  }
);

// Create the resources required to connect Greengrass to the specified private network.
// Only create the stack if private network deployment is enabled and vpcId is specified.
if (config.deployPrivateNetwork && config.privateNetworkSetting.vpcId) {
  new GreengrassPrivateNetworkStack(app, "GreengrassPrivateNetworkStack", {
    env,
    vpcId: config.privateNetworkSetting.vpcId,
    allowIpV4: config.privateNetworkSetting.allowIpV4,
  });
}
