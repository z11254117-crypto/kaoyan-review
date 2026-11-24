#!/usr/bin/env bash
# 手动构建 APK：aapt2 + javac + d8 + zipalign + apksigner（不依赖 Gradle / AGP）
set -eo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ANDROID_DIR="$ROOT/android"
WORK="$ROOT/.build-android"
DIST="$ROOT/dist"
APP_NAME="kaoyan-review"
VERSION_NAME="1.0.1"
VERSION_CODE="2"
MIN_SDK="26"
TARGET_SDK="34"
KS_PASS="kaoyanreview"

SDK="/usr/local/lib/android/sdk"
if [ -n "$ANDROID_SDK_ROOT" ]; then SDK="$ANDROID_SDK_ROOT"; fi
if [ -n "$ANDROID_HOME" ]; then SDK="$ANDROID_HOME"; fi

if [ ! -d "$SDK/build-tools" ] || [ ! -d "$SDK/platforms" ]; then
  echo "== 安装 Android SDK 组件 =="
  mkdir -p "$SDK/cmdline-tools"
  curl -fsSL -o /tmp/cmdline-tools.zip "https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"
  unzip -q /tmp/cmdline-tools.zip -d /tmp/cmdline-tools
  rm -rf "$SDK/cmdline-tools/latest"
  mv /tmp/cmdline-tools/cmdline-tools "$SDK/cmdline-tools/latest"
  yes | "$SDK/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$SDK" --licenses > /dev/null || true
  "$SDK/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$SDK" "platforms;android-$TARGET_SDK" "build-tools;34.0.0"
fi

BT_VERSION="$(ls -1 "$SDK/build-tools" | sort -V | tail -1)"
BT_DIR="$SDK/build-tools/$BT_VERSION"
PLATFORM_JAR="$SDK/platforms/android-$TARGET_SDK/android.jar"
if [ ! -f "$PLATFORM_JAR" ]; then
  PLATFORM_JAR="$SDK/platforms/$(ls -1 "$SDK/platforms" | sort -V | tail -1)/android.jar"
fi
echo "SDK: $SDK | build-tools: $BT_VERSION | android.jar: $PLATFORM_JAR"

echo "== 打包网页资源 =="
node "$ROOT/tools/build-android-assets.mjs"

echo "== 编译资源 =="
rm -rf "$WORK" "$DIST"
mkdir -p "$WORK/res-compiled" "$WORK/classes" "$WORK/dex" "$DIST"
"$BT_DIR/aapt2" compile --dir "$ANDROID_DIR/res" -o "$WORK/res-compiled/res.zip"

echo "== 链接 =="
"$BT_DIR/aapt2" link \
  -o "$WORK/base.apk" \
  -I "$PLATFORM_JAR" \
  --manifest "$ANDROID_DIR/AndroidManifest.xml" \
  -A "$ANDROID_DIR/assets" \
  --min-sdk-version "$MIN_SDK" \
  --target-sdk-version "$TARGET_SDK" \
  --version-code "$VERSION_CODE" \
  --version-name "$VERSION_NAME" \
  "$WORK/res-compiled/res.zip"

echo "== 编译 Java =="
javac --release 11 -encoding UTF-8 -classpath "$PLATFORM_JAR" -d "$WORK/classes" $(find "$ANDROID_DIR/src" -name '*.java')

echo "== dex =="
"$BT_DIR/d8" --release --min-api "$MIN_SDK" --lib "$PLATFORM_JAR" --output "$WORK/dex" $(find "$WORK/classes" -name '*.class')

echo "== 合并 classes.dex =="
python3 - "$WORK/base.apk" "$WORK/dex/classes.dex" <<'PY'
import sys, zipfile
apk, dex = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(apk, "a", zipfile.ZIP_DEFLATED) as z:
    z.write(dex, "classes.dex")
print("dex merged ->", apk)
PY

echo "== 对齐 + 签名 =="
"$BT_DIR/zipalign" -f 4 "$WORK/base.apk" "$WORK/aligned.apk"
keytool -genkeypair -keystore "$WORK/kaoyan.keystore" -storepass "$KS_PASS" -keypass "$KS_PASS" \
  -alias kaoyan -keyalg RSA -keysize 2048 -validity 10000 \
  -dname "CN=Kaoyan Review,O=Personal,C=CN" > /dev/null 2>&1
"$BT_DIR/apksigner" sign --ks "$WORK/kaoyan.keystore" --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" \
  --out "$DIST/$APP_NAME.apk" "$WORK/aligned.apk"
"$BT_DIR/apksigner" verify --print-certs "$DIST/$APP_NAME.apk"
ls -lh "$DIST"
