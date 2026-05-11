# Shumi Offerings — Build Instructions

## Project Structure

Place all files like this:

```
shumi-offerings/
├── App.js                  ← your existing file (no changes needed)
├── app.json
├── package.json
├── eas.json
├── babel.config.js
├── .gitignore
└── assets/
    ├── icon.png            ← 1024×1024 px app icon
    ├── adaptive-icon.png   ← 1024×1024 px (Android adaptive icon foreground)
    └── splash.png          ← 1284×2778 px splash screen (or any 9:19 ratio)
```

---

## One-time Setup

### 1. Install Node.js & Expo CLI
```bash
npm install -g expo-cli eas-cli
```

### 2. Create a free Expo account
https://expo.dev/signup

### 3. Log in
```bash
eas login
```

### 4. Install dependencies
```bash
cd shumi-offerings
npm install
```

### 5. Link EAS to this project (run once)
```bash
eas build:configure
```
When prompted, choose **Android**.

---

## Build the APK

```bash
npm run build:apk
# or directly:
eas build --platform android --profile preview
```

- EAS builds in the cloud — no Android SDK needed on your machine.
- When the build finishes (~5–10 min), you'll get a **download link** for the `.apk`.
- Transfer it to any Android device, enable **"Install from unknown sources"**, and install.

---

## Production AAB (for Google Play Store)

```bash
npm run build:aab
# or:
eas build --platform android --profile production
```

This produces an `.aab` (Android App Bundle) for Play Store submission.

---

## Run locally (for testing)

```bash
npx expo start
```

Scan the QR code with the **Expo Go** app on your Android device.

---

## Notes

- **App icon & splash**: Add your own images to `assets/`. Expo will resize automatically.
  Minimum: a 1024×1024 `icon.png` is enough to get started.
- **Package name**: Currently `com.shumi.offerings` — change in `app.json` if needed.
  Once published to Play Store, the package name **cannot be changed**.
- **Version bumps**: Increment `version` (e.g. `"1.0.1"`) and `versionCode` (e.g. `2`)
  in `app.json` before each new build.
