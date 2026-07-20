import { createServer } from "node:http";
import * as path from "node:path";
import { createRegistryApp } from "@xregistry/registry-core";
import model from "../../model.json";
import { CAPABILITIES } from "../../src/config/constants";

const { assertCapabilitiesConform } = require(
    path.join(__dirname, "../../../test/helpers/xregistry-capability-conformance.cjs"),
);

describe("RubyGems xRegistry model contract", () => {
    it("uses built-in Resource versions rather than nested resources", () => {
        const packages = model.groups.rubyregistries.resources.packages as Record<string, unknown>;
        expect(packages["maxversions"]).toBe(0);
        expect(packages["setversionid"]).toBe(true);
        expect(packages["versionmode"]).toBe("createdat");
        expect(packages).not.toHaveProperty("resources");
        expect(packages).not.toHaveProperty("versions");
    });

    it("serves schema-valid capabilities and exact model keys at runtime", async () => {
        const app = createRegistryApp({ model, capabilities: CAPABILITIES });
        const server = createServer(app);
        await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
        try {
            const address = server.address();
            expect(address && typeof address !== "string").toBe(true);
            if (!address || typeof address === "string") throw new Error("No server address");
            const base = `http://127.0.0.1:${address.port}`;
            const capabilities = await (await fetch(`${base}/capabilities`)).json();
            assertCapabilitiesConform(capabilities, {
                flags: ["filter"],
                versionmodes: ["manual", "createdat"],
            });
            const source = await (await fetch(`${base}/modelsource`)).json() as Record<string, unknown>;
            const full = await (await fetch(`${base}/model`)).json() as Record<string, unknown>;
            expect(Object.keys(source).sort()).toEqual(Object.keys(model).sort());
            expect(source).not.toHaveProperty("default");
            expect(full).not.toHaveProperty("default");
        } finally {
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });
});
