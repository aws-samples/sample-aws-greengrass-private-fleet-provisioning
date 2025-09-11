# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

import boto3
import json
import urllib3
from typing import Dict, List


def _sanitize_attr(s: str) -> str:
    # Convert to valid CloudFormation attribute name format
    # com.amazonaws.us-east-1.s3 -> ComAmazonawsUsEast1S3
    parts = s.replace(".", " ").replace("-", " ").split()
    return "".join(word.capitalize() for word in parts)


def send_response(
    event, context, response_status, response_data=None, physical_resource_id=None
):
    """Send Custom Resource response to CloudFormation"""
    response_data = response_data or {}

    response_body = {
        "Status": response_status,
        "Reason": f"See CloudWatch Log Stream: {context.log_stream_name}",
        "PhysicalResourceId": physical_resource_id or context.log_stream_name,
        "StackId": event["StackId"],
        "RequestId": event["RequestId"],
        "LogicalResourceId": event["LogicalResourceId"],
        "Data": response_data,
    }

    json_response_body = json.dumps(response_body)

    headers = {"content-type": "", "content-length": str(len(json_response_body))}

    http = urllib3.PoolManager()
    try:
        response = http.request(
            "PUT", event["ResponseURL"], body=json_response_body, headers=headers
        )
        print(f"Status code: {response.status}")
    except Exception as e:
        print(f"Failed to send response: {e}")


def lambda_handler(event, context):
    try:
        # event contains ResourceProperties and RequestType
        props = event.get("ResourceProperties", {})
        region = props.get("Region")
        vpc_id = props.get("VpcId")
        subnet_ids: List[str] = props.get("SubnetIds", []) or []
        services: List[str] = props.get("Services", []) or []

        physical_resource_id = f"vpce-inspector-{vpc_id or 'unknown'}"

        if event.get("RequestType") == "Delete":
            # On deletion, return empty attributes (no action needed)
            send_response(event, context, "SUCCESS", {}, physical_resource_id)
            return

        if not region or not subnet_ids or not services:
            send_response(event, context, "FAILED", {}, physical_resource_id)
            return

        ec2 = boto3.client("ec2", region_name=region)

        # Check existing VPC endpoints
        existing_endpoints = ec2.describe_vpc_endpoints(
            Filters=[{"Name": "vpc-id", "Values": [vpc_id]}]
        )

        # Check if S3 Gateway endpoint already exists
        has_s3_gateway = any(
            ep.get("ServiceName") == f"com.amazonaws.{region}.s3"
            and ep.get("VpcEndpointType") == "Gateway"
            for ep in existing_endpoints.get("VpcEndpoints", [])
        )

        # If S3 Gateway exists, exclude Interface type
        original_services = services[:]
        if has_s3_gateway:
            services = [svc for svc in services if not svc.endswith(".s3")]
            print(f"S3 Gateway endpoint exists, excluding S3 Interface endpoint")

        # 1) Get subnet -> AZ name mapping
        subnets_resp = ec2.describe_subnets(SubnetIds=subnet_ids)
        subnet_id_to_az: Dict[str, str] = {}
        for sn in subnets_resp.get("Subnets", []):
            sid = sn.get("SubnetId")
            az = sn.get("AvailabilityZone")
            if sid and az:
                subnet_id_to_az[sid] = az

        if not subnet_id_to_az:
            send_response(event, context, "FAILED", {}, physical_resource_id)
            return

        # 2) Get supported AZ names for each service
        svc_resp = ec2.describe_vpc_endpoint_services(ServiceNames=services)
        details = svc_resp.get("ServiceDetails", []) or []

        # 3) Calculate intersection and return as attributes (<SanitizedServiceName>Subnets)
        attributes: Dict[str, str] = {}

        # Generate attributes for target services
        for svc in services:
            det = next((d for d in details if d.get("ServiceName") == svc), None)
            supported_azs = set(det.get("AvailabilityZones", []) if det else [])

            # Select only one subnet per AZ
            az_to_subnet: Dict[str, str] = {}
            for sid, az in subnet_id_to_az.items():
                if az in supported_azs and az not in az_to_subnet:
                    az_to_subnet[az] = sid

            usable_subnet_ids = list(az_to_subnet.values())
            attr_name = f"{_sanitize_attr(svc)}Subnets"
            attributes[attr_name] = ",".join(usable_subnet_ids)
            print(f"Service: {svc} -> Attribute: {attr_name} = {attributes[attr_name]}")

        # For excluded services (like S3), return the first subnet ID
        # (VPC endpoint will actually be created, but Gateway endpoint takes priority)
        first_subnet_id = list(subnet_id_to_az.keys())[0] if subnet_id_to_az else ""
        for svc in original_services:
            if svc not in services:
                attr_name = f"{_sanitize_attr(svc)}Subnets"
                attributes[attr_name] = first_subnet_id
                print(
                    f"Excluded service: {svc} -> Attribute: {attr_name} = {first_subnet_id} (Gateway endpoint exists, Interface endpoint will be redundant)"
                )

        print(f"Final attributes: {attributes}")
        send_response(event, context, "SUCCESS", attributes, physical_resource_id)

    except Exception as e:
        print(f"Error: {e}")
        send_response(
            event,
            context,
            "FAILED",
            {},
            f"vpce-inspector-{props.get('VpcId', 'unknown')}",
        )
