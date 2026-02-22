# @tfclaw/mobile

Android-first React Native app (Expo) for TFClaw.

## Env

Create `.env` from `.env.example`:

```bash
EXPO_PUBLIC_TFCLAW_RELAY_URL=ws://10.0.2.2:8787
EXPO_PUBLIC_TFCLAW_TOKEN=demo-token
```

## Run

```bash
npm run start --workspace @tfclaw/mobile
```

## Android debug run

```bash
npm run android --workspace @tfclaw/mobile
```

## Build APK (EAS)

```bash
npm i -g eas-cli
cd apps/mobile
eas login
eas build:configure
eas build -p android --profile preview
```

After build finishes, download APK from EAS build page.
