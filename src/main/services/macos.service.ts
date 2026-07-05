import fs from "fs-extra";
import log from "electron-log";
import os from "os";
import path from "path";
import { StaticConfigurationService } from "./static-configuration.service";

/**
 * macOS support is built around MoltenVR (https://github.com/...), which runs the
 * Windows build of Beat Saber inside a Wine bottle and provides the OpenXR runtime.
 * This service is the macOS analogue of LinuxService: it resolves the Wine binary
 * and WINEPREFIX (the MoltenVR bottle) and builds the launch environment.
 */
export class MacOSService {
    private static instance: MacOSService;

    public static getInstance(): MacOSService {
        if (!MacOSService.instance) {
            MacOSService.instance = new MacOSService();
        }
        return MacOSService.instance;
    }

    // Marker file written by MoltenVR at the prefix root, contains the absolute
    // path of the wine binary the bottle was created with.
    private readonly WINE_MARKER_FILE = ".moltenvr_wine";

    private readonly MOLTENVR_SUPPORT_DIR = path.join(os.homedir(), "Library", "Application Support", "MoltenVR");
    private readonly DEFAULT_BOTTLES_DIR = path.join(this.MOLTENVR_SUPPORT_DIR, "Bottles");
    // Wine build managed by MoltenVR (WhiskyWine), used as fallback when a bottle has no marker file.
    private readonly MANAGED_WINE_PATHS = [
        path.join(this.MOLTENVR_SUPPORT_DIR, "wine", "Libraries", "Wine", "bin", "wine64"),
        path.join(os.homedir(), "Library", "Application Support", "com.franke.Whisky", "Libraries", "Wine", "bin", "wine"),
    ];

    private readonly staticConfig: StaticConfigurationService;

    private constructor() {
        this.staticConfig = StaticConfigurationService.getInstance();
    }

    // === Bottle (WINEPREFIX) === //

    public getBottlePath(): string {
        if (this.staticConfig.has("moltenvr-bottle")) {
            const configured = this.staticConfig.get("moltenvr-bottle");
            if (fs.pathExistsSync(path.join(configured, "drive_c"))) {
                return configured;
            }
            log.warn(`Configured MoltenVR bottle "${configured}" is not a valid wine prefix, falling back to default`);
        }

        // Default bottle, then any other bottle managed by MoltenVR
        const defaultBottle = path.join(this.DEFAULT_BOTTLES_DIR, "MoltenVR");
        if (fs.pathExistsSync(path.join(defaultBottle, "drive_c"))) {
            return defaultBottle;
        }

        if (fs.pathExistsSync(this.DEFAULT_BOTTLES_DIR)) {
            const bottles = fs.readdirSync(this.DEFAULT_BOTTLES_DIR)
                .map(name => path.join(this.DEFAULT_BOTTLES_DIR, name))
                .filter(bottle => fs.pathExistsSync(path.join(bottle, "drive_c")));
            if (bottles.length > 0) {
                return bottles[0];
            }
        }

        return null;
    }

    public verifyBottlePath(bottlePath: string): boolean {
        return fs.pathExistsSync(path.join(bottlePath, "drive_c"));
    }

    public getWinePrefixPath(): string {
        return this.getBottlePath();
    }

    // === Wine binary === //

    public getWinePath(): string {
        const bottle = this.getBottlePath();

        // The bottle is bound to the wine build that created it (see MoltenVR),
        // so prefer the marker file over any other wine on the system.
        if (bottle) {
            const marker = path.join(bottle, this.WINE_MARKER_FILE);
            if (fs.pathExistsSync(marker)) {
                const winePath = fs.readFileSync(marker, { encoding: "utf-8" }).trim();
                if (winePath && fs.pathExistsSync(winePath)) {
                    return winePath;
                }
                log.warn(`Wine binary "${winePath}" from ${marker} not found, falling back to managed wine`);
            }
        }

        for (const winePath of this.MANAGED_WINE_PATHS) {
            if (fs.pathExistsSync(winePath)) {
                return winePath;
            }
        }

        throw new Error("Could not locate a MoltenVR wine binary. Is MoltenVR installed?");
    }

    // Analogue of LinuxService.getProtonPrefix(): prepended to the exe path to build the launch command.
    public getWineLaunchPrefix(): string {
        return `"${this.getWinePath()}"`;
    }

    // === Paths === //

    /**
     * Converts a Windows path from inside the bottle (e.g. "C:\\Program Files (x86)\\Steam")
     * to its macOS location. Steam's vdf files contain Windows paths since Steam runs under Wine.
     */
    public winePathToPosix(windowsPath: string): string {
        if (!windowsPath) {
            return windowsPath;
        }

        // Already a posix path
        if (windowsPath.startsWith("/")) {
            return windowsPath;
        }

        const bottle = this.getBottlePath();
        if (!bottle) {
            return windowsPath;
        }

        const match = /^([a-zA-Z]):[\\/](.*)$/.exec(windowsPath);
        if (!match) {
            return windowsPath;
        }

        const [, driveLetter, rest] = match;
        const relative = rest.split(/[\\/]/).join(path.sep);

        if (driveLetter.toLowerCase() === "c") {
            return path.join(bottle, "drive_c", relative);
        }

        // Other drive letters are symlinks in dosdevices
        return path.join(bottle, "dosdevices", `${driveLetter.toLowerCase()}:`, relative);
    }

    /**
     * The wine user's home directory inside the bottle (drive_c/users/<user>).
     * BSManager's installation folder defaults there so that game instances are
     * reachable from inside wine as C:\users\<user>\BSManager and are picked up
     * by MoltenVR's own game scanner.
     */
    public getWineUserDir(): string {
        const bottle = this.getBottlePath();
        if (!bottle) {
            return null;
        }

        const usersDir = path.join(bottle, "drive_c", "users");
        const macUserDir = path.join(usersDir, os.userInfo().username);
        if (fs.pathExistsSync(macUserDir)) {
            return macUserDir;
        }

        if (!fs.pathExistsSync(usersDir)) {
            return null;
        }

        const candidates = fs.readdirSync(usersDir).filter(name => name !== "Public");
        return candidates.length > 0 ? path.join(usersDir, candidates[0]) : null;
    }

    public getSteamPath(): string {
        const bottle = this.getBottlePath();
        if (!bottle) {
            return null;
        }
        return path.join(bottle, "drive_c", "Program Files (x86)", "Steam");
    }

    /**
     * Converts a macOS path to its Windows form inside the bottle. Needed for
     * arguments passed to Windows programs (e.g. IPA.exe): wine resolves unix
     * paths for the executable it launches, but a Windows program receiving a
     * unix path treats it as rooted on the current drive and resolves it to a
     * nonexistent C:\ location.
     */
    public posixPathToWine(posixPath: string): string {
        const bottle = this.getBottlePath();
        if (bottle) {
            const driveC = path.join(bottle, "drive_c");
            if (posixPath.startsWith(driveC + path.sep)) {
                return `C:\\${posixPath.substring(driveC.length + 1).split(path.sep).join("\\")}`;
            }
        }
        // Paths outside the bottle go through the Z: drive (mapped to /)
        return `Z:${posixPath.split("/").join("\\")}`;
    }

    // === Launching === //

    /**
     * Wine launch environment, mirroring MoltenVR's own launch env (Launch.swift / GamePatcher.swift):
     * - WINEESYNC must be exported on every launch (the wineserver takes its sync mode from the first process)
     * - d3d11/dxgi/d3d10core native so the game loads DXMT (Metal translation)
     * - winhttp=n,b so BSIPA's proxy winhttp.dll injects for modded Beat Saber
     */
    public buildEnvVariables(): Record<string, string> {
        const bottle = this.getBottlePath();
        if (!bottle) {
            throw new Error("No MoltenVR wine bottle found. Is MoltenVR installed?");
        }

        return {
            WINEPREFIX: bottle,
            WINEDEBUG: "-all",
            WINEESYNC: "1",
            WINEDLLOVERRIDES: "d3d11=n;dxgi=n;d3d10core=n;winhttp=n,b",
            SteamEnv: "1",
            MTL_DEBUG_LAYER: "0",
            MTL_SHADER_VALIDATION: "0",
        };
    }

    // === Steam under Wine === //

    /**
     * Reads Steam's active user id from the bottle's registry file (user.reg).
     * Replaces the regedit-rs registry lookup used on Windows.
     */
    public getSteamActiveUser(): number {
        const bottle = this.getBottlePath();
        if (!bottle) {
            return 0;
        }

        const userReg = path.join(bottle, "user.reg");
        if (!fs.pathExistsSync(userReg)) {
            return 0;
        }

        const content = fs.readFileSync(userReg, { encoding: "utf-8" });
        const sectionMatch = /\[Software\\\\Valve\\\\Steam\\\\ActiveProcess\][^[]*/.exec(content);
        if (!sectionMatch) {
            return 0;
        }

        const valueMatch = /"ActiveUser"=dword:([0-9a-fA-F]{8})/.exec(sectionMatch[0]);
        if (!valueMatch) {
            return 0;
        }

        return parseInt(valueMatch[1], 16);
    }
}
