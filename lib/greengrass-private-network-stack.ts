// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as route53 from "aws-cdk-lib/aws-route53";
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
} from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
import { InterfaceVpceBuilder } from "./constructs/interface-vpce-builder";

interface GreengrassPrivateNetworkStackProps extends cdk.StackProps {
  /** VPC ID where private network resources will be deployed */
  vpcId: string;

  /** List of IPv4 CIDR blocks allowed to access Greengrass services through VPC endpoints */
  allowIpV4: string[];
}

/**
 * Stack that creates VPC resources for running Greengrass in a private network environment.
 *
 * This stack provisions:
 * - VPC Interface Endpoints for AWS IoT Core, IoT Credentials, IoT Greengrass, and S3
 * - Security Groups with appropriate ingress rules for Greengrass communication
 * - Private Route53 Hosted Zone for IoT endpoint DNS resolution
 * - DNS A records mapping IoT endpoints to VPC interface endpoints
 *
 * This enables Greengrass devices in private subnets to communicate with AWS services
 * without requiring internet gateway or NAT gateway connectivity.
 */
export class GreengrassPrivateNetworkStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props: GreengrassPrivateNetworkStackProps
  ) {
    super(scope, id, props);

    const vpc = ec2.Vpc.fromLookup(this, "VpcLookup", {
      vpcId: props.vpcId,
    });

    const vpceBuilder = new InterfaceVpceBuilder(this, "Endpoints", {
      vpc,
      defaultPrivateDnsEnabled: true,
      defaultIngress: [],
      services: [
        {
          serviceName: `com.amazonaws.${this.region}.iot.credentials`,
          privateDnsEnabled: false,
          ingress: [
            { cidr: props.allowIpV4, port: 443, description: "Allow HTTPS" },
          ],
        },
        {
          serviceName: `com.amazonaws.${this.region}.iot.data`,
          privateDnsEnabled: false,
          ingress: [
            { cidr: props.allowIpV4, port: 443, description: "Allow HTTPS" },
            {
              cidr: props.allowIpV4,
              port: 8443,
              description: "Allow HTTPS(IoT)",
            },
            {
              cidr: props.allowIpV4,
              port: 8883,
              description: "Allow MQTT",
            },
          ],
        },
        {
          serviceName: `com.amazonaws.${this.region}.greengrass`,
          ingress: [
            { cidr: props.allowIpV4, port: 443, description: "Allow HTTPS" },
          ],
        },
        {
          serviceName: `com.amazonaws.${this.region}.s3`,
          ingress: [
            { cidr: props.allowIpV4, port: 443, description: "Allow HTTPS" },
          ],
        },
      ],
    });

    // VPC endpointの作成後にPrivate Hosted Zoneを作成（DNS競合を避けるため）
    const privateZone = new route53.PrivateHostedZone(
      this,
      "PrivateHostedZone",
      {
        vpc,
        zoneName: `iot.${this.region}.amazonaws.com`,
      }
    );

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

    const splitDataEndpoint = cdk.Fn.split(
      ".",
      iotDataEndpointResource.getResponseField("endpointAddress")
    );

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

    const splitCredEndpoint = cdk.Fn.split(
      ".",
      iotCredEndpointResource.getResponseField("endpointAddress")
    );

    const iotDataServiceName = `com.amazonaws.${this.region}.iot.data`;
    const iotCredServiceName = `com.amazonaws.${this.region}.iot.credentials`;

    // ENI IDからIPアドレスを取得するCustom Resource
    const getEniIpAddress = (eniId: string, resourceId: string) => {
      return new AwsCustomResource(this, `GetEniIp-${resourceId}`, {
        onCreate: {
          service: "EC2",
          action: "describeNetworkInterfaces",
          parameters: {
            NetworkInterfaceIds: [eniId],
          },
          physicalResourceId: PhysicalResourceId.of(`eni-ip-${resourceId}`),
        },
        policy: AwsCustomResourcePolicy.fromSdkCalls({
          resources: AwsCustomResourcePolicy.ANY_RESOURCE,
        }),
      });
    };

    // IoT Data endpointのENI IDからIPアドレスを取得
    const iotDataEniId = cdk.Fn.select(
      0,
      vpceBuilder.outputs.endpoints[iotDataServiceName].attrNetworkInterfaceIds
    );
    const iotDataIpResource = getEniIpAddress(iotDataEniId, "iotdata");
    const iotDataIpAddress = iotDataIpResource.getResponseField(
      "NetworkInterfaces.0.PrivateIpAddress"
    );

    const iotDataRecord = new route53.ARecord(this, "IoTDataRecord", {
      zone: privateZone,
      recordName: cdk.Fn.select(0, splitDataEndpoint),
      target: route53.RecordTarget.fromValues(iotDataIpAddress),
    });

    // IoT Credentials endpointのENI IDからIPアドレスを取得
    const iotCredEniId = cdk.Fn.select(
      0,
      vpceBuilder.outputs.endpoints[iotCredServiceName].attrNetworkInterfaceIds
    );
    const iotCredIpResource = getEniIpAddress(iotCredEniId, "iotcred");
    const iotCredIpAddress = iotCredIpResource.getResponseField(
      "NetworkInterfaces.0.PrivateIpAddress"
    );

    const iotCredRecord = new route53.ARecord(this, "IoTCredRecord", {
      zone: privateZone,
      recordName: `${cdk.Fn.select(0, splitCredEndpoint)}.${cdk.Fn.select(
        1,
        splitCredEndpoint
      )}`,
      target: route53.RecordTarget.fromValues(iotCredIpAddress),
    });
  }
}
