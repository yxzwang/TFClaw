# Token-Free-Claw (TFClaw)
该项目旨在使用类似openclaw的方式操纵各个平台上的terminal。让用户可以在手机上也能和自己电脑，服务器端的terminal进行对话。本项目本质上是terminal端的远程桌面。

# 实现功能
本项目包含服务器端，terminal端以及手机端三个组件。

## 服务器端

服务器端通过数据库存储用户数据。前期暂不支持用户注册，数据保存在terminal端本地。当后期注册后数据保存于服务器端

### 用户注册 

暂定

### 未注册方案

数据保留在terminal端本地，可自选路径存储。服务器端使用auth token作为用户identity方案连接terminal端与手机端

### 功能

仅作为数据中转站。

1. 将terminal端的对话内容实时转发给用户。
2. 存储用户使用本产品打开的terminal数量，以及各个terminal目前的界面。

## terminal 端功能

1. 支持新建一个新的terminal，关闭当前terminal
2. 在windows和mac这类存在gui的平台上可以选择屏幕或者窗口进行截图并发送给服务器端再转发给用户。linux端将terminal显示界面渲染出来发送给用户。


## 手机端功能

1. 用户可以查看目前存在多少terminal以及他们所在的平台，以及各个terminal目前的内容
2. 在存在terminal端的平台上，用户可以选择截图查看窗口或者屏幕，或者查看terminal端内容，可以使用滚动条
3. 用户可以通过手机指令新建terminal或者关闭terminal
4. 用户可以通过选择特定terminal后，通过特定命令（例如terminal: message）将message直接输入到terminal端并执行（***主要功能，重要。接受快捷键输入，例如ctrl+d），执行后terminal端返回结果将一并返回给用户。



### 交互方式

1. 完成手机端app，可以先完成安卓端app，写apk文件方便测试。
手机端功能参考chatgpt手机端，每个对话窗口代表一个平台，平台内可以选择该平台上存在的terminal窗口进行对话



2. 飞书机器人。参考nanobot连接飞书的方法如下所示：
<details>
<summary><b>Feishu (飞书)</b></summary>

Uses **WebSocket** long connection — no public IP required.

**1. Create a Feishu bot**
- Visit [Feishu Open Platform](https://open.feishu.cn/app)
- Create a new app → Enable **Bot** capability
- **Permissions**: Add `im:message` (send messages)
- **Events**: Add `im.message.receive_v1` (receive messages)
  - Select **Long Connection** mode (requires running nanobot first to establish connection)
- Get **App ID** and **App Secret** from "Credentials & Basic Info"
- Publish the app

**2. Configure**

```json
{
  "channels": {
    "feishu": {
      "enabled": true,
      "appId": "cli_xxx",
      "appSecret": "xxx",
      "encryptKey": "",
      "verificationToken": "",
      "allowFrom": []
    }
  }
}
```

> `encryptKey` and `verificationToken` are optional for Long Connection mode.
> `allowFrom`: Leave empty to allow all users, or add `["ou_xxx"]` to restrict access.

**3. Run**

```bash
nanobot gateway
```

> [!TIP]
> Feishu uses WebSocket to receive messages — no webhook or public IP needed!

</details>