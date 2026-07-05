const { execSync } = require("child_process");
const path = require("path");
const {  fuseElectron } = require("./fuse-electron")

exports.afterPack = async function afterPack(context) {
    await fuseElectron(context);

    // Fusing invalidates the mac signature, and arm64 macOS kills fully
    // unsigned binaries. Without a Developer ID identity electron-builder
    // skips signing entirely, so ad-hoc sign here as a fallback.
    // (When a real identity is configured, electron-builder re-signs after
    // afterPack and overrides this.)
    if (context.electronPlatformName === "darwin") {
        const appName = `${context.packager.appInfo.productFilename}.app`;
        const appPath = path.join(context.appOutDir, appName);
        execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: "inherit" });
    }
}
