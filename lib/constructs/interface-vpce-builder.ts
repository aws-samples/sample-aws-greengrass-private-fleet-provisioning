// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as cdk from "aws-cdk-lib";
import {
  Duration,
  aws_ec2 as ec2,
  aws_iam as iam,
  aws_lambda as lambda,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import * as path from "path";

/** Security group rule definition (CIDR/IPv6CIDR based, single TCP/UDP port) */
export interface SecurityRule {
  /** IPv4 CIDR blocks, e.g., ["10.0.0.0/16", "192.168.0.0/16"]. Optional */
  cidr?: string | string[];
  /** IPv6 CIDR blocks, e.g., ["fd00::/64"]. Optional */
  ipv6Cidr?: string | string[];
  /** Traffic direction. Defaults to "ingress" */
  direction?: "ingress" | "egress";
  /** Protocol type. Defaults to "tcp" */
  protocol?: "tcp" | "udp";
  /** Port number (required) */
  port: number;
  /** Rule description (optional) */
  description?: string;
}

/** Service-specific configuration */
export interface EndpointServiceSpec {
  /** Full service name, e.g., "com.amazonaws.ap-northeast-1.iot.data" */
  serviceName: string;
  /** Service port. Defaults to 443 (opened in security group) */
  port?: number;
  /** Enable private DNS. Inherits defaultPrivateDnsEnabled if not specified */
  privateDnsEnabled?: boolean;
  /** Dedicated security group for this service. Uses shared SG if not specified */
  securityGroup?: ec2.ISecurityGroup;
  /** Additional security group rules for this service (applied to shared or dedicated SG) */
  ingress?: SecurityRule[];
}

/** Construct properties */
export interface InterfaceVpceBuilderProps {
  /** Target VPC (existing or new) */
  vpc: ec2.IVpc;
  /** Subnet selection for endpoints. Defaults to PRIVATE_ISOLATED */
  subnets?: ec2.SubnetSelection;
  /** List of services to create endpoints for */
  services: EndpointServiceSpec[];
  /** Existing shared security group. Creates new one if not provided */
  sharedSecurityGroup?: ec2.ISecurityGroup;
  /** Name/description for auto-generated shared security group (optional) */
  sharedSecurityGroupName?: string;
  /** Default rules for shared security group. Defaults to VPC CIDR→443/TCP if not specified */
  defaultIngress?: SecurityRule[];
  /** Default privateDnsEnabled setting. Defaults to true */
  defaultPrivateDnsEnabled?: boolean;
}

/** Construct outputs (for referencing created VPC endpoints and security groups) */
export interface InterfaceVpceBuilderOutputs {
  /** Service name → CfnVPCEndpoint mapping */
  endpoints: { [key: string]: ec2.CfnVPCEndpoint };
  /** Shared security group (auto-created or provided) */
  sharedSecurityGroup?: ec2.ISecurityGroup;
  /** Service name → security group mapping */
  serviceSecurityGroups: { [key: string]: ec2.ISecurityGroup };
}

/**
 * Interface VPC Endpoint Builder Construct
 *
 * Creates Interface VPC Endpoints only in compatible Availability Zones.
 * Uses a Lambda function to determine AZ compatibility between VPC subnets
 * and AWS service endpoints, then creates endpoints only where supported.
 *
 * Features:
 * - Automatic AZ compatibility checking
 * - S3 Gateway endpoint conflict detection
 * - Flexible security group configuration
 * - Support for multiple services with different configurations
 */
export class InterfaceVpceBuilder extends Construct {
  public readonly outputs: InterfaceVpceBuilderOutputs;

  constructor(scope: Construct, id: string, props: InterfaceVpceBuilderProps) {
    super(scope, id);

    // 1) Target subnets (default: PRIVATE_ISOLATED)
    const selection =
      props.subnets ??
      props.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED });
    const subnetIds = selection.subnets?.map((s, i) => {
      return s.subnetId;
    });

    // 2) Shared security group (use provided or create new)
    const sharedSg =
      props.sharedSecurityGroup ??
      new ec2.SecurityGroup(this, "SharedEndpointSg", {
        vpc: props.vpc,
        allowAllOutbound: true,
        description:
          props.sharedSecurityGroupName ??
          "Interface VPC Endpoint (shared) security group",
        securityGroupName: props.sharedSecurityGroupName,
      });

    // Apply default ingress rules to shared security group
    const defaultRules: SecurityRule[] =
      props.defaultIngress && props.defaultIngress.length > 0
        ? props.defaultIngress
        : [];
    applyRules(sharedSg, defaultRules);

    // 3) AZ compatibility checker Lambda function (Python)
    const crFn = new lambda.Function(this, "VpceInspectorLambda", {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: "lambda_function.lambda_handler",
      code: lambda.Code.fromAsset(
        path.join(__dirname, "../../lambda/vpce_inspector")
      ),
      timeout: Duration.seconds(30),
      initialPolicy: [
        new iam.PolicyStatement({
          actions: [
            "ec2:DescribeVpcEndpointServices",
            "ec2:DescribeSubnets",
            "ec2:DescribeAvailabilityZones",
            "ec2:DescribeVpcEndpoints",
          ],
          resources: ["*"],
        }),
      ],
    });

    // Custom Resource to determine AZ compatibility and handle S3 Gateway conflicts
    const cr = new cdk.CustomResource(this, "ResolveAzCompatibility", {
      serviceToken: crFn.functionArn,
      properties: {
        Region: cdk.Stack.of(this).region,
        VpcId: props.vpc.vpcId,
        SubnetIds: subnetIds,
        Services: props.services.map((s) => s.serviceName),
      },
    });

    const endpoints: Record<string, ec2.CfnVPCEndpoint> = {};
    const serviceSgs: Record<string, ec2.ISecurityGroup> = {};

    // 4) Create VPC Endpoints for each service
    for (const svc of props.services) {
      const name = svc.serviceName;
      const port = svc.port ?? 443;

      // Security group for this service (dedicated or shared)
      const sgForThis = svc.securityGroup ?? sharedSg;
      if (svc.ingress && svc.ingress.length > 0) {
        applyRules(sgForThis, svc.ingress);
      }
      if (port !== 443) {
        sgForThis.addIngressRule(
          ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
          ec2.Port.tcp(port),
          `Open service port ${port} (TCP) from VPC CIDR`
        );
      }

      // Get compatible subnet IDs from Custom Resource response (CSV format)
      const attrKey = sanitizeAttr(name) + "Subnets";
      const csv = cr.getAtt(attrKey).toString();
      const usableSubnetIds = cdk.Fn.split(",", csv);

      // Create Interface VPC Endpoint
      const ep = new ec2.CfnVPCEndpoint(this, `Ep-${extractServiceId(name)}`, {
        vpcId: props.vpc.vpcId,
        serviceName: name,
        vpcEndpointType: "Interface",
        privateDnsEnabled:
          svc.privateDnsEnabled ?? props.defaultPrivateDnsEnabled ?? true,
        subnetIds: usableSubnetIds,
        securityGroupIds: [sgForThis.securityGroupId],
      });

      endpoints[name] = ep;
      serviceSgs[name] = sgForThis;
    }

    this.outputs = {
      endpoints,
      sharedSecurityGroup: sharedSg,
      serviceSecurityGroups: serviceSgs,
    };
  }
}

/**
 * Helper function to apply security group rules
 * Supports both IPv4 and IPv6 CIDR blocks, ingress and egress rules
 */
function applyRules(sg: ec2.ISecurityGroup, rules: SecurityRule[]) {
  for (const r of rules) {
    const protocol = (r.protocol ?? "tcp").toLowerCase();
    const port =
      protocol === "udp" ? ec2.Port.udp(r.port) : ec2.Port.tcp(r.port);
    const dir = r.direction ?? "ingress";
    const desc = r.description;

    const peers: ec2.IPeer[] = [];

    // Handle IPv4 CIDR blocks (supports arrays)
    if (r.cidr) {
      const cidrs = Array.isArray(r.cidr) ? r.cidr : [r.cidr];
      cidrs.forEach((c) => peers.push(ec2.Peer.ipv4(c)));
    }

    // Handle IPv6 CIDR blocks (supports arrays)
    if (r.ipv6Cidr) {
      const ipv6Cidrs = Array.isArray(r.ipv6Cidr) ? r.ipv6Cidr : [r.ipv6Cidr];
      ipv6Cidrs.forEach((c) => peers.push(ec2.Peer.ipv6(c)));
    }

    if (peers.length === 0) continue;

    // Apply rules to security group
    for (const p of peers) {
      if (dir === "egress") {
        // Egress rules (not needed if allowAllOutbound=true, but available for explicit control)
        (sg as ec2.SecurityGroup).addEgressRule(p, port, desc);
      } else {
        (sg as ec2.SecurityGroup).addIngressRule(p, port, desc);
      }
    }
  }
}

/**
 * Sanitize service name for CloudFormation attribute names
 * Converts service names to PascalCase format for CloudFormation compatibility
 * Example: "com.amazonaws.us-east-1.s3" → "ComAmazonawsUsEast1S3"
 */
function sanitizeAttr(s: string): string {
  const parts = s.replace(/\./g, " ").replace(/-/g, " ").split(/\s+/);
  return parts
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join("");
}

/**
 * Extract service ID from full service name for resource naming
 * Example: "com.amazonaws.region.service.subservice" → "service-subservice"
 */
function extractServiceId(serviceName: string): string {
  const parts = serviceName.split(".");
  if (parts.length >= 4) {
    // Extract service + subservice parts (if exists)
    return parts.slice(3).join("-");
  }
  // Fallback: use the last part
  return parts[parts.length - 1];
}
