# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

import os
import time
import boto3


def lambda_handler(event, context):
    request_type = event["RequestType"]

    try:
        if request_type == "Create" or request_type == "Update":
            client = boto3.client("codebuild")
            project_name = os.environ["PROJECT_NAME"]

            # Start building the CodeBuild project.
            start_response = client.start_build(projectName=project_name)
            build_id = start_response["build"]["id"]

            # Wait for the build to complete.
            while True:
                build_status = client.batch_get_builds(ids=[build_id])
                status = build_status["builds"][0]["buildStatus"]
                print(f"build_status: {status}")
                if status in ["SUCCEEDED", "FAILED", "FAULT", "STOPPED", "TIMED_OUT"]:
                    break
                # nosemgrep: arbitrary-sleep
                time.sleep(
                    10
                )  # Intentional polling delay to avoid excessive CodeBuild API calls

            # Check build results.
            if status == "SUCCEEDED":
                return
            else:

                raise Exception(f"Build failed with status: {status}")
        else:
            return

    except Exception as e:
        raise e
