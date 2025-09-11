# Greengrass Fleet Provisioning Resource CDK with Private Network

この CDK プロジェクトでは、Greengrass を使った FleetProvisioning のためのリソースと、FleetProvisioning でデプロイするための専用の Greengrass インストーラを作成します。また、このプロジェクトでは、閉域ネットワークで Greengrass を利用するためのリソースも作成することができ、閉域ネットワークを利用する場合は、Greengrass のインストーラも閉域ネットワークに対応したものになります。

Greengrass の FleetProvisioning とプライベートネットワーク接続の詳細については、以下をご覧ください。

https://docs.aws.amazon.com/greengrass/v2/developerguide/fleet-provisioning.html
https://docs.aws.amazon.com/greengrass/v2/developerguide/vpc-interface-endpoints.html

## 使い方

### デプロイ実行環境

デプロイコマンドを実行する環境には、以下のものがインストールされており、AWS CLI に AWS 環境への接続を許可するためのクレデンシャル情報があらかじめ設定されていることを前提としています。

- Node.js (v18 or higher)
  - CDK 実行環境に必要
- AWS CLI (v2)
  - CDK 実行環境に必要
  - CDK を初めて使用する場合は、一部 AdministratorAccess 権限を持つユーザーとして実行する必要があります。
- 環境構築対象 VPC (閉域環境セットアップを行う場合)
  - PrivateNetwork を設定するには、事前にターゲット VPC が作成され、Private Subnet が存在している必要があります。
    - VPC endpoints の iot.credentials, iot.data, greengrass, s3 対応の AZ が存在する必要があります。
    - S3 ゲートウェイ、DNS ホスト名、DNS 解決が有効になっている必要があります。

CDK の実行環境として Cloud9 または CloudShell を利用することができます。ここでは CloudShell を使ってデプロイする手順を説明します。

### プロジェクトファイルの配置

AdministratorAccess 権限を持つユーザーで AWS Console にログインします。
AWS Console の下部にある CludShell という文字をクリックします。

![](/imgs/deploy01.jpg)

`アクション`メニューから、`ファイルのアップロード`を選択し、CDK プロジェクトの圧縮ファイルをアップロードします。

![](/imgs/deploy02.jpg)

アップロードが完了するまで待ちます。ファイルは cloudshell-user のホームディレクトリにアップロードされます。

![](/imgs/deploy03.jpg)

CloudShell のホームディレクトリ（永続ストレージ）は 1G に制限されています。このプロジェクトは関連ライブラリを読み込むと 1G を超えるので、以下のコマンドで tmp ディレクトリに移動します。

```bash
mv sample-aws-greengrass-private-fleet-provisioning-main.zip /tmp
cd /tmp
```

プロジェクトファイルを展開し、実行の準備を行います。

```bash
unzip sample-aws-greengrass-private-fleet-provisioning-main.zip
```

プロジェクトを解凍したら、関連する node パッケージをインストールします。パッケージをインストールするには、デプロイディレクトリに移動して npm install コマンドを実行します。

```bash
cd sample-aws-greengrass-private-fleet-provisioning-main
npm install
```

必要なパッケージは `node_modules` ディレクトリにインストールされます。

### CDK 実行の準備

#### 設定値の変更

プロジェクトのルートディレクトリにある `config.ts` を開き、設定値をデプロイする環境に合わせて変更してください。

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

| 値                              | 説明                                                                                                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| defaultThingGroupName           | このプロジェクトでは、作成された Greengrass デバイスは常に任意の ThingGroup に属します。所属する ThingGroup はインストール時に指定できますが、指定しない場合はここで指定した ThingGroup に所属します。 |
| deployPrivateNetwork            | Greengrass 環境を閉域ネットワークに作成する場合は`true`、Greengrass デバイスがパブリックインターネット環境で運用する場合は`false`と設定します                                                          |
| privateNetworkSetting.vpcId     | 閉域ネットワークに環境を作成する場合は、ターゲットとなる VPC の VpcId を指定します。                                                                                                                   |
| privateNetworkSetting.allowIpV4 | 閉域環境で接続を許可する Greengrass デバイスの IPv4 範囲を CIDR で指定します。指定しない場合、IPv4 でのアクセスは拒否されます。                                                                        |

#### CDK bootstrap

`cdk`コマンドがインストールされていない場合は、`sudo npm install -g aws-cdk`で事前にインストールしてください。(CloudShell 環境では初めから利用可能なので必要ありません）

初めて `cdk` コマンドを使用する場合のみ、以下のコマンド(`cdk bootstrap`)を実行します。対象のアカウントとリージョンで既に実行されている場合は、実行する必要はありません。

```bash
$ cdk bootstrap

⏳  Bootstrapping environment aws://XXXXXXXXXXXX/ap-northeast-1...
Trusted accounts for deployment: (none)
Trusted accounts for lookup: (none)
Using default execution policy of 'arn:aws:iam::aws:policy/AdministratorAccess'. Pass '--cloudformation-execution-policies' to customize.
CDKToolkit: creating CloudFormation changeset...
 ✅  Environment aws://XXXXXXXXXXXX/ap-northeast-1 bootstrapped.
```

### CDK の実装に含まれるスタックについて

- _GreengrassFleetprovisioningResourceStack_
  - FleetProvisioning に必要なクラウドリソース（ProvisioningTemplate や IoTPolicy など）を作成します。
  - FleetProvisioning を使用してインストールを実行する GreegrassInstaller を作成します。
- _GreengrassPrivateNetworkStack_
  - 閉域ネットワーク環境で Greengrass を利用するためのリソース（PrivateLink など）を作成します。

## 環境のデプロイ

すべてのスタックをデプロイするには、以下のコマンドを実行します。

```bash
cdk deploy --require-approval never --all
```

もしくは、各スタックを個別にデプロイするには、以下のコマンドを実行します。

```bash
cdk deploy <StackName>
```

- スタック間には依存関係が設定されているので、デプロイされるスタックに依存するスタックも必要に応じてデプロイされます。

CloudShell にインストールされている CDK のバージョンと一致せずエラーが出る場合は、以下のコマンドで aws-cdk をプロジェクトローカル配下にインストールし、`npx`コマンドで`cdk`コマンドを実行することで解消できます。

```bash
npm install aws-cdk
npx cdk deploy --require-approval never --all
```

コマンドを実行すると、クラウド上に作成されるリソースが解決され、環境の作成が開始されます。
環境が作成されると、以下のメッセージが表示されます。環境の作成には数分かかります。

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

以上で環境の配備は完了です。

`GreengrassFleetprovisioningResourceStack` 実行時の Outputs にある `GreengrassInstallerGreengrassInstallerPathXXXXXXXX` はインストーラが格納されているバケットで、 `GreengrassInstallerZipPasswordSecretArnXXXXXXXX` はインストーラを解凍するためのパスワードを持つシークレットマネージャの秘密情報の ARN となります。

[CloudFormation コンソール](https://console.aws.amazon.com/cloudformation/home)の各スタックの詳細で確認できます。

### 環境の削除

環境を削除するには、CDK `destroy` コマンドを実行します。

> [!NOTE]
>
> `GreengrassFleetprovisioningResourceStack` の削除には、インストーラを使ってインストールした 全ての Greengrass デバイスからデバイスに割り当てられた証明書に紐けられているポリシー(ポリシー名は `GreengrassFleetprovisioningResourceStack` の `GreengrassThingPolicyName` を参照) を事前にデタッチする必要があります。

```bash
cdk destroy --all
```

以下のコマンドを使用して、各スタックを個別に削除することもできます。

```bash
cdk destroy <StackName>
```

注意: 作成した環境に Greengrass デバイスがプロビジョニングされている場合、CDK で作成された Policy などのリソースに紐づいているため、スタックの削除に失敗します。この場合、CloudFormation を使って環境を強制的に削除するか、紐付けられているデバイスの定義を削除してください。デバイスの削除とアンインストールについては以下を参照してください。
https://docs.aws.amazon.com/greengrass/v2/developerguide/uninstall-greengrass-core-v2.html

## インストーラーの使用方法

CDK の実行の結果、専用のインストーラーが作成され、ZIP 圧縮されたものが S3 に出力されます。この ZIP ファイルはパスワード付きで圧縮され、シークレットマネージャーにパスワードが保存されます。

Zip を解凍すると、フォルダ内にインストールシェル install.sh（Linux 用）と install.ps1（Windows 用）があります。
(これらの実行ファイルは、インストーラーのあるディレクトリで実行されることを意図しています)

> [!NOTE]
>
> インストールには事前にデバイス環境がセットアップされており、AWS 認証情報が設定されている必要があります。詳細は下記 URL をご覧ください。
>
> https://docs.aws.amazon.com/ja_jp/greengrass/v2/developerguide/quick-installation.html

```bash
chmod +x install.sh
install.sh <ThingName> [ThingGroupName]
```

インストーラーコマンドは 2 つの引数を取り、1 つ目は 作成するモノの名前、2 つ目は モノが属するモノのグループ名です。

モノのグループ名はオプションの引数で、指定しない場合は config.ts で指定されたデフォルトのグループに属するようになります。

```bash
install.sh MyGreengrassDevice
```

あるいは、以下のように任意のモノのグループ名を指定することもできます。

```bash
install.sh MyGreengrassDevice MyGreengrassGroup
```

> [!NOTE]
> 任意のモノのグループを指定する場合は、あらかじめグループを作成しておく必要があります。

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This library is licensed under the MIT-0 License. See the [LICENSE](./LICENSE) file.
