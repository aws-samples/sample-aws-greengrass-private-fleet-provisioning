# Greengrass Fleet Provisioning Resource CDK with Private Network

This CDK project creates resources for FleetProvisioning with Greengrass and a dedicated Greengrass installer for deploying with FleetProvisioning. The project also allows you to create resources for using Greengrass in a private network, and if you choose to create a private network, the Greengrass installer will also be private network compatible.

For more information on FleetProvisioning and private network connections in Greengrass, see below.

https://docs.aws.amazon.com/greengrass/v2/developerguide/fleet-provisioning.html
https://docs.aws.amazon.com/greengrass/v2/developerguide/vpc-interface-endpoints.html

## How to use

### Deployment execution environment

It is assumed that the environment in which the deployment commands are executed has the following installed and that the AWS CLI has been pre-configured with credential information to allow connection to the AWS environment.

- Node.js (v18 or higher)
  - Required for CDK execution environment.
- AWS CLI (v2)
  - Required for CDK execution environment.
  - When using the CDK for the first time, it must be run as a user with partial AdministratorAccsess rights.
- Target VPCs for which the environment is to be built (For Private Network settings)
  - To set up a PrivateNetwork, the target VPC must have been created in advance and a Private Subnet must exist.
    - VPC endpoints must have available Availability Zones for iot.credentials, iot.data, greengrass, and s3.
    - The S3 Gateway, DNS hostname, and DNS resolution must be enabled.

Cloud9 or CloudShell can be used as the CDK execution environment. This time, the procedure for deploying using CloudShell is described below.

### Deployment of project files

Log in to the AWS Console as a user with AdministratorAccess rights.  
Click on the word CludShell at the bottom of the AWS Console.

![](/imgs/deploy01.jpg)

From the `Action` menu, select `Upload file` and upload the compressed file for this CDK project

![](/imgs/deploy02.jpg)

Wait for the upload to complete. The file will be uploaded to the cloudshell-user's home directory.

![](/imgs/deploy03.jpg)

CloudShell's home directory (persistent storage) is limited to 1G. This project will exceed 1G if the related libraries are loaded, so move the project to the tmp directory with the following command.

```bash
mv sample-aws-greengrass-private-fleet-provisioning-main.zip /tmp
cd /tmp
```

Extract the project file and prepare it for execution.

```bash
unzip sample-aws-greengrass-private-fleet-provisioning-main.zip
```

After unzipping the project, install the relevant node packages. To install the packages, go to the deployment directory and run the npm install command.

```bash
cd sample-aws-greengrass-private-fleet-provisioning-main
npm install
```

The required packages are installed in the `node_modules` directory.

### Preparation for CDK execution

#### Changing settings

Open `config.ts` in the project root directory and change the configuration values to match the environment in which you are deploying.

```typescript
export const config = {
  defaultThingGroupName: "FleetprovisioningDeployGroup",
  deployPrivateNetwork: true,
  privateNetworkSetting: {
    vpcId: "vpc-xxxxxxxxxxxxxxxxx",
    allowIpV4: ["0.0.0.0/0"],
  },
};
```

| Value                           | Description                                                                                                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| defaultThingGroupName           | In this project, the created Greengrass devices will always belong to any ThingGroup. The ThingGroup to which they belong can be specified during installation, but if not, they will belong to the ThingGroup specified here. |
| deployPrivateNetwork            | `true` if the Greengrass environment is created in a private network, `false` if the Greengrass device is operated in a public internet environment                                                                            |
| privateNetworkSetting.vpcId     | If you want to create an environment in a Private Network, specify the target VPC                                                                                                                                              |
| privateNetworkSetting.allowIpV4 | Specify the IPv4 range of Greengrass devices that are allowed to connect in the private environment by CIDR. If not specified, IPv4 access will be denied                                                                      |

#### CDK bootstrap

If the `cdk` command is not installed, pre-install it with `sudo npm install -g aws-cdk`. (This is not required as it is available in the CloudShell environment).

Only the first time the `cdk` command is used, the following command (`cdk bootstrap`) should be executed. If it has already been executed in the target account & region, it is not necessary to execute it.

```bash
$ cdk bootstrap

⏳  Bootstrapping environment aws://XXXXXXXXXXXX/ap-northeast-1...
Trusted accounts for deployment: (none)
Trusted accounts for lookup: (none)
Using default execution policy of 'arn:aws:iam::aws:policy/AdministratorAccess'. Pass '--cloudformation-execution-policies' to customize.
CDKToolkit: creating CloudFormation changeset...
 ✅  Environment aws://XXXXXXXXXXXX/ap-northeast-1 bootstrapped.
```

### About stacks included in the CDK implementation

- _GreengrassFleetprovisioningResourceStack_
  - Create the necessary cloud resources (e.g. ProvisioningTemplate, IoTPolicy) for FleetProvisioning.
- _GreengrassFleetProvisioningInstallerBuildStack_
  - Create a GreegrassInstaller that uses FleetProvisioning to perform the installation.
  - The `GreengrassFreetprovisioningResourceStack` must be pre-created to run this stack
- _GreengrassPrivateNetworkStack_
  - Create resources (e.g. PrivateLink) to make Greengrass available in private network environments

## Deploying the environment

To deploy all stacks, execute the following command.

```bash
cdk deploy --require-approval never --all
```

Alternatively, to deploy each stack separately, execute the following commands

```bash
cdk deploy <StackName>
```

- Dependencies are set up between stacks, so stacks that depend on the stack being deployed are also deployed as required.

If the version of the CDK installed in CloudShell does not match the version of the CDK and an error occurs, you can also use the following command to install aws-cdk under the project local and run the `cdk` command using the `npx` command.

```bash
npm install aws-cdk
npx cdk deploy --require-approval never --all
```

When the command is executed, the resources to be created in the cloud are resolved and the creation of the environment starts.
When the environment is created, the following message is displayed. Creating the environment will take a few minutes.

```bash
...

✅  GreengrassFleetprovisioningResourceStack

✨  Deployment time: 280.04s

Outputs:
GreengrassFleetprovisioningResourceStack.ClaimPolicyName = GreengrassProvisioningClaimPolicyXXXXXXXX
GreengrassFleetprovisioningResourceStack.DefaultThingGroup = FleetprovisioningDeployGroup
GreengrassFleetprovisioningResourceStack.GreengrassInstallerGreengrassInstallerPathXXXXXXXX = s3://greengrassfleetprovisioni-greengrassinstallercodeb-xxxxxxxxxxxx/build/greengrass-fleetprovisioning-installer.zip
GreengrassFleetprovisioningResourceStack.GreengrassInstallerZipPasswordSecretArnXXXXXXXX = arn:aws:secretsmanager:region:XXXXXXXXXXXX:secret:GreengrassInstallerZipSecre-xxxxxxxxxxxx-xxxxxx
GreengrassFleetprovisioningResourceStack.GreengrassThingPolicyName = FleetProvisioningGreengrassV2IoTThingPolicyXXXXXXXX
GreengrassFleetprovisioningResourceStack.TemplateName = GreengrassProvisionTemplateXXXXXXXX
Stack ARN:
arn:aws:cloudformation:region:XXXXXXXXXXXX:stack/GreengrassFleetprovisioningResourceStack/XXXXXXXX-XXXX-XXXXX-XXXX-XXXXXXXXXXXX

✨  Total time: 284.35s
```

This completes the deployment of the environment.

`GreengrassInstallerGreengrassInstallerPathXXXXXXXX` in the Outputs of the `GreengrassFleetprovisioningResourceStack` run is the bucket where the installer is stored and `GreengrassInstallerZipPasswordSecretArnXXXXXXXX` is the secret information of the secret manager with the password to unzipping the installer.

This can be found in the details of each stack in the [CloudFormation console](https://console.aws.amazon.com/cloudformation/home).

### Deleting the environment

To delete the environment, run the CDK `destroy` command.

> [!NOTE]
>
> To delete the `GreengrassFleetprovisioningResourceStack`, you must first detach the policy (the policy name is referenced in the `GreengrassThingPolicyName` of the `GreengrassFleetprovisioningResourceStack`) associated with the certificate assigned to the device from all Greengrass devices installed using the installer.

```bash
cdk destroy --all
```

The following command can also be used to delete each stack individually.

```bash
cdk destroy <StackName>
```

Note: If a Greengrass device is provisioned in the created environment, the deletion will fail because it is tied to a resource such as Policy created in the CDK. In this case, use CloudFormation to force the environment to be deleted or delete the definitions of the tied devices. See below for information on deleting and uninstalling devices.
https://docs.aws.amazon.com/greengrass/v2/developerguide/uninstall-greengrass-core-v2.html

## How to use the installer

As a result of the CDK run, a dedicated installer is created and a Zip compressed version is output to S3. This ZIP file is compressed with a password, which is stored in the Secret Manager.

After unzipping the Zip, you will find the installation shells install.sh (for Linux) and install.ps1 (for Windows) in the folder.
(These installers are intended to be executed in the directory where the installer is located.)

> [!NOTE]
>
> The device environment must be set up beforehand, and AWS credentials must be configured for installation. For details, please refer to the URL below.
>
> https://docs.aws.amazon.com/greengrass/v2/developerguide/quick-installation.html

```bash
chmod +x install.sh
install.sh <ThingName> [ThingGroupName]
```

The installer command takes two arguments, the first being the thing name and the second the name of the thing group to which the Thing belongs.
The Thing group is an optional argument; if not specified, it belongs to the default group specified in config.ts.

```bash
install.sh MyGreengrassDevice
```

Alternatively, you can specify any Thing group name as follows.

```bash
install.sh MyGreengrassDevice MyGreengrassGroup
```

> [!NOTE]
> If a Thing group is specified, the group must be created beforehand.

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This library is licensed under the MIT-0 License. See the [LICENSE](./LICENSE) file.
