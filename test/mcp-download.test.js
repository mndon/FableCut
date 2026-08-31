"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { addressAllowed } = require("../mcp/download");

test("download address guard rejects private and reserved networks", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.1.1", "::1", "fd00::1"])
    assert.equal(addressAllowed(address), false, address);
  assert.equal(addressAllowed("8.8.8.8"), true);
  assert.equal(addressAllowed("2606:4700:4700::1111"), true);
});
