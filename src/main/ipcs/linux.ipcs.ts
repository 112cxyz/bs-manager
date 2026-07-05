import { LinuxService } from "main/services/linux.service";
import { MacOSService } from "main/services/macos.service";
import { IpcService } from "../services/ipc.service";
import { of } from "rxjs";

const ipc = IpcService.getInstance();

ipc.on("linux.verify-proton-folder", (_, reply) => {
    const linuxService = LinuxService.getInstance();
    reply(of(linuxService.verifyProtonPath()));
});

ipc.on("linux.get-wine-prefix-path", (_, reply) => {
    if (process.platform === "darwin") {
        reply(of(MacOSService.getInstance().getWinePrefixPath()));
        return;
    }
    const linuxService = LinuxService.getInstance();
    reply(of(linuxService.getWinePrefixPath()));
});

