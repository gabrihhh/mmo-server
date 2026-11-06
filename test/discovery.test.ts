import assert from "assert";
import { createSocket, type Socket } from "node:dgram";

import { DISCOVERY_REQUEST, discoveryReply, startDiscovery } from "../src/net/discovery.js";

describe("descoberta na rede local", () => {
  it("responde só à pergunta certa, com a porta do jogo", () => {
    assert.deepStrictEqual(JSON.parse(discoveryReply(Buffer.from(DISCOVERY_REQUEST), 2567) ?? "null"), { game: "mmo", version: 1, port: 2567 });
    assert.ok(discoveryReply(Buffer.from(`${DISCOVERY_REQUEST}\n`), 2567) !== null);
    assert.strictEqual(discoveryReply(Buffer.from("MMO_DISCOVER 2"), 2567), null);
    assert.strictEqual(discoveryReply(Buffer.from("oi"), 2567), null);
    assert.strictEqual(discoveryReply(Buffer.alloc(500, 65), 2567), null);
  });

  it("responde por UDP para quem perguntou", async () => {
    const server: Socket = await startDiscovery(4321, 0);
    const port: number = server.address().port;
    const client: Socket = createSocket("udp4");
    const reply: string = await new Promise((resolve) => {
      client.on("message", (message: Buffer) => resolve(message.toString("utf8")));
      client.send(DISCOVERY_REQUEST, port, "127.0.0.1");
    });
    client.close();
    server.close();
    assert.deepStrictEqual(JSON.parse(reply), { game: "mmo", version: 1, port: 4321 });
  });
});
