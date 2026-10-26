import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";

test("concurrent Yjs text edits converge and survive a persisted state snapshot", () => {
  const owner = new Y.Doc();
  owner.getText("content").insert(0, "Texte partagé");
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(owner));

  const ownerUpdates: Uint8Array[] = [];
  const peerUpdates: Uint8Array[] = [];
  owner.on("update", (update: Uint8Array) => ownerUpdates.push(update));
  peer.on("update", (update: Uint8Array) => peerUpdates.push(update));

  owner.getText("content").insert(0, "A ");
  peer.getText("content").insert(0, "B ");
  for (const update of ownerUpdates) Y.applyUpdate(peer, update);
  for (const update of peerUpdates) Y.applyUpdate(owner, update);
  assert.equal(owner.getText("content").toString(), peer.getText("content").toString());

  const durableState = Y.encodeStateAsUpdate(owner);
  const recovered = new Y.Doc();
  Y.applyUpdate(recovered, durableState);
  assert.equal(recovered.getText("content").toString(), owner.getText("content").toString());
  for (const update of ownerUpdates) Y.applyUpdate(recovered, update);
  assert.equal(recovered.getText("content").toString(), owner.getText("content").toString());
});

test("reconnecting peers exchange only the Yjs state missing on each side", () => {
  const server = new Y.Doc();
  server.getText("content").insert(0, "Initial");
  const client = new Y.Doc();
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
  client.getText("content").insert(7, " local");
  server.getText("content").insert(0, "remote ");

  const clientState = Y.encodeStateVector(client);
  const serverState = Y.encodeStateVector(server);
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server, clientState));
  Y.applyUpdate(server, Y.encodeStateAsUpdate(client, serverState));
  assert.equal(client.getText("content").toString(), server.getText("content").toString());
});
