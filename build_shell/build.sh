#!/bin/bash

# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

set -e
set -o pipefail

error_handler() {
  echo "Error occurred in script at line: ${1}"
  exit 1
}

cleanup() {
    rm -rf "$CLAIM_CERT_DIR" 2>/dev/null || true
    rm -f greengrass-nucleus-latest.zip 2>/dev/null || true
}

# Set error handler and cleanup
trap 'error_handler $LINENO' ERR
trap cleanup EXIT

# Check required commands
command -v jq >/dev/null 2>&1 || { echo "jq is required but not installed. Aborting." >&2; exit 1; }
command -v aws >/dev/null 2>&1 || { echo "AWS CLI is required but not installed. Aborting." >&2; exit 1; }

CLAIM_CERT_DIR="claim_cert"

GG_ROOT_PATH="/greengrass/v2"
ROOT_CA_FILE="AmazonRootCA1.pem"

CLAIM_CERTIFICATE_FILE="claim.pem.crt"
CLAIM_PRIVATE_KEY_FILE="claim.private.pem.key"

CLAIM_PRIVATE_PEM_CRT_PATH="$CLAIM_CERT_DIR/$CLAIM_PRIVATE_KEY_FILE"
CLAIM_CERTIFICATE_PATH="$CLAIM_CERT_DIR/$CLAIM_CERTIFICATE_FILE"
ROOT_CA_PATH="$GG_ROOT_PATH/$ROOT_CA_FILE"
FLEET_PROVISIONING_PLUGIN="aws.greengrass.FleetProvisioningByClaim.jar"

# Check required environment variables
for var in TES_ROLE_ALIAS_NAME AWS_REGION IOT_DATA_ENDPOINT IOT_CRED_ENDPOINT CLAIM_CERTIFICATE_ID CLAIM_PRIVATE_PEM_CRT_SECRET_ID PROVISIONING_TEMPLATE_NAME DEFAULT_THING_GROUP_NAME ZIP_SECRET_NAME; do
    if [ -z "${!var}" ]; then
        echo "$var not found."
        exit 1
    fi
done

# Get latest Greengrass Nucleus version from GitHub if not provided
if [ -z "$NUCLEUS_DEFAULT_VERSION" ]; then
    echo "NUCLEUS_DEFAULT_VERSION not provided, fetching latest version from GitHub..."
    NUCLEUS_DEFAULT_VERSION=$(curl -s https://api.github.com/repos/aws-greengrass/aws-greengrass-nucleus/releases/latest | jq -r '.tag_name' | sed 's/^v//')
    if [ -z "$NUCLEUS_DEFAULT_VERSION" ] || [ "$NUCLEUS_DEFAULT_VERSION" = "null" ]; then
        echo "Failed to fetch latest version from GitHub. Please set NUCLEUS_DEFAULT_VERSION manually."
        exit 1
    fi
    echo "Using latest Greengrass Nucleus version: $NUCLEUS_DEFAULT_VERSION"
else
    echo "Using provided Greengrass Nucleus version: $NUCLEUS_DEFAULT_VERSION"
fi

echo "Certificate ID: $CLAIM_CERTIFICATE_ID"

mkdir $CLAIM_CERT_DIR

# Download certificate
aws iot describe-certificate \
    --certificate-id "$CLAIM_CERTIFICATE_ID" \
    --query "certificateDescription.certificatePem" \
    --output text > $CLAIM_CERTIFICATE_PATH

# Retrieve and store the private key from the Secret Manager
aws secretsmanager get-secret-value \
    --secret-id "$CLAIM_PRIVATE_PEM_CRT_SECRET_ID" \
    | jq -r '.SecretString' > $CLAIM_PRIVATE_PEM_CRT_PATH

# Check that the private key has been downloaded
if [ -s "$CLAIM_PRIVATE_PEM_CRT_PATH" ]; then
    echo "Claim private key successfully downloaded to $CLAIM_PRIVATE_PEM_CRT_PATH"
else
    echo "Failed to download the claim private key."
    exit 1
fi

# Download files
if ! curl -f -s https://d2s8p88vqu9w66.cloudfront.net/releases/greengrass-nucleus-latest.zip > greengrass-nucleus-latest.zip; then
    echo "Failed to download greengrass-nucleus-latest.zip"
    exit 1
fi

if ! curl -f -o $ROOT_CA_FILE https://www.amazontrust.com/repository/AmazonRootCA1.pem; then
    echo "Failed to download AmazonRootCA1.pem"
    exit 1
fi

if ! curl -f -o $FLEET_PROVISIONING_PLUGIN https://d2s8p88vqu9w66.cloudfront.net/releases/aws-greengrass-FleetProvisioningByClaim/fleetprovisioningbyclaim-latest.jar; then
    echo "Failed to download fleetprovisioning plugin"
    exit 1
fi

# Verify downloaded files
if [ -s "$ROOT_CA_FILE" ]; then
    echo "AmazonRootCA1.pem successfully downloaded"
else
    echo "Failed to download the AmazonRootCA."
    exit 1
fi

if [ -s "$FLEET_PROVISIONING_PLUGIN" ]; then
    echo "fleetprovisioning plugin successfully downloaded"
else
    echo "Failed to download the fleetprovisioning plugin."
    exit 1
fi

unzip greengrass-nucleus-latest.zip -d GreengrassInstaller && rm greengrass-nucleus-latest.zip

# copy claim certs
cp -R $CLAIM_CERT_DIR ./GreengrassInstaller

# copy root ca
cp $ROOT_CA_FILE ./GreengrassInstaller

# copy fleet provisioning plugin
cp $FLEET_PROVISIONING_PLUGIN ./GreengrassInstaller

cd GreengrassInstaller


# Generate config.yaml.template
generate_config_yaml() {
    cat << EOF > ./config.yaml.template
---
services:
  aws.greengrass.Nucleus:
    version: "$NUCLEUS_DEFAULT_VERSION"
EOF

    if [ "$INSTALL_PRIVATE_NETWORK" == "true" ]; then
        cat << EOF >> ./config.yaml.template
    configuration:
      greengrassDataPlaneEndpoint: "iotdata"
EOF
    fi

    if [ "$INSTALL_PRIVATE_NETWORK" == "true" ] && [ "$AWS_REGION" == "us-east-1" ]; then
        cat << EOF >> ./config.yaml.template
      s3EndpointType: "REGIONAL"
EOF
    fi

    cat << EOF >> ./config.yaml.template
  aws.greengrass.FleetProvisioningByClaim:
    configuration:
      rootPath: "$GG_ROOT_PATH"
      awsRegion: "$AWS_REGION"
      iotDataEndpoint: "$IOT_DATA_ENDPOINT"
      iotCredentialEndpoint: "$IOT_CRED_ENDPOINT"
      iotRoleAlias: "$TES_ROLE_ALIAS_NAME"
      provisioningTemplate: "$PROVISIONING_TEMPLATE_NAME"
      claimCertificatePath: "$GG_ROOT_PATH/$CLAIM_CERTIFICATE_PATH"
      claimCertificatePrivateKeyPath: "$GG_ROOT_PATH/$CLAIM_PRIVATE_PEM_CRT_PATH"
      rootCaPath: "$ROOT_CA_PATH"
      templateParameters:
        ThingName: "<THING_NAME>"
        ThingGroupName: "<THING_GROUP_NAME>"
EOF
}

generate_config_yaml

# Generate shell scripts for installation(Linux)
cat << EOF > ./install.sh
#!/bin/bash

# Check the number of arguments.
if [ "\$#" -lt 1 ]; then
  echo "Error: At least one argument is required: thingName."
  echo "Usage: \$0 <thingName> [thingGroupName]"
  exit 1
fi

thingName=\$1

# Set default value for thingGroupName if not provided.
if [ -z "\$2" ]; then
  thingGroupName="$DEFAULT_THING_GROUP_NAME"  # default group name
else
  thingGroupName=\$2
fi

sudo mkdir -p $GG_ROOT_PATH
sudo cp -R $CLAIM_CERT_DIR $GG_ROOT_PATH/
sudo cp $ROOT_CA_FILE $GG_ROOT_PATH/

sed -e "s/<THING_NAME>/\$thingName/g" -e "s/<THING_GROUP_NAME>/\$thingGroupName/g" "config.yaml.template" > "config.yaml"

sudo -E java -Droot="$GG_ROOT_PATH" -Dlog.store=FILE -jar ./lib/Greengrass.jar --trusted-plugin ./$FLEET_PROVISIONING_PLUGIN --init-config ./config.yaml --component-default-user ggc_user:ggc_group --setup-system-service true
EOF

# Generate shell scripts for installation(Windows)
cat << EOF > ./install.ps1
# Check the number of arguments.
if (\$Args.Count -lt 1) {
    Write-Host "Error: At least one argument is required: thingName."
    Write-Host "Usage: .\script.ps1 <thingName> [thingGroupName]"
    exit 1
}

\$thingName = \$Args[0]

if (\$args.Count -lt 2) {
    \$thingGroupName = "$DEFAULT_THING_GROUP_NAME"  # default group name
} else {
    \$thingGroupName = \$args[1]
}

New-Item "C:$GG_ROOT_PATH" -ItemType Directory -ErrorAction SilentlyContinue
Copy-Item -Path "$CLAIM_CERT_DIR" -Destination "C:$GG_ROOT_PATH/" -Recurse
Copy-Item -Path "$ROOT_CA_FILE" -Destination "C:$GG_ROOT_PATH/"

\$config = Get-Content config.yaml.template
\$config = \$config -replace "<THING_NAME>", \$thingName
\$config = \$config -replace "<THING_GROUP_NAME>", \$thingGroupName
Set-Content config.yaml \$config

java -Droot="C:$GG_ROOT_PATH" "-Dlog.store=FILE" -jar ./lib/Greengrass.jar --trusted-plugin ./$FLEET_PROVISIONING_PLUGIN --init-config ./config.yaml --component-default-user ggc_user --setup-system-service true
EOF

# Load password for zip securely
ZIP_PASSWORD=$(aws secretsmanager get-secret-value --secret-id "$ZIP_SECRET_NAME" | jq -r '.SecretString' | jq -r '.password')
cd ..

# # Compress installation files with password Zip
zip --password=$ZIP_PASSWORD -r greengrass-fleetprovisioning-installer.zip ./GreengrassInstaller/
